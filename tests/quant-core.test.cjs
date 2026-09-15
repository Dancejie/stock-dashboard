'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const Q = require('../quant-core.js');
const free = {initialCash:100000,commissionRate:0,minCommission:0,stampTaxRate:0,slippageBps:0,lotSize:100};
const date = i => new Date(Date.UTC(2020,0,i+1)).toISOString().slice(0,10);
function bars(prices, opens) {
  return prices.map((close,i)=>{const open=opens?opens[i]:close;return {time:date(i),open,close,high:Math.max(open,close)*1.01,low:Math.min(open,close)*0.99,volume:1000000};});
}
function near(a,b) { assert(Math.abs(a-b)<1e-6, `${a} != ${b}`); }
function assertLedger(r) {
  near(r.initialCash+r.fills.reduce((s,f)=>s+f.cashFlow,0),r.finalCash);
  assert(r.equity.every(e=>e.cash>=-1e-7));
  assert.equal(r.finalShares,r.fills.reduce((s,f)=>s+(f.side==='buy'?1:-1)*f.qty,0));
  for(const t of r.trades) {
    const fs=r.fills.filter(f=>t.fillIds.includes(f.id));
    near(t.profit,fs.reduce((s,f)=>s+f.cashFlow,0));
    near(t.pnl,t.profit/t.buyCost*100);
  }
}

test('browser UMD global and CommonJS expose the same API',()=>{
  const browser={};vm.createContext(browser);vm.runInContext(fs.readFileSync(require.resolve('../quant-core.js'),'utf8'),browser);
  assert.equal(typeof browser.StockQuant.run,'function');assert(browser.StockQuant.strategies.includes('hold'));
});

test('MA closed signal trades next open and a final-bar signal stays pending',()=>{
  const d=bars([10,10,10,9,12,13],[10,10,10,10,9,12.5]);
  const p={shortN:2,longN:3};
  const short=Q.run(d.slice(0,5),'ma',p,free);
  assert.equal(short.fills.length,0);assert.equal(short.currentState.pendingOrders[0].signalDate,date(4));
  const full=Q.run(d,'ma',p,free);
  assert.equal(full.fills.length,1);assert.equal(full.fills[0].date,date(5));near(full.fills[0].price,12.5);
  assert.equal(full.fills[0].signalDate,date(4));assert.equal(full.trades.length,0);assert(full.holding);
  assert.equal(full.tradeCount,0);assert.equal(full.winRate,0);assertLedger(full);
});

test('TD uses next day open, not next day close',()=>{
  const prices=Array.from({length:14},(_,i)=>100-i),opens=prices.slice();opens[13]=89;
  const r=Q.run(bars(prices,opens),'td',{},free);
  assert.equal(r.tdSignals[12].signal,'buy9');assert.equal(r.fills[0].signalDate,date(12));near(r.fills[0].price,89);
  assert.equal(r.trades.length,0);assertLedger(r);
});

test('causal prefix is unchanged when future closes change for every strategy',()=>{
  const prices=Array.from({length:100},(_,i)=>100+Math.sin(i/4)*20+i*0.1);
  const a=bars([...prices,100,110,90]),b=bars([...prices,30,170,50]);
  const setups={hold:{},mr:{threshold:5,smaPeriod:10,batches:2,tp1:5,tp2:10,tp3:15,stopLoss:10},ma:{shortN:3,longN:7},boll:{period:10,mult:1},turtle:{},td:{},grid:{step:5,gridDown:5,gridUp:5,lotBuy:1}};
  for(const [strategy,p] of Object.entries(setups)) {
    const ra=Q.run(a,strategy,p,free),rb=Q.run(b,strategy,p,free),prefix=Q.run(a.slice(0,100),strategy,p,free);
    assert.deepEqual(ra.fills.filter(f=>f.time<=date(99)),rb.fills.filter(f=>f.time<=date(99)),strategy);
    assert.deepEqual(prefix.fills,ra.fills.filter(f=>f.time<=date(99)),strategy);
    assert.deepEqual(prefix.equity,ra.equity.slice(0,100),strategy);assertLedger(ra);assertLedger(rb);
  }
});

