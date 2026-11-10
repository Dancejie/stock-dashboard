/* Shared UI/data adapter; all historical-account values use unadjusted bars. */
(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StockLedgerAdapter = api;
})(typeof globalThis === 'undefined' ? this : globalThis, function (root) {
  'use strict';
  const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const fmt = (v, d=2) => Number.isFinite(v) ? v.toLocaleString('zh-CN',{minimumFractionDigits:d,maximumFractionDigits:d}) : '—';
  const signed = v => (v > 0 ? '+' : '') + fmt(v) + '%';
  const ledger = p => p.accounting === 'ledger';
  function sample(id) {
    return {id,name:'分红送转 · 双股月度调仓',accounting:'ledger',mode:'shares',rebalance:'monthly',start:'2025-06-16',end:'2025-07-02',initialCash:5000,
      assets:[{symbol:'sh603099',name:'长白山',quantity:1000,weight:45,strategy:'hold',params:{}},{symbol:'sh688556',name:'高测股份',quantity:2000,weight:45,strategy:'hold',params:{}}],
      feeOptions:{commissionRate:.0003,minCommission:5,slippageBps:5}};
  }
  function controls(p) {
    const active=ledger(p);
    let html='<label class="sw-field"><span>收益口径</span><select data-portfolio="accounting"><option value="research" '+(!active?'selected':'')+'>价格 / 技术策略研究</option><option value="ledger" '+(active?'selected':'')+'>含分红送转的持仓账本</option></select></label>';
    if (!active) return html;
    const choices=[['none','不调仓'],['monthly','每月末'],['quarterly','每季末']];
    return html+'<label class="sw-field"><span>再平衡频率</span><select data-portfolio="rebalance">'+choices.map(([v,n])=>'<option value="'+v+'" '+((p.rebalance||'none')===v?'selected':'')+'>'+n+'</option>').join('')+'</select></label>';
  }
  function bookInfo(p) {
    if (!ledger(p)) return '';
    const rows=(root.StockCorporateActions?.listCoverage()||[]).map(b=>esc(b.name||b.symbol)+' '+esc(b.coverageStart)+' 至 '+esc(b.coverageEnd)).join('；');
    return '<details class="sw-fees"><summary>分红送转数据与导入</summary><p class="sw-note">内置已核验区间：'+rows+'。其他股票或区间需导入完整公告账本；缺少覆盖时停止计算。分红为税前，实际股息税因持有期限而异。</p><label class="sw-field"><span>导入公告账本（JSON，随组合保存）</span><input data-book-import type="file" accept=".json,application/json"></label><p class="sw-note">可导入单本或数组。已导入：'+esc(Object.keys(p.actionBooks||{}).join('、')||'无')+'。<button type="button" data-action="download-book">下载格式示例</button></p></details>';
  }
  function validate(p) {
    if (p.accounting!=null && !['research','ledger'].includes(p.accounting)) return ['收益口径无效。'];
    if (!ledger(p)) return [];
    if (!['none','monthly','quarterly'].includes(p.rebalance||'none')) return ['再平衡频率无效。'];
    if ((p.assets||[]).some(a=>a.strategy && a.strategy!=='hold')) return ['含分红账本按持有或目标权重调仓；请将每只股票设为买入持有，或使用价格 / 技术策略研究。'];
    if(p.mode==='shares' && p.rebalance && p.rebalance!=='none' && (p.assets.some(a=>!(Number(a.weight)>0))||p.assets.reduce((s,a)=>s+Number(a.weight),0)>100+1e-9))return ['请为每只股票填写正目标权重，合计不超过 100%。'];
    return [];
  }
  function parseBooks(text) {
    if(typeof text!=='string'||text.length>90000) throw Error('账本文件过大（最多 90 KB）。');
    const x=JSON.parse(text), list=Array.isArray(x)?x:[x], result={};
    if(!list.length||list.length>20)throw Error('一次导入 1 至 20 本公告账本。');
    for(const b of list){if(!b||!/^(sh|sz)\d{6}$/.test(b.symbol)||Object.hasOwn(result,b.symbol))throw Error('账本代码无效或重复。');
      root.StockCorporateActions.getBook(b.symbol,b.coverageStart,b.coverageEnd,b);result[b.symbol]=b;}
    return result;
  }
  async function run(p,getBars) {
    const errors=validate(p); if(errors.length)throw Error(errors[0]);
    const booksBySymbol={}, barsBySymbol={};
    for(const a of p.assets) booksBySymbol[a.symbol]=root.StockCorporateActions.getBook(a.symbol,p.start,p.end,p.actionBooks?.[a.symbol]);
    for(let i=0;i<p.assets.length;i+=3) await Promise.all(p.assets.slice(i,i+3).map(async a=>{barsBySymbol[a.symbol]=await getBars(a.symbol,p.start,p.end,'raw');}));
    // The index supplies an independent session calendar, so jointly missing stock bars cannot silently shorten NAV.
    const marketCalendar=await getBars('sh000300',p.start,p.end,'raw');
    const calendar=marketCalendar.bars.map(b=>b.time);
    if(!calendar.length)throw Error('缺少同期沪深300交易日期，无法核对组合日历。');
    const result=root.StockPortfolioLedger.calculate({...p,calendar,assets:p.assets.map(a=>({...a,...(p.mode==='shares'?{sellableQty:a.quantity}:{})})),booksBySymbol,barsBySymbol,
      executionOptions:{commissionRate:p.feeOptions?.commissionRate??.0003,minCommission:p.feeOptions?.minCommission??5,slippageBps:p.feeOptions?.slippageBps??5}});
    result.dataSources=Object.fromEntries(Object.entries(barsBySymbol).map(([s,data])=>[s,data.meta]));
    result.notices.push('已按同期沪深300指数日线核对交易日期；成分缺失时不补价。');
    return result;
  }
  function table(title,columns,rows){
    return '<details class="sw-fees"><summary>'+esc(title)+'（'+rows.length+'）</summary><div class="sw-table-wrap"><table><thead><tr>'+columns.map(t=>'<th>'+esc(t)+'</th>').join('')+'</tr></thead><tbody>'+rows.map(row=>'<tr>'+row.map(x=>'<td>'+esc(x)+'</td>').join('')+'</tr>').join('')+'</tbody></table></div></details>';
  }
  function resultHTML(r) {
    const b=r.baseline,actions=r.actions||[],fills=r.fills||[],rebal=r.rebalances||[];
    return '<div class="sw-ledger-result"><h4>账本核对</h4><p class="sw-note">期末可用现金 '+fmt(r.finalCash)+' 元 · 应收股利 '+fmt(r.receivableCash)+' 元 · 待上市股份价值 '+fmt(r.pendingStockValue)+' 元 · 累计交易费用 '+fmt(r.totalFees)+' 元。'+(b?'相同期初不再平衡：'+fmt(b.finalNAV)+' 元（'+signed(b.totalReturn)+'）。':'')+'</p>'+
      table('权益登记与除权',['股票','登记日','除权日','登记股数','税前现金（元）','新增股数'],actions.map(x=>[x.symbol,x.recordDate,x.exDate,x.eligibleShares,fmt(x.cashAmount),x.addedShares]))+
      table('调仓记录',['决策日','执行日','实际成交笔数'],rebal.map(x=>[x.signalDate,x.executionDate||'未执行',x.fillCount]))+
      table('成交明细',['日期','股票','方向','股数','成交价','费用'],fills.map(x=>[x.time,x.symbol,x.side==='buy'?'买':'卖',x.quantity,fmt(x.price,4),fmt(x.totalFees)]))+'</div>';
  }
  return {sample,controls,bookInfo,validate,parseBooks,run,resultHTML};
});
