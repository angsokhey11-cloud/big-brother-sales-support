/* BIG BROTHER — Sales Support Supabase Adapter V1 */
(function(){
  'use strict';

  const URL='https://sjfhlaclgmkwwofzstok.supabase.co';
  const KEY='sb_publishable_w762jR65CWwlO30fKQsYOw_6L9grx8S';
  const SESSION_KEY='BB_SUPABASE_DEV_SESSION_V1';
  const LEGACY_CACHE_KEYS=[
    'bb_sales_support_products_v1',
    'bb_sales_support_public_locations_v1',
    'bb_sales_support_customers_v1_PUBLIC'
  ];

  let session=null;
  let bootstrapCache=null;
  let bootstrapAt=0;

  function readSession(){
    try{return JSON.parse(localStorage.getItem(SESSION_KEY)||'null')}
    catch(_){return null}
  }

  function saveSession(value){
    session=value||null;
    try{
      if(!value){localStorage.removeItem(SESSION_KEY);return;}
      if(!value.expires_at&&value.expires_in){
        value.expires_at=Math.floor(Date.now()/1000)+Number(value.expires_in);
      }
      localStorage.setItem(SESSION_KEY,JSON.stringify(value));
    }catch(_){}
  }

  async function parse(response){
    const text=await response.text();
    let data={};
    try{data=text?JSON.parse(text):{}}
    catch(_){data={message:text}}
    if(!response.ok){
      throw new Error(
        data.message||data.error_description||data.error||
        ('Supabase request failed ('+response.status+')')
      );
    }
    return data;
  }

  async function refreshSession(){
    const current=readSession();
    if(!current?.refresh_token){
      throw new Error('Please sign in to BIG BROTHER first.');
    }
    const response=await fetch(URL+'/auth/v1/token?grant_type=refresh_token',{
      method:'POST',
      headers:{apikey:KEY,'Content-Type':'application/json'},
      body:JSON.stringify({refresh_token:current.refresh_token})
    });
    const next=await parse(response);
    saveSession(next);
    return next;
  }

  async function ensureSession(){
    session=readSession();
    if(!session?.access_token){
      throw new Error('Please sign in to BIG BROTHER first.');
    }
    const now=Math.floor(Date.now()/1000);
    if(session.expires_at&&Number(session.expires_at)<now+30){
      await refreshSession();
    }
    return session;
  }

  async function rpc(fn,args={}){
    await ensureSession();
    const response=await fetch(URL+'/rest/v1/rpc/'+fn,{
      method:'POST',
      headers:{
        apikey:KEY,
        Authorization:'Bearer '+session.access_token,
        'Content-Type':'application/json'
      },
      body:JSON.stringify(args||{}),
      cache:'no-store'
    });
    return parse(response);
  }

  async function bootstrap(force=false){
    const now=Date.now();
    if(!force&&bootstrapCache&&now-bootstrapAt<15000){
      return bootstrapCache;
    }
    bootstrapCache=await rpc('bb_sales_support_bootstrap');
    bootstrapAt=now;
    return bootstrapCache;
  }

  async function findCustomer(params={}){
    const data=await bootstrap();
    const list=Array.isArray(data.customers)?data.customers:[];
    const id=String(params.customerId||'').trim();
    if(id){
      const found=list.find(x=>String(x.customerId||'').trim()===id);
      if(found)return found;
    }
    const name=String(params.customer||params.customerName||'').trim().toLowerCase();
    if(!name)return null;
    return list.find(x=>String(x.name||'').trim().toLowerCase()===name)||null;
  }

  async function customerPrices(params={}){
    const customer=await findCustomer(params);
    if(!customer){
      throw new Error('Customer was not found in Supabase.');
    }
    return rpc('bb_sales_support_customer_prices',{
      p_customer_id:String(customer.customerId||'')
    });
  }

  async function jsonp(_url,params={}){
    const action=String(params?.action||'');
    switch(action){
      case 'getLocations': {
        const data=await bootstrap();
        return Array.isArray(data.locations)?data.locations:[];
      }
      case 'getProducts': {
        const data=await bootstrap();
        return Array.isArray(data.products)?data.products:[];
      }
      case 'getCustomers': {
        const data=await bootstrap();
        return Array.isArray(data.customers)?data.customers:[];
      }
      case 'getCustomersByLocation': {
        const data=await bootstrap();
        const code=String(params.locationCode||'').trim();
        return (Array.isArray(data.customers)?data.customers:[])
          .filter(x=>String(x.locationCode||'').trim()===code);
      }
      case 'getCustomerProductPrices':
        return customerPrices(params);
      case 'getSalesmanSuccessfulDeliveries':
        return rpc('bb_delivery_successful_for_me');
      case 'getDeliveryRequest':
        return rpc('bb_delivery_request_detail',{
          p_delivery_request_id:String(params.deliveryRequestId||'')
        });
      default:
        throw new Error('Unsupported Sales Support read action: '+action);
    }
  }

  async function apiPost(_url,payload={}){
    const action=String(payload?.action||'');
    switch(action){
      case 'createDeliveryRequest':
        return rpc('bb_delivery_create_request',{p_payload:payload||{}});
      default:
        throw new Error('Unsupported Sales Support write action: '+action);
    }
  }

  function clearLegacyCaches(){
    try{
      LEGACY_CACHE_KEYS.forEach(key=>localStorage.removeItem(key));
      const prefixes=[
        'bb_sales_support_customers_v1_',
        'bb_sales_support_prices_v1_'
      ];
      for(let i=localStorage.length-1;i>=0;i--){
        const key=localStorage.key(i)||'';
        if(prefixes.some(prefix=>key.startsWith(prefix))){
          localStorage.removeItem(key);
        }
      }
    }catch(_){}
  }

  window.BBSalesSupportAdapter={
    rpc,bootstrap,jsonp,apiPost,clearLegacyCaches,ensureSession
  };
})();