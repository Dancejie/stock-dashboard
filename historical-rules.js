// Dated public rules for ordinary on-exchange RMB A shares, limit orders only.
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.StockHistoricalRules=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const coverageStart='2016-01-01',coverageEnd='2026-11-10';
  const sources=Object.freeze({
    stamp:'https://shanxi.chinatax.gov.cn/web/detail/sx-11400-545-1780448',
    transfer:'https://jrj.wuhan.gov.cn/ynzx_57/xwzx/202204/t20220429_1964160.shtml',
    chinext:'https://www.szse.cn/aboutus/trends/news/t20200821_580924.html',
    chinextRisk:'https://www.szse.cn/disclosure/notice/general/t20200710_579459.html',
    star:'https://edu.sse.com.cn/attention/c/4869120.shtml',
    registration:'https://www.sse.com.cn/aboutus/mediacenter/hotandd/c/c_20230404_5719112.shtml',
    risk2026:'https://www.csrc.gov.cn/shanghai/c105566/c7643909/content.shtml'
  });
  function date(d){if(typeof d!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(d)||!Number.isFinite(Date.parse(d))||new Date(d).toISOString().slice(0,10)!==d)throw Error('历史规则日期无效');return d;}
  function boardOf(symbol){if(/^sh688\d{3}$/.test(symbol))return 'star';
    if(/^sz30[01]\d{3}$/.test(symbol))return 'chinext';
    if(/^sh60[0135]\d{3}$/.test(symbol)||/^sz00[0123]\d{3}$/.test(symbol))return 'main';
    throw Error('未覆盖该证券或板块：仅核对沪深主板、科创板及创业板普通人民币A股');}
  function resolve(symbol,on,context={}){
    date(on);const board=boardOf(symbol);
    if(on<coverageStart||on>coverageEnd||(board==='star'&&on<'2019-07-22'))throw Error('该日期超出已核验历史规则覆盖：'+coverageStart+' 至 '+coverageEnd+'（科创板自2019-07-22）');
    if(!context||typeof context!=='object'||Array.isArray(context))throw Error('交易状态参数无效');
    const warnings=[];
    if(context.riskWarning!=null&&typeof context.riskWarning!=='boolean')throw Error('riskWarning 须为该日真实布尔状态');
    if(context.specialStatus&&context.specialStatus!=='normal')throw Error('未实现退市整理、重新上市、重组复牌等特殊交易状态');
    const star=board==='star',newGrowth=board==='chinext'&&on>='2020-08-24';
    let limitPct=star||newGrowth?20:context.riskWarning&&(board==='chinext'||on<'2026-07-06')?5:10;
    if(context.riskWarning==null)warnings.push('未提供逐日风险警示状态，按普通非ST交易日处理。');
    const listed=context.listingDate==null?null:date(context.listingDate);
    if(listed&&listed>on)throw Error('规则评价日早于上市日');
    const n=context.listingTradeDay==null?(listed===on?1:null):context.listingTradeDay;
    if(n!=null&&(!Number.isSafeInteger(n)||n<1||(listed===on&&n!==1)||(listed&&on>listed&&n===1)))throw Error('listingTradeDay 须为真实的上市交易日序号');
    if(n!=null&&n<=5){
      if(!listed)throw Error('前五个上市交易日需同时提供真实上市日期以识别发行制度');
      const reg=star||(board==='chinext'?listed>='2020-08-24':listed>='2023-04-10');
      if(reg)limitPct=null;
      else if(n===1)throw Error('旧发行制度上市首日特殊定价不在覆盖范围，不能按普通涨跌停撮合。');
    }else if(n==null)warnings.push('未提供上市交易日序号，按非新股交易日处理；不自动判定上市首五日特例。');
    const min=star?200:100,step=star?1:100,max=star?100000:newGrowth?300000:1000000;
    return {mode:'historical',symbol,date:on,board,buyMin:min,buyStep:step,sellMin:min,sellStep:step,buyMax:max,sellMax:max,
      lotSize:min,limitPct,stampTaxRate:on<'2023-08-28'?0.001:0.0005,transferFeeRate:on<'2022-04-29'?0.00002:0.00001,
      tPlusOne:true,tickSize:0.01,warnings,ruleVersion:coverageEnd};
  }
  function roundBuy(rule,quantity){const n=Math.min(rule.buyMax,Math.floor((quantity+1e-9)/rule.buyStep)*rule.buyStep);return n>=rule.buyMin?n:0;}
  function roundSell(rule,requested,sellable){
    if(!Number.isSafeInteger(sellable)||sellable<0)throw Error('实际可卖数量无效');
    const n=Math.min(Math.floor(requested+1e-9),sellable,rule.sellMax);
    if(n===sellable)return n; // entire odd residual is tradable at once
    const rounded=Math.floor(n/rule.sellStep)*rule.sellStep;return rounded>=rule.sellMin?rounded:0;
  }
  function priceBands(rule,reference){
    if(rule.limitPct==null||reference==null)return {upper:null,lower:null};
    if(typeof reference!=='number'||!Number.isFinite(reference)||reference<=0)throw Error('需有效除权参考价/上一交易日价格');
    const ticks=v=>Math.round(v*100+1e-8),ref=ticks(reference);
    return {upper:Math.max(ref+1,ticks(reference*(1+rule.limitPct/100)))/100,
      lower:Math.max(1,Math.min(ref-1,ticks(reference*(1-rule.limitPct/100))))/100};
  }
  return Object.freeze({resolve,roundBuy,roundSell,priceBands,boardOf,coverageStart,coverageEnd,sources});
});
