(function (root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StockQuant = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';
  const DEFAULTS = Object.freeze({ initialCash: 1000000, commissionRate: 0.0003,
    minCommission: 5, stampTaxRate: 0.0005, slippageBps: 5, lotSize: 100,
    riskFreeRate: 0, limitPct: 10 });
  const STRATEGIES = Object.freeze(['hold', 'mr', 'turtle', 'ma', 'boll', 'td', 'grid']);
  function number(value, fallback, name, min, max, integer) {
    const n = value == null ? fallback : Number(value);
    if (!Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n)))
      throw new Error(name + ' must be ' + (integer ? 'an integer ' : 'a number ') + 'between ' + min + ' and ' + max);
    return n;
  }
  function normalize(strategy, input, options) {
    if (!STRATEGIES.includes(strategy)) throw new Error('Unknown strategy: ' + strategy);
    const o = Object.assign({}, DEFAULTS, options);
    o.initialCash = number(o.initialCash, DEFAULTS.initialCash, 'initialCash', 0.01, 1e14);
    for (const k of ['commissionRate', 'stampTaxRate']) o[k] = number(o[k], DEFAULTS[k], k, 0, 0.1);
    o.minCommission = number(o.minCommission, 5, 'minCommission', 0, 1e8);
    o.slippageBps = number(o.slippageBps, 5, 'slippageBps', 0, 1000);
    o.lotSize = number(o.lotSize, 100, 'lotSize', 1, 1000000, true);
    o.riskFreeRate = number(o.riskFreeRate, 0, 'riskFreeRate', -0.5, 1);
    o.limitPct = number(o.limitPct, 10, 'limitPct', 1, 100);
    const p = Object.assign({}, input);
    if (strategy === 'mr') {
      p.threshold = number(p.threshold, 25, 'threshold', 0.01, 99);
      p.batches = number(p.batches, 3, 'batches', 1, 10, true);
      if (p.threshold + (p.batches - 1) * 10 >= 100) throw new Error('The deepest MR entry threshold must be below 100%');
      p.smaPeriod = number(p.smaPeriod, 60, 'smaPeriod', 2, 1000, true);
      p.stopLoss = number(p.stopLoss, 30, 'stopLoss', 0.01, 99);
      p.tp1 = number(p.tp1, 50, 'tp1', 0.01, 10000);
      p.tp2 = number(p.tp2, 100, 'tp2', 0.01, 10000);
      p.tp3 = number(p.tp3, 150, 'tp3', 0.01, 10000);
      if (!(p.tp1 < p.tp2 && p.tp2 < p.tp3)) throw new Error('Take-profit levels must increase: tp1 < tp2 < tp3');
    } else if (strategy === 'ma') {
      p.shortN = number(p.shortN, 5, 'shortN', 1, 1000, true);
      p.longN = number(p.longN, 20, 'longN', 2, 2000, true);
      if (p.shortN >= p.longN) throw new Error('shortN must be smaller than longN');
    } else if (strategy === 'boll') {
      p.period = number(p.period, 20, 'period', 2, 1000, true);
      p.mult = number(p.mult, 2, 'mult', 0.01, 10);
    } else if (strategy === 'turtle') {
      p.entryPeriod = number(p.entryPeriod, 20, 'entryPeriod', 2, 1000, true);
      p.exitPeriod = number(p.exitPeriod, 10, 'exitPeriod', 2, 1000, true);
      p.atrPeriod = number(p.atrPeriod, 20, 'atrPeriod', 2, 1000, true);
      p.riskPct = number(p.riskPct, 2, 'riskPct', 0.01, 100);
    } else if (strategy === 'grid') {
      if (p.base != null && p.base !== '') p.base = number(p.base, null, 'base', 0.000001, 1e10);
      else delete p.base;
      p.step = number(p.step, 5, 'step', 0.01, 100);
      p.gridDown = number(p.gridDown, 5, 'gridDown', 1, 100, true);
      p.gridUp = number(p.gridUp, 5, 'gridUp', 1, 100, true);
      p.lotBuy = number(p.lotBuy, 1, 'lotBuy', 1, 1000000, true);
    }
    return { p, o };
  }
  function prepare(input) {
    if (!Array.isArray(input) || input.length === 0) throw new Error('At least one OHLC bar is required');
    let lastTime = '';
    return input.map((d, i) => {
      if (!d || typeof d.time !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(d.time) || !Number.isFinite(Date.parse(d.time)) || new Date(d.time).toISOString().slice(0,10) !== d.time)
        throw new Error('Bar ' + i + ' requires an ISO date in time');
      if (d.time <= lastTime) throw new Error('Bars must have unique dates in ascending order');
      lastTime = d.time;
      const b = Object.assign({}, d);
      for (const k of ['open', 'high', 'low', 'close']) b[k] = number(d[k], NaN, 'bar.' + k, 0.0000001, 1e12);
      if (b.low > Math.min(b.open, b.close) + 1e-8 || b.high < Math.max(b.open, b.close) - 1e-8 || b.high < b.low)
        throw new Error('Invalid OHLC range at ' + d.time);
      if (d.volume != null) b.volume = number(d.volume, 0, 'volume', 0, 1e18);
      return b;
    });
  }
  function sma(xs, n) {
    const out = Array(xs.length).fill(null); let sum = 0;
    for (let i = 0; i < xs.length; i++) { sum += xs[i]; if (i >= n) sum -= xs[i - n]; if (i >= n - 1) out[i] = sum / n; }
    return out;
  }
  function tdSignals(data) {
    const out = Array.from({length: data.length}, () => ({setupBuy: 0, setupSell: 0, cdBuy: 0, cdSell: 0, signal: null}));
    let sb = 0, ss = 0, activeBuy = false, activeSell = false, cb = 0, cs = 0;
    for (let i = 0; i < data.length; i++) {
      if (i >= 4) {
        if (data[i].close < data[i - 4].close) { sb = Math.min(sb + 1, 9); ss = 0; }
        else if (data[i].close > data[i - 4].close) { ss = Math.min(ss + 1, 9); sb = 0; }
        else { sb = 0; ss = 0; }
      }
      const r = out[i]; r.setupBuy = activeBuy ? 0 : sb; r.setupSell = activeSell ? 0 : ss;
      if (sb === 9 && !activeBuy) { activeBuy = true; cb = 0; r.signal = 'buy9'; }
      if (ss === 9 && !activeSell) { activeSell = true; cs = 0; r.signal = (r.signal ? r.signal + '+' : '') + 'sell9'; }
      if (activeBuy && i >= 2 && data[i].close <= data[i - 2].low) { r.cdBuy = ++cb; if (cb === 13) { r.signal = 'buy13'; activeBuy = false; cb = 0; } }
      if (activeSell && i >= 2 && data[i].close >= data[i - 2].high) { r.cdSell = ++cs; if (cs === 13) { r.signal = (r.signal ? r.signal + '+' : '') + 'sell13'; activeSell = false; cs = 0; } }
      if (ss >= 9 && activeBuy) { activeBuy = false; cb = 0; }
      if (sb >= 9 && activeSell) { activeSell = false; cs = 0; }
    }
    return out;
  }
  function metrics(equity, trades, initialCash, benchmarkStart, lastClose, rf) {
    const finalVal = equity.length ? equity[equity.length - 1].value : initialCash;
    let peak = initialCash, maxDrawdown = 0, prior = initialCash;
    const daily = equity.map(e => { peak = Math.max(peak, e.value); maxDrawdown = Math.max(maxDrawdown, (peak - e.value) / peak * 100); const r = e.value / prior - 1; prior = e.value; return r; });
    const excess = daily.map(r => r - (Math.pow(1 + rf, 1 / 252) - 1));
    const mean = excess.reduce((a, b) => a + b, 0) / (excess.length || 1);
    const variance = excess.length > 1 ? excess.reduce((s, v) => s + (v - mean) ** 2, 0) / (excess.length - 1) : 0;
    const sharpe = variance > 0 ? mean / Math.sqrt(variance) * Math.sqrt(252) : 0;
    const totalReturn = (finalVal / initialCash - 1) * 100;
    const annualizedReturn = equity.length ? (Math.pow(finalVal / initialCash, 252 / equity.length) - 1) * 100 : 0;
    return { totalReturn, annualizedReturn, maxDrawdown, sharpe, winRate: trades.length ? trades.filter(t => t.profit > 0).length / trades.length * 100 : 0,
      tradeCount: trades.length, buyAndHold: benchmarkStart ? (lastClose / benchmarkStart - 1) * 100 : 0, dailyReturns: daily };
  }
  // One signal function serves both historical execution and manual-position plans.
  function signalOrders(data,strategy,p,state,initialCash,lotSize,i,start,cache) {
    const shares=state.shares,cash=state.cash,close=cache.close||data.map(b=>b.close);
    function gridLevels() {return Array.from({length:p.gridDown+p.gridUp+1},(_,g)=>state.base*Math.pow(1+p.step/100,g-p.gridDown));}
      const b=data[i],price=b.close,orders=[];
      if(b.volume===0||b.complete===false||b.closed===false)return orders;
      const add=order=>orders.push(Object.assign({signalDate:b.time},order));
      const buy=(budget,reason,qty)=>add({side:'buy',budget,reason,qty});
      const sell=(reason,extra)=>add(Object.assign({side:'sell',all:true,reason},extra));
      if(strategy==='mr'&&cache.allSMA[i]!=null) {
        const avg=state.avgCost;
        if(shares&&price<=avg*(1-p.stopLoss/100))sell('stop');
        else {
          if(shares)for(let t=0;t<3;t++)if(!state.tpHits[t]&&price>=avg*(1+p[['tp1','tp2','tp3'][t]]/100))sell('tp'+(t+1),{all:t===2,fraction:1/(3-t),tpIndex:t});
          if(!orders.length&&state.batchesBought<p.batches&&price<=cache.allSMA[i]*(1-(p.threshold+state.batchesBought*10)/100))buy(initialCash/p.batches,'mr-batch');
        }
      } else if(strategy==='ma'&&i>0&&cache.maLong[i-1]!=null) {
        if(!shares&&cache.maShort[i-1]<=cache.maLong[i-1]&&cache.maShort[i]>cache.maLong[i])buy(cash*0.95,'cross-up');
        else if(shares&&cache.maShort[i-1]>=cache.maLong[i-1]&&cache.maShort[i]<cache.maLong[i])sell('cross-down');
      } else if(strategy==='turtle'&&i>=Math.max(p.entryPeriod,p.exitPeriod)&&cache.atr[i]!=null) {
        const high=Math.max(...data.slice(i-p.entryPeriod,i).map(d=>d.high)),low=Math.min(...data.slice(i-p.exitPeriod,i).map(d=>d.low));
        if(!shares&&price>high&&cache.atr[i]>0)buy(cash,'breakout',(cash+shares*price)*p.riskPct/100/cache.atr[i]);
        else if(shares&&price<low)sell('channel-exit');
      } else if(strategy==='boll'&&i>=p.period) {
        const xs=close.slice(i-p.period,i),mean=xs.reduce((a,b)=>a+b,0)/p.period,std=Math.sqrt(xs.reduce((s,x)=>s+(x-mean)**2,0)/p.period);
        if(!shares&&price<=mean-p.mult*std)buy(cash*0.95,'lower-band');
        else if(shares&&price>=mean+p.mult*std)sell('upper-band');
      } else if(strategy==='td') {
        const s=cache.td[i].signal||'';
        if(!shares&&s.includes('buy'))buy(cash*0.95,s.includes('buy13')?'buy13':'buy9');
        else if(shares&&s.includes('sell'))sell(s.includes('sell13')?'sell13':'sell9');
      } else if(strategy==='grid') {
        const previous=i===start?data[start].open:data[i-1].close;
        const levels=gridLevels();
        for(let g=0;g<p.gridDown;g++)if(previous>=levels[g]&&price<levels[g])buy(cash,'grid-buy',p.lotBuy*lotSize);
        if(shares)for(let g=p.gridDown+1;g<levels.length;g++)if(previous<=levels[g]&&price>levels[g]) { sell('grid-sell',{all:false,qty:p.lotBuy*lotSize});break; }
      }
      return orders;
  }
  function run(input, strategy, params, options) {
    const normalized = normalize(strategy, params || {}, options || {}), p = normalized.p, o = normalized.o;
    const data = prepare(input), close = data.map(d => d.close), warnings = [];
    function warn(message) { if (!warnings.includes(message)) warnings.push(message); }
    warn('日线信号在下一根可评价 K 线开盘撮合；挂单仅该日有效。滑点、涨跌停判断和复权资金账本属于简化模型，不代表实盘保证成交。');
    warn('复权价格适合研究收益，未单独模拟分红现金、送转股及历史规则变化；实盘股数与条件价应使用真实价格和持仓。');
    if (data.some(d => d.volume == null)) warn('部分数据缺少成交量，无法排除全部停牌或流动性不足情形。');
    if (strategy === 'td') warn('TD 使用本项目简化的 Setup/Countdown 规则，不包含完整商业 TD 指标规则。');
    if (strategy === 'turtle') warn('海龟仓位按 ATR 计算；十日低点退出及跳空不保证单笔损失受风险比例限制。');
    let start = o.startIndex == null ? 0 : number(o.startIndex, 0, 'startIndex', 0, data.length - 1, true);
    let end = o.endIndex == null ? data.length - 1 : number(o.endIndex, data.length - 1, 'endIndex', 0, data.length - 1, true);
    function validDate(value) {return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;}
    if (o.start != null) { if (!validDate(o.start)) throw new Error('start requires a valid YYYY-MM-DD date'); while (start <= end && data[start].time < o.start) start++; }
    if (o.end != null) { if (!validDate(o.end)) throw new Error('end requires a valid YYYY-MM-DD date'); while (end >= start && data[end].time > o.end) end--; }
    if (start > end) throw new Error('No bars in the evaluation interval');
    let cash = o.initialCash, shares = 0, lots = [], cycle = null, cycleSeq = 0;
    const fills = [], trades = [], equity = [], skippedOrders = [];
    const state = { batchesBought: 0, tpHits: [false, false, false], base: p.base || data[start].open, pendingOrders: [] };
    const allSMA = strategy === 'mr' ? sma(close, p.smaPeriod) : null;
    const maShort = strategy === 'ma' ? sma(close, p.shortN) : null, maLong = strategy === 'ma' ? sma(close, p.longN) : null;
    const td = strategy === 'td' ? tdSignals(data) : null;
    const atr = strategy === 'turtle' ? sma(data.map((b,i) => i ? Math.max(b.high - b.low, Math.abs(b.high - close[i-1]), Math.abs(b.low - close[i-1])) : b.high-b.low), p.atrPeriod) : null;
    let pending = [], holdPlaced = false;
    const roundLot = qty => Math.floor((qty + 1e-10) / o.lotSize) * o.lotSize;
    const averageCost = () => shares ? lots.reduce((s,l) => s+l.cost,0)/shares : 0;
    const sellable = i => lots.filter(l => l.acquiredIndex < i).reduce((s,l) => s+l.qty,0);
    function commission(gross) { return gross > 0 ? Math.max(o.minCommission, gross * o.commissionRate) : 0; }
    function gridLevels() { return Array.from({length:p.gridDown+p.gridUp+1},(_,g)=>state.base*Math.pow(1+p.step/100,g-p.gridDown)); }
    function skip(order, b, reason) { skippedOrders.push({time:b.time, signalDate:order.signalDate, side:order.side, reason}); warn(reason); }
    function execute(order, i) {
      const b = data[i];
      if (b.volume === 0) { skip(order,b,'成交量为零，当日委托不成交。'); return; }
      const prev = i ? data[i-1].close : null;
      const locked = Math.abs(b.high - b.low) <= Math.max(1e-8,b.close*1e-8);
      const up = prev && b.open / prev - 1 >= o.limitPct / 100 * 0.97;
      const down = prev && 1 - b.open / prev >= o.limitPct / 100 * 0.97;
      const explicitUp = b.limitUp != null && b.open >= Number(b.limitUp)-1e-8;
      const explicitDown = b.limitDown != null && b.open <= Number(b.limitDown)+1e-8;
      if (locked && ((order.side === 'buy' && (up || explicitUp)) || (order.side === 'sell' && (down || explicitDown)))) {
        skip(order,b,'一字涨跌停按保守模型拒绝不利方向成交；不同板块请配置 limitPct。'); return;
      }
      const price = b.open * (1 + (order.side === 'buy' ? 1 : -1) * o.slippageBps / 10000);
      if (order.side === 'buy') {
        const budget = Math.min(cash, order.budget == null ? cash : order.budget);
        let qty = roundLot(Math.min(order.qty == null ? Infinity : order.qty, budget / price));
        // Binary search lot count makes minimum commissions affordable without
        // per-lot loops when allocations are large.
        let lo=0, hi=Math.max(0,Math.floor(qty/o.lotSize));
        while(lo<hi) { const mid=Math.ceil((lo+hi)/2), g=mid*o.lotSize*price; if(g+commission(g)<=budget+1e-8)lo=mid;else hi=mid-1; }
        qty=lo*o.lotSize;
        if (!qty) { skip(order,b,'可用资金不足一手及费用，买单未成交。'); return; }
        const gross = qty*price, fee=commission(gross), cost=gross+fee;
        if (!cycle) cycle={id:++cycleSeq,entryDate:b.time,entrySignal:order.reason,boughtQty:0,soldQty:0,buyGross:0,buyCost:0,sellGross:0,sellNet:0,realizedProfit:0,fillIds:[]};
        cash-=cost; if(cash<0&&cash>-1e-7)cash=0; shares+=qty;
        lots.push({qty,cost,acquiredIndex:i,date:b.time,price});
        cycle.boughtQty+=qty;cycle.buyGross+=gross;cycle.buyCost+=cost;
        const f={id:fills.length+1,cycleId:cycle.id,type:'buy',side:'buy',date:b.time,time:b.time,signalDate:order.signalDate,price,openPrice:b.open,qty,shares:qty,gross,commission:fee,stampTax:0,fees:fee,cashFlow:-cost,reason:order.reason};
        fills.push(f);cycle.fillIds.push(f.id);
        if(strategy==='mr')state.batchesBought++;
        return;
      }
      const available=sellable(i), requested=order.all?shares:roundLot(order.fraction != null?shares*order.fraction:order.qty);
      let qty=Math.min(requested,available);
      if(!order.all)qty=roundLot(qty);
      if(qty<=0) { skip(order,b,'没有符合 T+1 规则的可卖数量，卖单未成交。');return; }
      const gross=qty*price, fee=commission(gross), tax=gross*o.stampTaxRate, net=gross-fee-tax;
      if(cash+net < -1e-8) {skip(order,b,'卖出价款与可用现金不足支付费用，卖单未成交。');return;}
      let remaining=qty,basis=0;
      for(const lot of lots) { if(lot.acquiredIndex>=i||!remaining)continue;const take=Math.min(lot.qty,remaining),allocated=lot.cost*take/lot.qty;lot.qty-=take;lot.cost-=allocated;remaining-=take;basis+=allocated; }
      lots=lots.filter(l=>l.qty>0);shares-=qty;cash+=net;
      const profit=net-basis;
      cycle.soldQty+=qty;cycle.sellGross+=gross;cycle.sellNet+=net;cycle.realizedProfit+=profit;
      const f={id:fills.length+1,cycleId:cycle.id,type:'sell',side:'sell',date:b.time,time:b.time,signalDate:order.signalDate,price,openPrice:b.open,qty,shares:qty,gross,commission:fee,stampTax:tax,fees:fee+tax,cashFlow:net,costBasis:basis,profit,pnl:basis?profit/basis*100:0,reason:order.reason};
      fills.push(f);cycle.fillIds.push(f.id);
      if(order.tpIndex!=null)state.tpHits[order.tpIndex]=true;
      if(strategy==='grid')state.base=shares?averageCost():price;
      if(!shares) {
        trades.push({id:cycle.id,entryDate:cycle.entryDate,exitDate:b.time,entryPrice:cycle.buyGross/cycle.boughtQty,exitPrice:cycle.sellGross/cycle.soldQty,
          entrySignal:cycle.entrySignal,exitSignal:order.reason,type:order.reason,shares:cycle.boughtQty,batches:state.batchesBought,
          pnl:(cycle.sellNet-cycle.buyCost)/cycle.buyCost*100,profit:cycle.sellNet-cycle.buyCost,buyCost:cycle.buyCost,sellNet:cycle.sellNet,
          fillIds:cycle.fillIds.slice(),holding:false});
        cycle=null;state.batchesBought=0;state.tpHits=[false,false,false];
      }
    }
    function signal(i) {
      return signalOrders(data,strategy,p,Object.assign({},state,{shares,cash,avgCost:averageCost()}),o.initialCash,o.lotSize,i,start,{allSMA,maShort,maLong,atr,td,close});
    }

    // The last pre-start close may prepare the first evaluation day's order,
    // without ever trading or scoring a pre-start day.
    if(start>0&&strategy!=='grid'&&strategy!=='hold')pending=signal(start-1);
    for(let i=start;i<=end;i++) {
      if(strategy==='hold'&&!holdPlaced) pending=[{side:'buy',budget:o.initialCash,reason:'initial-allocation',signalDate:null}];
      for(const order of pending)execute(order,i);
      if(strategy==='hold'&&shares>0)holdPlaced=true;
      equity.push({time:data[i].time,value:cash+shares*data[i].close,cash,shares,sellableShares:sellable(i)});
      pending=strategy==='hold'?[]:signal(i);
    }
    const finalPrice=data[end].close,finalVal=cash+shares*finalPrice,cost=lots.reduce((s,l)=>s+l.cost,0);
    const holding=shares?{shares,quantity:shares,sellableShares:sellable(end),avgCost:cost/shares,marketValue:shares*finalPrice,costBasis:cost,
      unrealizedProfit:shares*finalPrice-cost,realizedProfit:cycle.realizedProfit,entryDate:cycle.entryDate,fillIds:cycle.fillIds.slice()}:null;
    state.pendingOrders=pending.map(x=>Object.assign({},x));
    state.shares=shares;state.cash=cash;state.sellableShares=sellable(end);state.avgCost=shares?cost/shares:0;
    state.lastTime=data[end].time;state.lastPrice=finalPrice;
    if(!fills.length)warn('评价区间没有成交；请检查指标预热、策略信号、资金和交易约束。');
    const stats=metrics(equity,trades,o.initialCash,data[start].open,finalPrice,o.riskFreeRate);
    return Object.assign(stats,{strategy,params:p,config:o,initialCash:o.initialCash,equity,trades,fills,finalShares:shares,finalCash:cash,finalVal,
      shares,cash,holding,currentState:state,warnings,skippedOrders,levels:strategy==='grid'?gridLevels():[],
      gridParams:strategy==='grid'?Object.assign({},p,{base:state.base}):undefined,tdSignals:td||undefined,
      buyCount:fills.filter(f=>f.side==='buy').length,sellCount:fills.filter(f=>f.side==='sell').length,
      totalFees:fills.reduce((s,f)=>s+f.fees,0),start:data[start].time,end:data[end].time,signalTiming:'closed-bar-next-open',
      benchmarkDescription:'价格基准：评价首日开盘至末日收盘，不含费用；组合比较请用相同资金的 hold 回测。'});
  }
  function plan(input,strategy,params,position,options) {
    position=position||{};
    const {p,o}=normalize(strategy,params||{},options||{});
    if(!Array.isArray(input))throw new Error('请先加载日线');
    const data=prepare(input.filter(b=>b.complete!==false&&b.closed!==false)),i=data.length-1,last=data[i],close=data.map(b=>b.close);
    const cash=number(position.cash,NaN,'实际可用资金',0,1e14),shares=number(position.quantity,0,'实际持仓股数',0,1e12,true);
    const available=number(position.sellableQty,0,'实际可卖股数',0,shares,true),avgCost=number(position.avgCost,0,'实际平均成本',0,1e10);
    if(shares&&avgCost<=0)throw new Error('已有持仓时请先录入真实平均成本');
    let capital=o.initialCash,batchesBought=0,tpHits=[false,false,false];
    if(strategy==='mr') {
      capital=number(position.strategyCapital,NaN,'该策略原定总预算',0.01,1e14);
      if(shares) {
        if(position.batchesBought==null||position.batchesBought==='')throw new Error('请确认本轮已完成买入批数，不能从平均成本推断');
        if(position.tpStage==null||position.tpStage==='')throw new Error('请确认本轮已执行止盈阶段，避免重复卖出');
        batchesBought=number(position.batchesBought,NaN,'本轮已买批数',1,p.batches,true);
        const stage=number(position.tpStage,NaN,'已执行止盈阶段',0,2,true);tpHits=tpHits.map((_,t)=>t<stage);
      }
    }
    let base=last.close;
    if(strategy==='grid')base=number(position.base,avgCost||NaN,'当前网格基准',0.000001,1e10);
    const needed=strategy==='mr'?p.smaPeriod:strategy==='ma'?p.longN+1:strategy==='boll'?p.period+1:strategy==='turtle'?Math.max(p.entryPeriod,p.exitPeriod,p.atrPeriod)+1:strategy==='td'?13:2;
    if(data.length<needed)throw new Error('该策略需要至少 '+needed+' 根已完成日线');
    const cache={close,allSMA:strategy==='mr'?sma(close,p.smaPeriod):null,maShort:strategy==='ma'?sma(close,p.shortN):null,maLong:strategy==='ma'?sma(close,p.longN):null,
      td:strategy==='td'?tdSignals(data):null,atr:strategy==='turtle'?sma(data.map((b,j)=>j?Math.max(b.high-b.low,Math.abs(b.high-close[j-1]),Math.abs(b.low-close[j-1])):b.high-b.low),p.atrPeriod):null};
    const state={shares,cash,avgCost,base,batchesBought,tpHits},rawOrders=signalOrders(data,strategy,p,state,capital,o.lotSize,i,0,cache);
    const fees=g=>g?Math.max(o.minCommission,g*o.commissionRate):0,round=n=>Math.floor((n+1e-10)/o.lotSize)*o.lotSize;
    let remainingCash=cash,remainingShares=shares,remainingSellable=available;
    const orders=rawOrders.map(order=>{
      const referencePrice=last.close*(1+(order.side==='buy'?1:-1)*o.slippageBps/10000);
      if(order.side==='buy') {
        const budget=Math.min(remainingCash,order.budget==null?remainingCash:order.budget);
        let lo=0,hi=Math.floor(Math.min(order.qty==null?Infinity:order.qty,budget/referencePrice)/o.lotSize);
        while(lo<hi) {const m=Math.ceil((lo+hi)/2),g=m*o.lotSize*referencePrice;if(g+fees(g)<=budget+1e-8)lo=m;else hi=m-1;}
        const qty=lo*o.lotSize,gross=qty*referencePrice,reserve=gross+fees(gross);remainingCash-=reserve;
        return Object.assign({},order,{qty,enabled:qty>0,budget,quantityCap:order.qty==null?null:round(order.qty),referencePrice,referenceCash:reserve,quantityRule:'开盘按该档剩余预算、真实开盘价及费用重新向下取整，并受策略数量上限限制；此处不是保证成交股数'});
      }
      const requested=order.all?remainingShares:round(order.fraction!=null?remainingShares*order.fraction:order.qty);
      let qty=Math.min(requested,remainingSellable);if(!order.all)qty=round(qty);
      const gross=qty*referencePrice,net=gross-fees(gross)-gross*o.stampTaxRate;
      if(remainingCash+net < -1e-8)qty=0;
      remainingShares-=qty;remainingSellable-=qty;
      return Object.assign({},order,{qty,enabled:qty>0,sellableCap:qty,referencePrice,referenceCash:qty?net:0,quantityRule:'执行前重新核对券商可卖数量；各阶段顺序扣减，不能重复占用同一持仓'});
    });
    const rules=[];
    if(strategy==='mr') {
      const m=cache.allSMA[i];
      if(batchesBought<p.batches)rules.push('下一买入批为第 '+(batchesBought+1)+' 批：收盘价 ≤ 当日 SMA'+p.smaPeriod+' × '+(1-(p.threshold+batchesBought*10)/100).toFixed(4)+'（当前阈值 '+(m*(1-(p.threshold+batchesBought*10)/100)).toFixed(2)+' 元）；每批预算取原定总预算/'+p.batches+'，并受实际剩余现金限制。');
      else rules.push('本轮买入批数已满，停止追加；清仓后才能开始新一轮。');
      if(shares)rules.push('先检查收盘止损 ≤ '+(avgCost*(1-p.stopLoss/100)).toFixed(2)+' 元；再依次检查尚未执行的止盈 '+[p.tp1,p.tp2,p.tp3].map((v,t)=>tpHits[t]?'已完成':(avgCost*(1+v/100)).toFixed(2)+' 元').join(' / ')+'。有卖出信号时不同时加仓。');
    } else if(strategy==='ma')rules.push('空仓且短均线从 ≤ 长均线变为 > 时，使用可用现金95%买入；持仓且从 ≥ 变为 < 时退出。多头排列本身不是一次新的金叉。');
    else if(strategy==='td')rules.push('使用本项目同一套简化 TD 算法：做多9/13且空仓时使用现金95%买入；做空9/13且持仓时退出。');
    else if(strategy==='boll')rules.push('当日收盘与此前 '+p.period+' 根收盘计算的布林带比较；空仓触下轨使用现金95%买入，持仓触上轨退出。');
    else if(strategy==='turtle')rules.push('当日收盘突破此前 '+p.entryPeriod+' 日高点且空仓时，按 ATR 与可用现金限额定仓；跌破此前 '+p.exitPeriod+' 日低点退出。ATR定仓不保证最大亏损。');
    else if(strategy==='grid')rules.push('以手动基准 '+base.toFixed(2)+' 元比较相邻两根已完成收盘价：向下穿越基准下方格线才买入；向上穿越基准上方格线时最多卖出一档（'+p.lotBuy+'手）。一根日线跨多档可产生多笔买单，但只会有一档卖单。成交后按剩余实际成本更新基准；清仓后使用实际卖出价重新生成。');
    const warnings=['本计划采用收盘确认 → 下一交易日开盘模型。盘中碰到价格并不等于日线信号；券商盘中触价单无法直接代替本规则。',
      '股数按最新已完成收盘价及费用估算；开盘跳空后必须重新校验预算、可卖数量及成交条件。当前可卖数量作为保守上限，不预支次日解禁数量。',
      '执行日是信号日之后的第一个交易日；若其开盘已过，该开盘计划已过期，不能自动顺延或追单。每次成交或持仓变化后重新生成。',
      '平均成本、持仓与策略阶段来自手动录入，不能由历史回测推断；如果网格基准刚刚修改，应从修改后的新日线开始观察，不追溯执行旧穿越。'];
    return {strategy,params:p,config:o,asOf:last.time,referenceClose:last.close,orders,rules,warnings,position:{cash,quantity:shares,sellableQty:available,avgCost},currentState:state,
      signalTiming:'closed-bar-next-open',budgetRemaining:remainingCash,sellableRemaining:remainingSellable};
  }
  return { run, plan, defaults: DEFAULTS, strategies: STRATEGIES, calcTDSequential: tdSignals, version: '1.1.0' };
});
