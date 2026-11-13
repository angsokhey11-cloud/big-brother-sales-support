-- BIG BROTHER Sales Support: add missing GPS to existing customers, 13-Nov-2026.
-- Requires Add Customer create permission and assignment to the customer's location.
-- Does not create duplicate customers or modify prices, credit balances, or invoice data.
-- Re-runnable migration: keep Cloud and Local Brain behavior aligned.

CREATE OR REPLACE FUNCTION public.bb_sales_support_customer_location_target(p_customer_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v_customer jsonb;
begin
  if not public.bb_is_active_user()
     or not public.bb_has_module_access('route.sales-support-add-customer','create') then
    raise exception 'Add Customer create permission is required';
  end if;
  select jsonb_build_object(
    'customerId', c.customer_id,
    'name', coalesce(c.customer_name,''),
    'phone', coalesce(c.phone,''),
    'address', coalesce(c.address,''),
    'locationCode', coalesce(c.location_code,''),
    'deliveryLocationNote', coalesce(c.delivery_location_note,''),
    'googleMapsLink', coalesce(c.google_maps_link,''),
    'latitude', c.latitude,
    'longitude', c.longitude,
    'hasSavedLocation', (c.latitude is not null and c.longitude is not null) or nullif(trim(coalesce(c.google_maps_link,'')),'') is not null
  ) into v_customer
  from public.customers c
  where c.customer_id=trim(coalesce(p_customer_id,''))
    and coalesce(c.active,true)=true
    and public.bb_has_location_access(c.location_code);
  if v_customer is null then
    raise exception 'Customer not found in your assigned sales locations';
  end if;
  return jsonb_build_object('success',true,'customer',v_customer);
end;
$function$;

CREATE OR REPLACE FUNCTION public.bb_sales_support_update_customer_location(p_payload jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_id text := trim(coalesce(p_payload->>'customerId',''));
  v_lat numeric;
  v_lng numeric;
  v_accuracy numeric;
  v_note text;
  v_phone text;
  v_address text;
  v_location text;
  v_customer jsonb;
begin
  if not public.bb_is_active_user()
     or not public.bb_has_module_access('route.sales-support-add-customer','create') then
    raise exception 'Add Customer create permission is required';
  end if;
  if v_id='' then raise exception 'Existing Customer ID is required'; end if;
  if nullif(trim(coalesce(p_payload->>'latitude','')),'') is null
     or nullif(trim(coalesce(p_payload->>'longitude','')),'') is null then
    raise exception 'Sync device GPS before saving the customer location';
  end if;
  v_lat := (p_payload->>'latitude')::numeric;
  v_lng := (p_payload->>'longitude')::numeric;
  if v_lat < -90 or v_lat > 90 or v_lng < -180 or v_lng > 180 then
    raise exception 'GPS coordinates are outside the valid range';
  end if;
  if nullif(trim(coalesce(p_payload->>'gpsAccuracyMeters','')),'') is not null then
    v_accuracy := (p_payload->>'gpsAccuracyMeters')::numeric;
    if v_accuracy <= 0 or v_accuracy > 50 then
      raise exception 'GPS accuracy must be within 50 meters. Sync location again';
    end if;
  end if;
  if p_payload ? 'deliveryLocationNote' then
    v_note := left(coalesce(p_payload->>'deliveryLocationNote',''),2000);
  end if;
  if p_payload ? 'phone' then
    v_phone := trim(coalesce(p_payload->>'phone',''));
    if length(v_phone)>120 then raise exception 'Phone cannot exceed 120 characters'; end if;
  end if;
  if p_payload ? 'address' then
    v_address := trim(coalesce(p_payload->>'address',''));
    if length(v_address)>2000 then raise exception 'Address cannot exceed 2000 characters'; end if;
  end if;
  select c.location_code into v_location
  from public.customers c
  where c.customer_id=v_id and coalesce(c.active,true)=true
  for update;
  if v_location is null then
    raise exception 'Customer was not found or is inactive';
  end if;
  if not public.bb_has_location_access(v_location) then
    raise exception 'Customer is outside your assigned sales location';
  end if;

  update public.customers c
     set phone=case when p_payload ? 'phone' then nullif(v_phone,'') else c.phone end,
         address=case when p_payload ? 'address' then nullif(v_address,'') else c.address end,
         latitude=v_lat,
         longitude=v_lng,
         google_maps_link='https://www.google.com/maps?q='||v_lat::text||','||v_lng::text,
         delivery_location_note=case when p_payload ? 'deliveryLocationNote'
                                    then nullif(trim(v_note),'') else c.delivery_location_note end,
         updated_at=now()
   where c.customer_id=v_id
     and (c.latitude is null or c.longitude is null)
     and nullif(trim(coalesce(c.google_maps_link,'')),'') is null
   returning jsonb_build_object(
     'customerId',c.customer_id,
     'name',coalesce(c.customer_name,''),
     'phone',coalesce(c.phone,''),
     'address',coalesce(c.address,''),
     'locationCode',coalesce(c.location_code,''),
     'googleMapsLink',coalesce(c.google_maps_link,''),
     'latitude',c.latitude,
     'longitude',c.longitude,
     'deliveryLocationNote',coalesce(c.delivery_location_note,'')
   ) into v_customer;
  if v_customer is null then
    raise exception 'This customer already has a saved map location. Refresh Your Customer';
  end if;
  return jsonb_build_object('success',true,'customer',v_customer,'updated',true);
end;
$function$;

REVOKE ALL ON FUNCTION public.bb_sales_support_customer_location_target(text) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.bb_sales_support_update_customer_location(jsonb) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.bb_sales_support_customer_location_target(text) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bb_sales_support_update_customer_location(jsonb) TO authenticated;
