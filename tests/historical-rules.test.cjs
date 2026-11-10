'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),H=require('../historical-rules.js'),Q=require('../quant-core.js');
const bars=(days,opens,closes)=>days.map((time,i)=>{const open=opens[i],close=closes[i];return {time,open,close,high:Math.max(open,close)+0.1,low:Math.min(open,close)-0.1,volume:20000};});
const config={initialCash:10000,commissionRate:0,minCommission:0,slippageBps:0,ruleMode:'historical',symbol:'sh603099',adjustment:'raw'};
const nearly=(a,b)=>assert(Math.abs(a-b)<1e-7,a+' != '+b);
test('transfer fee and sell-side stamp cut over on actual effective dates',()=>{
  const r=d=>H.resolve('sz002780',d);
  assert.equal(r('2022-04-28').transferFeeRate,.00002);assert.equal(r('2022-04-29').transferFeeRate,.00001);
  assert.equal(r('2023-08-25').stampTaxRate,.001);assert.equal(r('2023-08-28').stampTaxRate,.0005);
});
test('ChiNext and main-board risk price limits use implementation dates rather than draft notice dates',()=>{
  const g=(s,d,b=false)=>H.resolve(s,d,{riskWarning:b}).limitPct;
  assert.equal(g('sz300750','2020-08-21'),10);assert.equal(g('sz300750','2020-08-21',true),5);
  assert.equal(g('sz300750','2020-08-24',true),20);assert.equal(g('sh688556','2025-06-26',true),20);
  assert.equal(g('sh603099','2025-06-30',true),5);assert.equal(g('sz002780','2026-07-03',true),5);
  assert.equal(g('sz002780','2026-07-06',true),10);
});
test('IPO exceptions require real listing sequence and unsupported exceptional states stop',()=>{
  const r=(s,d,date,n)=>H.resolve(s,d,{listingDate:date,listingTradeDay:n});
  assert.equal(r('sh603099','2023-04-14','2023-04-10',5).limitPct,null);
  assert.equal(r('sh603099','2023-04-17','2023-04-10',6).limitPct,10);
  assert.equal(r('sz300750','2020-08-24','2020-08-24',1).limitPct,null);
  assert.throws(()=>r('sz300750','2020-08-21','2020-08-21',1),/旧发行制度/);
  assert.throws(()=>H.resolve('sh688556','2025-06-26',{listingTradeDay:3}),/真实上市日期/);
  assert.throws(()=>H.resolve('sz002780','2025-12-01',{specialStatus:'relisting'}),/未实现/);
  assert.throws(()=>H.resolve('sh510300','2025-12-01'),/未覆盖/);
  assert.throws(()=>H.resolve('sh600000','2026-11-11'),/超出/);
});
test('STAR minimum is 200, further increments are single shares; odd residual liquidates in one sell',()=>{
  const r=H.resolve('sh688556','2025-06-26'),main=H.resolve('sh600000','2025-06-26');
  assert.equal(H.roundBuy(r,199.99),0);assert.equal(H.roundBuy(r,237.9),237);
  assert.equal(H.roundBuy(r,120000),100000);assert.equal(H.roundSell(r,199,350),0);assert.equal(H.roundSell(r,201,350),201);
  assert.equal(H.roundSell(r,150,150),150);assert.equal(H.roundBuy(main,237),200);assert.equal(H.roundSell(main,37,37),37);
});
test('historical stamp is taken on next-open sale, not prior signal date or configured fixed rate',()=>{
  const dates=['2023-08-21','2023-08-22','2023-08-23','2023-08-24','2023-08-25','2023-08-28'];
  const d=bars(dates,[10,10,10,10.1,10,9.9],[10,10,10.1,10,9.9,9.9]);
  const r=Q.run(d,'ma',{shortN:1,longN:2},{...config,stampTaxRate:0.07});
  // Cross-up at Aug 23, enter Aug 24; cross-down at Aug 24, sell Aug 25 (old rate).
  assert.deepEqual(r.fills.map(f=>f.date),['2023-08-24','2023-08-25']);nearly(r.fills[0].stampTax,0);nearly(r.fills[1].stampTax,r.fills[1].gross*.001);
  const delayed=bars(dates,[10,10,10,10.1,10.1,9.9],[10,10,10.1,10.2,9.9,9.9]);
  const after=Q.run(delayed,'ma',{shortN:1,longN:2},{...config,stampTaxRate:.07});
  const sell=after.fills[1];assert.equal(sell.signalDate,'2023-08-25');assert.equal(sell.date,'2023-08-28');
  nearly(sell.stampTax,sell.gross*.0005);for(const f of after.fills)nearly(f.transferFee,f.gross*.00001);
  nearly(after.finalCash,config.initialCash+after.fills.reduce((s,f)=>s+f.cashFlow,0));nearly(after.trades[0].profit,after.finalCash-config.initialCash);
});
test('historical sizing includes transfer fee and STAR step; disabling it preserves fixed-fee study',()=>{
  const d=bars(['2025-06-16'],[10],[10]);
  const opts={...config,symbol:'sh688556',initialCash:2370,lotSize:200,commissionRate:0,minCommission:0};
  const h=Q.run(d,'hold',{},opts),fixed=Q.run(d,'hold',{},{...opts,ruleMode:'fixed'});
  assert.equal(h.finalShares,236);nearly(h.finalCash,9.9764);assert.equal(fixed.finalShares,200);nearly(fixed.finalCash,370);
  assert.equal(Q.run(d,'hold',{},{...opts,initialCash:2000}).fills.length,0);
});
test('at-limit opening does not use future intraday highs/lows to grant an open fill; explicit ex-reference allowed',()=>{
  const d=bars(['2025-06-19','2025-06-20'],[10,11],[10,10.5]);
  const r=Q.run(d,'hold',{},{...config,start:'2025-06-20'});assert.equal(r.fills.length,0);assert.match(r.skippedOrders[0].reason,/涨跌停/);
  const ex=bars(['2025-06-26','2025-06-27'],[14,10],[14,10.05]);ex[1].limitReferencePrice=10;
  assert.equal(Q.run(ex,'hold',{},{...config,symbol:'sh688556',start:'2025-06-27'}).fills.length,1);
  assert.deepEqual(H.priceBands(H.resolve('sh603099','2025-06-19'),10.05),{upper:11.06,lower:9.05});
});
test('historical daily ST record changes fill eligibility and is not inferred from current stock name',()=>{
  const d=bars(['2025-06-19','2025-06-20'],[10,10.5],[10,10.45]);
  const a=Q.run(d,'hold',{},{...config,start:'2025-06-20'});
  const b=Q.run(d,'hold',{},{...config,start:'2025-06-20',ruleContext:{byDate:{'2025-06-20':{riskWarning:true}}}});
  assert.equal(a.fills.length,1);assert.equal(b.fills.length,0);assert(a.warnings.some(s=>s.includes('非ST')));
});
test('manual historical plan includes STAR step and both-side transfer fee without guessing next-session rules',()=>{
  const d=bars(['2025-06-16','2025-06-17','2025-06-18'],[10,10,10],[10,10,10.01]);
  const plan=Q.plan(d,'ma',{shortN:1,longN:2},{cash:2500,quantity:0,sellableQty:0},{...config,symbol:'sh688556',executionDate:'2025-06-19'});
  const q=plan.orders[0];assert.equal(q.qty,237);nearly(q.referenceCash,237*10.01*1.00001);assert(plan.warnings.some(s=>s.includes('2025-06-19')));
});