test('grid historical base comes from first evaluation open, never last close',()=>{
  const p={step:10,gridDown:3,gridUp:3,lotBuy:1};
  const a=Q.run(bars([100,90,100,100]),'grid',p,free),b=Q.run(bars([100,90,100,110]),'grid',p,free);
  assert.deepEqual(a.fills.filter(f=>f.time<=date(2)),b.fills.filter(f=>f.time<=date(2)));
  assert.equal(a.fills.filter(f=>f.side==='buy').length,1);
  assert.equal(a.fills[0].signalDate,date(1));assert.equal(a.fills[0].date,date(2));
});

test('minimum commission, slippage and whole lots cannot overdraw capital',()=>{
  const d=bars([10,10]);
  const noRoom=Q.run(d,'hold',{},Object.assign({},free,{initialCash:1000,minCommission:5}));assert.equal(noRoom.fills.length,0);
  const r=Q.run(d,'hold',{},Object.assign({},free,{initialCash:2010,minCommission:5,commissionRate:.0003,slippageBps:5}));
  assert.equal(r.fills[0].qty,200);near(r.fills[0].commission,5);assert(r.finalCash>=0);assert.equal(r.fills[0].qty%100,0);assertLedger(r);
});

test('warmup is indicator-only, first evaluation may execute prior closed signal',()=>{
  const d=bars([10,10,10,9,12,13],[10,10,10,10,9,12.5]);
  const r=Q.run(d,'ma',{shortN:2,longN:3},Object.assign({},free,{start:date(5)}));
  assert.equal(r.equity.length,1);assert.equal(r.equity[0].time,date(5));assert.equal(r.fills.length,1);assert.equal(r.fills[0].time,date(5));
  assert.equal(r.fills[0].signalDate,date(4));
  assert.throws(()=>Q.run(d,'hold',{},Object.assign({},free,{start:'2030-01-01'})),/No bars/);
});

test('same-day buys are unavailable under T+1; exits wait for next open',()=>{
  const prices=[...Array(60).fill(100),90,81,79,80];
  const opens=prices.map((v,i)=>i?prices[i-1]:v);
  const r=Q.run(bars(prices,opens),'mr',{threshold:5,batches:3,tp1:50,tp2:100,tp3:150,stopLoss:4},free);
  const firstBuy=r.fills.find(f=>f.side==='buy');assert(firstBuy);
  const buyDay=r.equity.find(e=>e.time===firstBuy.time);assert.equal(buyDay.sellableShares,0);
  for(const sell of r.fills.filter(f=>f.side==='sell')) {
    const available=r.fills.filter(f=>f.time<sell.time).reduce((s,f)=>s+(f.side==='buy'?1:-1)*f.qty,0);
    assert(sell.qty<=available);assert(sell.signalDate<sell.date);
  }
  const firstExit=r.fills.find(f=>f.side==='sell');assert(firstExit);
  assert.equal(r.fills.filter(f=>f.side==='buy'&&f.date<=firstExit.date).length,1);assertLedger(r);
});

test('partial exits reconcile the complete trade PnL and its win rate',()=>{
  const prices=[...Array(60).fill(100),90,99,108.9,119.79,131.769,118.5921,106.73289,96.059601,86.4536409,77.80827681,77.80827681];
  const opens=prices.map((v,i)=>i?prices[i-1]:v);
  const r=Q.run(bars(prices,opens),'mr',{threshold:5,batches:1,tp1:20,tp2:40,tp3:100,stopLoss:10},Object.assign({},free,{initialCash:1000000,commissionRate:.0003,minCommission:5,stampTaxRate:.0005}));
  assert.equal(r.trades.length,1);assert.equal(r.fills.filter(f=>f.side==='sell').length,3);
  assert(r.trades[0].profit>0);assert(r.trades[0].pnl>0);assert.equal(r.winRate,100);assert.equal(r.holding,null);
  assert(r.totalFees>0);assertLedger(r);near(r.trades[0].profit,r.finalCash-r.initialCash);
});

