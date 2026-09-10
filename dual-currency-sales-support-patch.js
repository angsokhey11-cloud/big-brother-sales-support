/* BIG BROTHER — Sales Support Customer Pricing Patch V1
 * Runs in the outer loader and patches the preserved V1.10 source before execution.
 */
(function(){
  'use strict';

  function replaceBetween(text,startMarker,endMarker,replacement,label){
    const start=text.indexOf(startMarker);
    if(start<0)throw new Error('Sales Support pricing patch missing '+label+' start marker.');
    const end=text.indexOf(endMarker,start+startMarker.length);
    if(end<0)throw new Error('Sales Support pricing patch missing '+label+' end marker.');
    return text.slice(0,start)+replacement+'\n\n'+text.slice(end);
  }

  function patch(html){
    let out=String(html||'');

    /* Preserve Default KHR from the Supabase master-product response. */
    if(!out.includes('            usdPrice:num(product.usdPrice),')){
      throw new Error('Sales Support main product mapping marker was not found.');
    }
    out=out.replaceAll(
      '            usdPrice:num(product.usdPrice),',
      '            usdPrice:num(product.usdPrice),\n            khrPrice:num(product.khrPrice ?? product.priceKHR),'
    );
    out=out.replaceAll(
      '            usdPrice:num(p.usdPrice),',
      '            usdPrice:num(p.usdPrice),\n            khrPrice:num(p.khrPrice ?? p.priceKHR),'
    );

    /* Keep both currencies + per-currency custom flags in the customer price cache. */
    const normalized=`        defaultPriceUSD:num(p.defaultPriceUSD),
        customerPriceUSD:num(p.customerPriceUSD),
        isCustomPrice:!!p.isCustomPrice`;
    if(!out.includes(normalized))throw new Error('Sales Support customer-price normalization marker was not found.');
    out=out.replace(
      normalized,
      `        defaultPriceUSD:num(p.defaultPriceUSD),
        customerPriceUSD:num(p.customerPriceUSD),
        defaultPriceKHR:num(p.defaultPriceKHR),
        customerPriceKHR:num(p.customerPriceKHR),
        isCustomPriceUSD:!!p.isCustomPriceUSD,
        isCustomPriceKHR:!!p.isCustomPriceKHR,
        isCustomPrice:!!p.isCustomPrice`
    );

    const pricingBlock=`function bbCalcConfiguredPricing(product, saved){
    const currency = calcCurrency();
    const usd = num(saved ? saved.customerPriceUSD : product?.usdPrice);
    let khr = num(saved ? saved.customerPriceKHR : product?.khrPrice);

    /* A zero KHR value means it has not been configured yet. Keep old conversion as fallback. */
    if(!(khr > 0)) khr = usd * calcRate();

    const displayPrice = currency === "KHR" ? khr : usd;
    return {
      price: currency === "KHR" ? displayPrice / calcRate() : displayPrice,
      displayPrice:displayPrice,
      hasSpecialPrice: saved
        ? (currency === "KHR" ? !!saved.isCustomPriceKHR : !!saved.isCustomPriceUSD)
        : false
    };
  }

  async function bbRefreshCalcDatabasePrices(){
    const customer = getCalcCustomer();
    let priceMap = {};

    if(customer){
      try{
        const data = await getCustomerPrices(customer);
        (data?.products || []).forEach(p => {
          priceMap[String(p.productCode || "").toUpperCase()] = p;
        });
      }catch(error){
        showStatus("calcStatus", error?.message || "Could not refresh customer prices.", true);
      }
    }

    calcLines.forEach(line => {
      if(line.manualPrice) return;
      const product = productByCode(line.productCode);
      if(!product) return;
      const saved = priceMap[String(line.productCode || "").toUpperCase()] || null;
      const pricing = bbCalcConfiguredPricing(product, saved);
      line.usdPrice = pricing.price;
      line.defaultUsdPrice = pricing.price;
    });

    renderCalcLines();
    saveCalcCurrentMemory();
  }

  async function resolveCalcProductPricing(product){
    if(!product){
      return {price:0,displayPrice:0,hasSpecialPrice:false};
    }

    const customer = getCalcCustomer();
    if(!customer) return bbCalcConfiguredPricing(product, null);

    try{
      const data = await getCustomerPrices(customer);
      const saved = (data?.products || []).find(
        p => String(p.productCode || "").toUpperCase() === String(product.code || "").toUpperCase()
      );
      return bbCalcConfiguredPricing(product, saved || null);
    }catch(_){
      return bbCalcConfiguredPricing(product, null);
    }
  }`;

    out=replaceBetween(
      out,
      '  async function resolveCalcProductPricing(product){',
      '  function loadCalcRatePreference(){',
      '  '+pricingBlock.replace(/\n/g,'\n  '),
      'calculator pricing resolver'
    );

    const resetLines=`    calcLines.forEach(line => {
      if(!line.manualPrice) line.usdPrice = line.defaultUsdPrice;
    });`;
    if(!out.includes(resetLines))throw new Error('Sales Support customer reset-pricing marker was not found.');
    out=out.replace(
      resetLines,
      `    calcLines.forEach(line => {
      if(line.manualPrice) return;
      const product = productByCode(line.productCode);
      if(!product) return;
      const pricing = bbCalcConfiguredPricing(product, null);
      line.usdPrice = pricing.price;
      line.defaultUsdPrice = pricing.price;
    });`
    );

    const customerApply=`      calcLines.forEach(line => {
        const saved = priceMap[line.productCode.toUpperCase()];
        if(saved && !line.manualPrice){
          line.usdPrice = saved.customerPriceUSD;
          line.defaultUsdPrice = saved.customerPriceUSD;
        }
      });`;
    if(!out.includes(customerApply))throw new Error('Sales Support customer apply-pricing marker was not found.');
    out=out.replace(
      customerApply,
      `      calcLines.forEach(line => {
        if(line.manualPrice) return;
        const product = productByCode(line.productCode);
        if(!product) return;
        const saved = priceMap[String(line.productCode || "").toUpperCase()] || null;
        const pricing = bbCalcConfiguredPricing(product, saved);
        line.usdPrice = pricing.price;
        line.defaultUsdPrice = pricing.price;
      });`
    );

    /* Currency switch = re-resolve the customer's price for that currency. */
    const currencyEnd=`    renderCalcLines();
  }

  function resetCalculationLines(){`;
    if(!out.includes(currencyEnd))throw new Error('Sales Support currency-change marker was not found.');
    out=out.replace(
      currencyEnd,
      `    renderCalcLines();
    bbRefreshCalcDatabasePrices().catch(() => {});
  }

  function resetCalculationLines(){`
    );

    /* If rate changes while KHR is selected, keep configured KHR prices fixed. */
    const rateListener='  $("calcRate").addEventListener("input", calculateTotals);';
    if(out.includes(rateListener)){
      out=out.replace(
        rateListener,
        '  $("calcRate").addEventListener("input", () => { calculateTotals(); if(calcCurrency() === "KHR") bbRefreshCalcDatabasePrices().catch(() => {}); });'
      );
    }

    /* Your Customer price panel shows both stored currencies. */
    out=out.replaceAll(
      '${formatMoney(p.customerPriceUSD,"USD")}',
      '${formatMoney(p.customerPriceUSD,"USD")}<br>${formatMoney(p.customerPriceKHR,"KHR")}'
    );

    return out;
  }

  window.BBSalesSupportDualCurrencyPatch={patch};
})();