/* BIG BROTHER — Sales Support Customer Price Loader V2
 * One Customer + One Product = one saved selling price.
 * KHR display uses the calculator exchange rate from that same saved USD price.
 */
(function(){
  'use strict';

  function replaceBetween(text,startMarker,endMarker,replacement,label){
    const start=text.indexOf(startMarker);
    if(start<0)throw new Error('Sales Support customer-price patch missing '+label+' start marker.');
    const end=text.indexOf(endMarker,start+startMarker.length);
    if(end<0)throw new Error('Sales Support customer-price patch missing '+label+' end marker.');
    return text.slice(0,start)+replacement+'\n\n'+text.slice(end);
  }

  function patch(html){
    let out=String(html||'');

    /* Preserve the backend flag that tells us a real customer-price row exists. */
    const normalized=`        defaultPriceUSD:num(p.defaultPriceUSD),
        customerPriceUSD:num(p.customerPriceUSD),
        isCustomPrice:!!p.isCustomPrice`;

    if(!out.includes(normalized)){
      throw new Error('Sales Support customer-price normalization marker was not found.');
    }

    out=out.replace(
      normalized,
      `        defaultPriceUSD:num(p.defaultPriceUSD),
        customerPriceUSD:num(p.customerPriceUSD),
        hasCustomerPrice:p.hasCustomerPrice === true || String(p.hasCustomerPrice).toLowerCase() === "true",
        isCustomPrice:!!p.isCustomPrice`
    );

    /*
     * Customer selected:
     * - saved customer price exists and is > 0 -> use it automatically
     * - otherwise fall back to product default and keep the manual-price popup
     */
    const resolver=`  async function resolveCalcProductPricing(product){
    const customer = getCalcCustomer();

    if(!customer){
      return {
        price:product ? product.usdPrice : 0,
        hasSpecialPrice:false,
        source:"PRODUCT_DEFAULT"
      };
    }

    try{
      const data = await getCustomerPrices(customer);
      const saved = (data.products || []).find(
        p => p.productCode.toUpperCase() === product.code.toUpperCase()
      );

      if(saved && saved.hasCustomerPrice && num(saved.customerPriceUSD) > 0){
        return {
          price:num(saved.customerPriceUSD),
          hasSpecialPrice:true,
          source:"CUSTOMER_PRICE"
        };
      }
    }catch(error){
      console.warn("Customer price lookup failed:", error);
    }

    return {
      price:product ? product.usdPrice : 0,
      hasSpecialPrice:false,
      source:"PRODUCT_DEFAULT"
    };
  }`;

    out=replaceBetween(
      out,
      '  async function resolveCalcProductPricing(product){',
      '  function loadCalcRatePreference(){',
      resolver,
      'calculator pricing resolver'
    );

    /* Existing lines must also change immediately when customer changes. */
    const customerApply=`      calcLines.forEach(line => {
        const saved = priceMap[line.productCode.toUpperCase()];
        if(saved && !line.manualPrice){
          line.usdPrice = saved.customerPriceUSD;
          line.defaultUsdPrice = saved.customerPriceUSD;
        }
      });`;

    if(!out.includes(customerApply)){
      throw new Error('Sales Support selected-customer pricing marker was not found.');
    }

    out=out.replace(
      customerApply,
      `      let configuredCount = 0;
      calcLines.forEach(line => {
        if(line.manualPrice) return;
        const saved = priceMap[line.productCode.toUpperCase()];
        const product = productByCode(line.productCode);

        if(saved && saved.hasCustomerPrice && num(saved.customerPriceUSD) > 0){
          line.usdPrice = num(saved.customerPriceUSD);
          line.defaultUsdPrice = num(saved.customerPriceUSD);
          configuredCount++;
        }else if(product){
          line.usdPrice = num(product.usdPrice);
          line.defaultUsdPrice = num(product.usdPrice);
        }
      });`
    );

    const statusBlock=`      showStatus(
        "calcStatus",
        \`${'${data.products.length}'} product prices loaded for ${'${customer.name}'}.\`,
        false
      );`;

    if(out.includes(statusBlock)){
      out=out.replace(
        statusBlock,
        `      const savedCount = (data.products || []).filter(
        p => p.hasCustomerPrice && num(p.customerPriceUSD) > 0
      ).length;
      showStatus(
        "calcStatus",
        savedCount
          ? savedCount + " customer prices loaded for " + customer.name + "."
          : "No saved customer prices yet for " + customer.name + ". Product default/manual price will be used.",
        false
      );`
      );
    }

    /* Your Customer panel labels the value clearly as the saved customer price. */
    out=out.replaceAll(
      '${formatMoney(p.customerPriceUSD,"USD")}',
      '${formatMoney(p.customerPriceUSD,"USD")}${p.hasCustomerPrice ? " · Customer Price" : " · Default"}'
    );

    return out;
  }

  /* Keep the existing global name so the loader remains rollback-safe. */
  window.BBSalesSupportDualCurrencyPatch={patch};
})();