test('holding is marked to market and excluded from completed trade wins',()=>{
  const r=Q.run(bars([10,12]),'hold',{},free);
  assert.equal(r.tradeCount,0);assert.equal(r.winRate,0);assert(r.holding.unrealizedProfit>0);
  assert.equal(r.fills.length,1);near(r.finalVal,r.finalCash+r.finalShares*12);assertLedger(r);
});

test('zero volume and locked adverse limit bars do not receive fills',()=>{
  const d=bars([10,10,11,11]);d[0].volume=0;
  const r=Q.run(d,'hold',{},free);assert.equal(r.fills[0].date,date(1));assert(r.skippedOrders.length);
  const u=bars([10,11,11]);Object.assign(u[1],{open:11,close:11,high:11,low:11});
  const locked=Q.run(u,'hold',{},Object.assign({},free,{start:date(1)}));
  assert.equal(locked.fills[0].date,date(2));assert(locked.skippedOrders.some(s=>s.reason.includes('涨跌停')));
});

test('incomplete final bars do not emit executable closed-day signals',()=>{
  const d=bars([10,10,10,9,12]);d[4].complete=false;
  const r=Q.run(d,'ma',{shortN:2,longN:3},free);assert.deepEqual(r.currentState.pendingOrders,[]);
});

test('stable validation rejects malformed params and bars instead of silently replacing them',()=>{
  const d=bars([10,11]);
  assert.throws(()=>Q.run(d,'ma',{shortN:20,longN:5},free),/shortN/);
  assert.throws(()=>Q.run(d,'mr',{threshold:80,batches:5},free),/deepest/);
  assert.throws(()=>Q.run(d,'mr',{tp1:50,tp2:40},free),/Take-profit/);
  assert.throws(()=>Q.run(d,'grid',{base:-1},free),/base/);
  assert.throws(()=>Q.run(d,'hold',{},Object.assign({},free,{lotSize:0})),/lotSize/);
  assert.throws(()=>Q.run([d[0],d[0]],'hold',{},free),/unique/);
  assert.throws(()=>Q.run([{...d[0],open:20}],'hold',{},free),/OHLC/);
  assert.throws(()=>Q.run(d,'hold',{},Object.assign({},free,{start:'2020-02-30'})),/valid/);
  assert.throws(()=>Q.run([{...d[0],time:'2020-02-30'}],'hold',{},free),/ISO/);
});

test('manual plans use the exact same final closed-bar signal as the engine',()=>{
  const d=bars(Array.from({length:100},(_,i)=>100+Math.sin(i/4)*20+i*.1));
  const setups={mr:{threshold:5,smaPeriod:10,batches:2,tp1:5,tp2:10,tp3:15,stopLoss:10},ma:{shortN:3,longN:7},boll:{period:10,mult:1},turtle:{},td:{},grid:{step:5,gridDown:5,gridUp:5,lotBuy:1}};
  for(const [strategy,p] of Object.entries(setups)) {
    const run=Q.run(d,strategy,p,free),s=run.currentState;
    const position={cash:run.finalCash,quantity:run.finalShares,sellableQty:s.sellableShares,avgCost:s.avgCost,strategyCapital:free.initialCash,batchesBought:s.batchesBought,tpStage:s.tpHits.filter(Boolean).length,base:s.base};
    const plan=Q.plan(d,strategy,p,position,free);
    assert.deepEqual(plan.orders.map(o=>[o.side,o.reason]),s.pendingOrders.map(o=>[o.side,o.reason]),strategy);
    assert(plan.budgetRemaining>=-1e-7);assert(plan.sellableRemaining>=0);
  }
});

test('MA and TD manual-entry budgets retain the core 95% cash rule',()=>{
  const ma=bars([10,10,10,9,12]);
  const m=Q.plan(ma,'ma',{shortN:2,longN:3},{cash:10000,quantity:0,sellableQty:0},free);
  assert.equal(m.orders[0].budget,9500);assert.equal(m.orders[0].qty,700);
  const td=Q.plan(bars(Array.from({length:13},(_,i)=>100-i)),'td',{}, {cash:100000,quantity:0,sellableQty:0},free);
  assert.equal(td.orders[0].budget,95000);
});

