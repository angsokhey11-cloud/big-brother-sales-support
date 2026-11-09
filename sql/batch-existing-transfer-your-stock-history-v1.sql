-- BIG BROTHER | Your Stock: display existing-open-batch carry-forward as Adjustment IN/OUT
-- Read only. Ledger-sourced; no stock balances, invoices, COGS or batch assignments are modified.
-- This classifies the "Batch carry forward ..." entries created by the new
-- Existing Open Batch -> Existing Open Batch real stock Key-In function.
CREATE OR REPLACE FUNCTION public.bb_sales_support_batch_carryforward_totals(p_batch_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
  v_batch_id text := trim(coalesce(p_batch_id,''));
  v_staff_id text;
  v_items jsonb := '[]'::jsonb;
  v_history jsonb := '[]'::jsonb;
BEGIN
  IF NOT public.bb_is_active_user() OR (
      NOT public.bb_is_admin()
      AND NOT public.bb_has_module_access('route.sales-support-your-stock','view')
  ) THEN RAISE EXCEPTION 'Your Stock access denied'; END IF;
  SELECT staff_id INTO v_staff_id FROM public.app_users WHERE user_id=auth.uid() AND active=true;
  IF v_batch_id='' OR NOT EXISTS(
    SELECT 1 FROM public.stock_batches b
    WHERE b.batch_id=v_batch_id
      AND (public.bb_is_admin() OR (v_staff_id IS NOT NULL AND b.salesman_staff_id=v_staff_id))
  ) THEN RAISE EXCEPTION 'This batch is not assigned to your stock'; END IF;

  -- Current batch's transfers in or transfers out; one stock_activity row
  -- per Purchased/Zero-Cost source. The original movement stays unmodified.
  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'productCode',v.product_code,
    'transferInQty',round(v.transfer_in_qty,6),
    'transferOutQty',round(v.transfer_out_qty,6),
    'purchasedTransferInQty',round(v.purchased_in_qty,6),
    'zeroCostTransferInQty',round(v.zero_in_qty,6),
    'purchasedTransferOutQty',round(v.purchased_out_qty,6),
    'zeroCostTransferOutQty',round(v.zero_out_qty,6),
    'lastTransferAt',v.last_transfer_at,
    'assignedQty',round(coalesce(i.issued_qty,0),6),
    'soldQty',round(coalesce(i.sold_qty_snapshot,0),6),
    'damagedQty',round(coalesce(i.damaged_qty,0),6),
    'currentQty',round(greatest(coalesce(i.pending_qty_snapshot,0),0),6),
    'productName',coalesce(p.product_name,v.product_name,v.product_code),
    'unit',coalesce(p.unit,v.unit,'')
  ) ORDER BY v.product_code),'[]'::jsonb)
  INTO v_items
  FROM (
    SELECT a.product_code,
      max(a.product_name_snapshot) product_name,max(a.unit_snapshot) unit,
      coalesce(sum(a.qty) FILTER(WHERE a.batch_id=v_batch_id),0)::numeric transfer_in_qty,
      coalesce(sum(a.qty) FILTER(WHERE a.source_id=v_batch_id AND a.batch_id<>v_batch_id),0)::numeric transfer_out_qty,
      coalesce(sum(a.qty) FILTER(WHERE a.batch_id=v_batch_id AND upper(a.from_bucket)='BATCH_PENDING'),0)::numeric purchased_in_qty,
      coalesce(sum(a.qty) FILTER(WHERE a.batch_id=v_batch_id AND upper(a.from_bucket)='BATCH_ZERO_COST'),0)::numeric zero_in_qty,
      coalesce(sum(a.qty) FILTER(WHERE a.source_id=v_batch_id AND a.batch_id<>v_batch_id AND upper(a.from_bucket)='BATCH_PENDING'),0)::numeric purchased_out_qty,
      coalesce(sum(a.qty) FILTER(WHERE a.source_id=v_batch_id AND a.batch_id<>v_batch_id AND upper(a.from_bucket)='BATCH_ZERO_COST'),0)::numeric zero_out_qty,
      max(a.created_at) last_transfer_at
    FROM public.stock_activity a
    WHERE upper(coalesce(a.movement_type,''))='BATCH_TRANSFER'
      AND upper(coalesce(a.flow,''))='TRANSFER'
      AND upper(coalesce(a.source_entity_type,''))='BATCH_TRANSFER'
      AND coalesce(a.source_name,'') LIKE 'Batch carry forward %'
      AND (a.batch_id=v_batch_id OR (a.source_id=v_batch_id AND a.batch_id<>v_batch_id))
      AND a.product_code IS NOT NULL
    GROUP BY a.product_code
  ) v
  LEFT JOIN public.stock_batch_items i ON i.batch_id=v_batch_id AND i.product_code=v.product_code
  LEFT JOIN public.products p ON p.product_code=v.product_code;

  SELECT coalesce(jsonb_agg(jsonb_build_object(
    'movementId',v.movement_id,
    'productCode',v.product_code,
    'productName',coalesce(p.product_name,v.product_name,v.product_code),
    'unit',coalesce(p.unit,v.unit,''),
    'movementType','BATCH_TRANSFER',
    'direction',v.direction,
    'adjustmentInQty',round(v.transfer_in_qty,6),
    'adjustmentOutQty',round(v.transfer_out_qty,6),
    'transferInQty',round(v.transfer_in_qty,6),
    'transferOutQty',round(v.transfer_out_qty,6),
    'purchasedQty',round(v.purchased_qty,6),
    'zeroCostQty',round(v.zero_cost_qty,6),
    'sourceBatchId',v.source_batch_id,
    'targetBatchId',v.target_batch_id,
    'sourceBatchDate',v.source_batch_date,
    'targetBatchDate',v.target_batch_date,
    'sourceSalesman',v.source_salesman,
    'targetSalesman',v.target_salesman,
    'controllerName',v.controller_name,
    'activityDate',v.activity_date,
    'createdAt',v.created_at,
    'referenceNo',v.reference_no,
    'reason',case when v.direction='IN' then
      'Batch Transfer IN · '||v.source_batch_id||' → '||v.target_batch_id
      else 'Batch Transfer OUT · '||v.source_batch_id||' → '||v.target_batch_id end
  ) ORDER BY v.created_at DESC,v.movement_id DESC,v.product_code),'[]'::jsonb)
  INTO v_history
  FROM (
    SELECT a.movement_id,a.product_code,a.source_id source_batch_id,a.batch_id target_batch_id,
      case when a.batch_id=v_batch_id then 'IN' else 'OUT' end direction,
      max(a.product_name_snapshot) product_name,max(a.unit_snapshot) unit,
      max(a.activity_date)::text activity_date,max(a.created_at) created_at,
      max(a.reference_no) reference_no,max(a.inventory_controller_name_snapshot) controller_name,
      max(sb.batch_date)::text source_batch_date,max(tb.batch_date)::text target_batch_date,
      max(sb.salesman_name_snapshot) source_salesman,max(tb.salesman_name_snapshot) target_salesman,
      coalesce(sum(a.qty) FILTER(WHERE a.batch_id=v_batch_id),0)::numeric transfer_in_qty,
      coalesce(sum(a.qty) FILTER(WHERE a.source_id=v_batch_id AND a.batch_id<>v_batch_id),0)::numeric transfer_out_qty,
      coalesce(sum(a.qty) FILTER(WHERE upper(a.from_bucket)='BATCH_PENDING'),0)::numeric purchased_qty,
      coalesce(sum(a.qty) FILTER(WHERE upper(a.from_bucket)='BATCH_ZERO_COST'),0)::numeric zero_cost_qty
    FROM public.stock_activity a
    LEFT JOIN public.stock_batches sb ON sb.batch_id=a.source_id
    LEFT JOIN public.stock_batches tb ON tb.batch_id=a.batch_id
    WHERE upper(coalesce(a.movement_type,''))='BATCH_TRANSFER'
      AND upper(coalesce(a.flow,''))='TRANSFER'
      AND upper(coalesce(a.source_entity_type,''))='BATCH_TRANSFER'
      AND coalesce(a.source_name,'') LIKE 'Batch carry forward %'
      AND (a.batch_id=v_batch_id OR (a.source_id=v_batch_id AND a.batch_id<>v_batch_id))
      AND a.product_code IS NOT NULL
    GROUP BY a.movement_id,a.product_code,a.source_id,a.batch_id
    ORDER BY max(a.created_at) DESC,a.movement_id DESC,a.product_code
    LIMIT 250
  ) v
  LEFT JOIN public.products p ON p.product_code=v.product_code;

  RETURN jsonb_build_object(
    'success',true,'version','BATCH-CARRYFORWARD-YOUR-STOCK-V1',
    'batchId',v_batch_id,'items',v_items,'history',v_history,
    'transferInQty',coalesce((SELECT sum((t->>'transferInQty')::numeric) FROM jsonb_array_elements(v_items) t),0),
    'transferOutQty',coalesce((SELECT sum((t->>'transferOutQty')::numeric) FROM jsonb_array_elements(v_items) t),0)
  );
END;
$function$;
REVOKE ALL ON FUNCTION public.bb_sales_support_batch_carryforward_totals(text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.bb_sales_support_batch_carryforward_totals(text) TO authenticated;