test('MR plans require actual cycle state and avoid reactivating completed take profits',()=>{
  const d=bars([...Array(60).fill(10),15]);
  const p={threshold:5,batches:1,tp1:10,tp2:20,tp3:30,stopLoss:10};
  const pos={cash:0,quantity:600,sellableQty:350,avgCost:10,strategyCapital:10000};
  assert.throws(()=>Q.plan(d,'mr',p,pos,free),/已完成买入批数/);
  assert.throws(()=>Q.plan(d,'mr',p,{...pos,batchesBought:1},free),/止盈阶段/);
  const plan=Q.plan(d,'mr',p,{...pos,batchesBought:1,tpStage:0},free);
  assert.deepEqual(plan.orders.map(o=>o.qty),[200,100,50]);
  assert.equal(plan.orders.reduce((s,o)=>s+o.qty,0),350);
  const afterFirst=Q.plan(d,'mr',p,{...pos,batchesBought:1,tpStage:1},free);
  assert.deepEqual(afterFirst.orders.map(o=>o.reason),['tp2','tp3']);
  assert(afterFirst.orders.every(o=>o.side==='sell'));
});

test('grid plans reserve shared cash across buys and emit only one sell tier',()=>{
  const p={step:10,gridDown:3,gridUp:3,lotBuy:1};
  const buys=Q.plan(bars([100,70]),'grid',p,{cash:19000,quantity:0,sellableQty:0,base:100},free);
  assert.equal(buys.orders.length,3);assert.deepEqual(buys.orders.map(o=>o.qty),[100,100,0]);
  assert(buys.orders.reduce((s,o)=>s+o.referenceCash,0)<=19000);
  const sells=Q.plan(bars([100,140]),'grid',p,{cash:0,quantity:500,sellableQty:500,avgCost:100,base:100},free);
  assert.equal(sells.orders.length,1);assert.equal(sells.orders[0].qty,100);
});

test('manual plans reject invalid positions and ignore an unfinished latest bar',()=>{
  const d=bars([10,10,10,9,12]);
  assert.throws(()=>Q.plan(d,'ma',{shortN:2,longN:3},{cash:10000,quantity:100,sellableQty:200,avgCost:10},free),/实际可卖/);
  assert.throws(()=>Q.plan(d,'ma',{shortN:2,longN:3},{cash:NaN},free),/可用资金/);
  d[4].complete=false;
  const p=Q.plan(d,'ma',{shortN:2,longN:3},{cash:10000},free);
  assert.equal(p.asOf,date(3));assert.equal(p.orders.length,0);
});

test('condition-plan adapter copies real newlines and only the selected strategy',()=>{
  const source=fs.readFileSync(require.resolve('../dashboard-upgrade.js'),'utf8');
  const start=source.indexOf('  function buildPlan('),end=source.indexOf('\n  async function copyPlan()',start);
  assert(start>=0&&end>start);
  const output={innerHTML:''},button={};
  const context={StockQuant:Q,quoteNow:{quoteDate:date(4),quoteTime:date(4)+' 15:00:00'},S:{ohlcv:bars([10,10,10,9,12]),name:'Example',code:'600000'},lastPlan:null,
    document:{getElementById:id=>id==='orderDraftOutput'?output:button},val:()=>10000,params:()=>({shortN:2,longN:3}),config:()=>free,
    labels:{ma:'双均线'},clean:String,num:n=>Number(n).toFixed(2),copyPlan:()=>{}};
  vm.createContext(context);vm.runInContext(source.slice(start,end),context);context.buildPlan('ma',{});
  assert(context.lastPlan.includes('\n'));assert(!context.lastPlan.includes('\\n'));
  assert(context.lastPlan.includes('95%'));assert(!context.lastPlan.includes('均值回归'));
  assert(!output.innerHTML.includes('NaN'));assert(output.innerHTML.includes('9500.00'));assert.equal(typeof button.onclick,'function');
  context.quoteNow=null;context.buildPlan('ma',{});
  assert(output.innerHTML.includes('报价时间不可核实，暂不启用本条'));assert(!output.innerHTML.includes('9500.00'));
  context.quoteNow={quoteDate:date(5),quoteTime:date(5)+' 09:31:00'};context.buildPlan('ma',{});
  assert(output.innerHTML.includes('对应开盘已过，不启用本条'));assert(!output.innerHTML.includes('9500.00'));
});

function supertrendFixture() {
  return [[10,11,9,10],[10,11,9,10],[10,15,9,14],[13.5,16,13,15],[15,15,8,9],[8.5,10,8,9]].map(([open,high,low,close],i)=>({time:date(i),open,high,low,close,volume:10000}));
}
function chandelierFixture() {
  const rows=bars([...Array(70).fill(100),110,112,125,124,90,90]);
  rows[0].high=500;
  Object.assign(rows[70],{open:100,high:111,low:99});
  Object.assign(rows[71],{open:110,high:113,low:108});
  Object.assign(rows[72],{open:112,high:130,low:111});
  Object.assign(rows[73],{open:125,high:128,low:110});
  Object.assign(rows[74],{open:124,high:125,low:89});
  Object.assign(rows[75],{open:88,high:91,low:87});
  return rows;
}

test('Wilder ATR uses an SMA seed and recursive 1/n smoothing including gaps',()=>{
  const d=[[10,11,9,10],[10,13,10,12],[12,15,11,14],[14,16,13,15],[15,20,14,19]].map(([open,high,low,close],i)=>({time:date(i),open,high,low,close}));
  const a=Q.calcWilderATR(d,3);
  assert.deepEqual(a.slice(0,2),[null,null]);near(a[2],3);near(a[3],3);near(a[4],4);
  assert.notEqual(a[4],(4+3+6)/3);
  assert.deepEqual(Q.calcWilderATR(d.slice(0,4),3),a.slice(0,4));
});

test('Supertrend matches a hand-calculated official band recurrence and flips',()=>{
  const rows=Q.calcSupertrend(supertrendFixture(),{atrPeriod:2,mult:1});
  assert.equal(rows[0].atr,null);assert.equal(rows[1].direction,'down');
  near(rows[1].upperBand,12);near(rows[1].lowerBand,8);
  near(rows[2].atr,4);near(rows[2].upperBand,12);near(rows[2].lowerBand,8);assert.equal(rows[2].flip,'up');
  near(rows[3].atr,3.5);near(rows[3].upperBand,18);near(rows[3].lowerBand,11);assert.equal(rows[3].flip,null);
  near(rows[4].atr,5.25);near(rows[4].upperBand,16.75);near(rows[4].lowerBand,11);assert.equal(rows[4].flip,'down');near(rows[4].value,16.75);
});

test('Supertrend waits for next open on both flips and leaves last signal pending',()=>{
  const p={atrPeriod:2,mult:1},d=supertrendFixture();
  const pending=Q.run(d.slice(0,3),'supertrend',p,free);assert.equal(pending.fills.length,0);assert.equal(pending.currentState.pendingOrders[0].reason,'supertrend-up');
  const r=Q.run(d,'supertrend',p,free);
  assert.deepEqual(r.fills.map(f=>[f.side,f.signalDate,f.date,f.price]),[['buy',date(2),date(3),13.5],['sell',date(4),date(5),8.5]]);
  assert.equal(r.trades.length,1);assertLedger(r);
});

test('TSMOM independently computed volatility limits initial allocation and does not rebalance',()=>{
  const prices=[100,101,99,103,106,104,108,111,112,80,81],opens=prices.slice();opens[4]=104;opens[10]=79;
  const d=bars(prices,opens),p={lookback:3,volPeriod:3,targetVol:15,maxAllocation:50};
  const r=Q.run(d,'tsmom',p,free),returns=[101/100-1,99/101-1,103/99-1],mean=returns.reduce((a,b)=>a+b)/3;
  const vol=Math.sqrt(returns.reduce((s,x)=>s+(x-mean)**2,0)/2)*Math.sqrt(252),allocation=Math.min(.5,.15/vol);
  near(r.indicatorSeries[3].annualizedVol,vol);near(r.indicatorSeries[3].allocation,allocation);
  near(r.indicatorSeries[3].roc,.03);
  assert.equal(r.fills[0].qty,Math.floor(free.initialCash*allocation/104/100)*100);
  assert.deepEqual(r.fills.map(f=>[f.side,f.signalDate,f.date]),[['buy',date(3),date(4)],['sell',date(9),date(10)]]);
  assertLedger(r);
});

test('TSMOM zero observed volatility is bounded by allocation cap and equality exits',()=>{
  const p={lookback:2,volPeriod:2,targetVol:15,maxAllocation:40};
  const r=Q.run(bars([100,110,121,133.1,121,120]),'tsmom',p,free);
  near(r.indicatorSeries[2].allocation,.4);
  assert(r.fills[0].qty*r.fills[0].price<=free.initialCash*.4);
  assert.equal(r.currentState.pendingOrders.length,0);
  const equality=Q.plan(bars([100,110,100]),'tsmom',p,{cash:0,quantity:100,sellableQty:100,avgCost:100},free);
  assert.equal(equality.orders[0].reason,'momentum-nonpositive');assert.equal(equality.orders[0].qty,100);
});

test('Chandelier initializes from the actual entry day, ratchets and exits next open',()=>{
  const d=chandelierFixture(),p={entryPeriod:3,atrPeriod:3,mult:2,riskPct:1};
  const r=Q.run(d,'chandelier',p,{...free,lotSize:1});
  const buy=r.fills.find(f=>f.side==='buy');assert.equal(buy.date,date(71));
  const first=r.stateHistory.find(s=>s.time===buy.date);assert.equal(first.highestHigh,113);assert(first.highestHigh<500);
  const held=r.stateHistory.filter(s=>s.shares>0);
  for(let i=1;i<held.length;i++)if(held[i].entryDate===held[i-1].entryDate)assert(held[i].previousStop>=held[i-1].previousStop);
  const before=r.stateHistory.find(s=>s.time===date(72)),widerATR=r.stateHistory.find(s=>s.time===date(73));
  near(before.previousStop,widerATR.previousStop);
  const exit=r.fills.find(f=>f.side==='sell');assert.equal(exit.signalDate,date(74));assert.equal(exit.date,date(75));near(exit.price,88);
  assert.equal(r.currentState.highestHigh,null);assert.equal(r.currentState.previousStop,null);assertLedger(r);
});

test('Chandelier never updates its high or stop from an unfinished bar',()=>{
  const d=chandelierFixture().slice(0,74),p={entryPeriod:3,atrPeriod:3,mult:2,riskPct:1};
  d[73].high=999;d[73].complete=false;
  const r=Q.run(d,'chandelier',p,{...free,lotSize:1}),prev=r.stateHistory.at(-2),last=r.stateHistory.at(-1);
  assert.equal(last.highestHigh,prev.highestHigh);assert.equal(last.previousStop,prev.previousStop);assert.equal(last.stopUpdatedAt,prev.stopUpdatedAt);
  assert.deepEqual(r.currentState.pendingOrders,[]);
});

test('all three new strategies preserve causal prefixes, next-open timing, lot and fee limits',()=>{
  const prefix=Array.from({length:200},(_,i)=>100+Math.sin(i/7)*20+i*.03);
  const a=bars([...prefix,80,120,130]),b=bars([...prefix,400,10,900]);
  const setups={supertrend:{atrPeriod:10,mult:2},tsmom:{lookback:20,volPeriod:10,targetVol:15,maxAllocation:95},chandelier:{entryPeriod:10,atrPeriod:10,mult:2,riskPct:1}};
  for(const [strategy,p] of Object.entries(setups)) {
    const options={initialCash:100000,commissionRate:.0003,minCommission:5,stampTaxRate:.0005,slippageBps:5,lotSize:100};
    const ra=Q.run(a,strategy,p,options),rb=Q.run(b,strategy,p,options),short=Q.run(a.slice(0,200),strategy,p,options);
    assert(ra.fills.length>0,strategy);
    assert.deepEqual(ra.fills.filter(f=>f.date<=date(199)),rb.fills.filter(f=>f.date<=date(199)),strategy);
    assert.deepEqual(short.fills,ra.fills.filter(f=>f.date<=date(199)),strategy);assert.deepEqual(short.equity,ra.equity.slice(0,200),strategy);
    for(const f of ra.fills){assert(f.date>f.signalDate);assert.equal(f.qty%100,0);assert(f.fees>0);}
    assertLedger(ra);assertLedger(rb);
  }
});

test('new-strategy manual plans agree with core signals for actual holding state',()=>{
  const setups=[['supertrend',supertrendFixture(),{atrPeriod:2,mult:1}],['tsmom',bars([100,101,99,103,106,104,108,111,112,80,81]),{lookback:3,volPeriod:3,targetVol:15,maxAllocation:50}],['chandelier',chandelierFixture(),{entryPeriod:3,atrPeriod:3,mult:2,riskPct:1}]];
  for(const [strategy,d,p] of setups) {
    for(let length=Math.max(p.atrPeriod||0,p.lookback||0,p.volPeriod||0,p.entryPeriod||0)+2;length<=d.length;length++) {
      const data=d.slice(0,length),r=Q.run(data,strategy,p,{...free,lotSize:1}),s=r.currentState;
      const position={cash:r.finalCash,quantity:r.finalShares,sellableQty:s.sellableShares,avgCost:s.avgCost,entryDate:s.entryDate,highestHigh:s.highestHigh,previousStop:s.previousStop};
      const plan=Q.plan(data,strategy,p,position,{...free,lotSize:1});
      assert.deepEqual(plan.orders.map(o=>[o.side,o.reason]),s.pendingOrders.map(o=>[o.side,o.reason]),strategy+' '+length);
      assert(!plan.rules.join(' ').includes('NaN'));assert(plan.budgetRemaining>=-1e-7);assert(plan.sellableRemaining>=0);
      if(strategy==='chandelier'&&r.finalShares) {near(plan.currentState.previousStop,s.previousStop);near(plan.currentState.highestHigh,s.highestHigh);}
    }
  }
});

test('Chandelier plans require manual holding-cycle state and never borrow pre-entry highs',()=>{
  const data=chandelierFixture().slice(0,73),p={entryPeriod:3,atrPeriod:3,mult:2,riskPct:1};
  const pos={cash:0,quantity:100,sellableQty:100,avgCost:110};
  assert.throws(()=>Q.plan(data,'chandelier',p,pos,free),/entryDate/);
  assert.throws(()=>Q.plan(data,'chandelier',p,{...pos,entryDate:date(71)},free),/highestHigh/);
  assert.throws(()=>Q.plan(data,'chandelier',p,{...pos,entryDate:date(71),highestHigh:113},free),/previousStop/);
  const plan=Q.plan(data,'chandelier',p,{...pos,entryDate:date(71),highestHigh:113,previousStop:102},free);
  assert.equal(plan.currentState.highestHigh,130);assert(plan.currentState.previousStop>=102);assert(plan.currentState.previousStop<500);
  assert.throws(()=>Q.plan(data,'chandelier',p,{...pos,entryDate:date(74),highestHigh:113,previousStop:102},free),/尚未完成/);
});

test('new strategy defaults and percentage constraints are explicit',()=>{
  const data=bars(Array.from({length:150},(_,i)=>100+Math.sin(i)*2+i*.1));
  assert.deepEqual(Q.run(data,'supertrend',{},free).params,{atrPeriod:10,mult:3});
  assert.deepEqual(Q.run(data,'tsmom',{},free).params,{lookback:126,volPeriod:20,targetVol:15,maxAllocation:95});
  assert.deepEqual(Q.run(data,'chandelier',{},free).params,{entryPeriod:55,atrPeriod:22,mult:3,riskPct:1});
  assert.throws(()=>Q.run(data,'tsmom',{maxAllocation:101},free),/maxAllocation/);
  assert.throws(()=>Q.run(data,'supertrend',{atrPeriod:1},free),/atrPeriod/);
  assert.throws(()=>Q.run(data,'chandelier',{mult:0},free),/mult/);
});
