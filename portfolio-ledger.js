// A shared-cash, unadjusted-price portfolio. Configuration is never a brokerage order.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(() => require('./historical-rules.js'), () => require('./corporate-actions.js'));
  else root.StockPortfolioLedger = factory(() => root.StockHistoricalRules, () => root.StockCorporateActions);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (ruleAPI, actionAPI) {
  'use strict';
  const error = text => { throw new Error(text); };
  const money = x => Math.round((x + Number.EPSILON) * 100) / 100;
  function num(x, label, minimum = 0, maximum = 1e12, integer = false) {
    if (typeof x !== 'number' || !Number.isFinite(x) || x < minimum || x > maximum || (integer && !Number.isSafeInteger(x))) error(label + ' 数值无效');
    return x;
  }
  function date(x) {
    if (typeof x !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(x) || !Number.isFinite(Date.parse(x + 'T00:00:00Z')) || new Date(x + 'T00:00:00Z').toISOString().slice(0, 10) !== x) error('日期无效');
    return x;
  }
  function prepare(spec) {
    if (!spec || !['shares', 'allocation'].includes(spec.mode)) error('账本模式应为已有股数或初始分配');
    const start = date(spec.start), end = date(spec.end), balance = spec.rebalance || 'none';
    if (end < start || !['none', 'monthly', 'quarterly'].includes(balance)) error('日期或调仓频率无效');
    const cash = num(spec.initialCash ?? 0, '现金', spec.mode === 'allocation' ? 0.01 : 0);
    if (!Array.isArray(spec.assets) || !spec.assets.length || spec.assets.length > 20) error('账本需要 1 至 20 只股票');
    const assets = [], dates = new Set(), maps = {}, books = {}, warnings = new Set(), options = spec.executionOptions || {};
    const commissionRate = num(options.commissionRate ?? 0.0003, '佣金', 0, 0.05), minCommission = num(options.minCommission ?? 5, '最低佣金', 0, 10000), slippage = num(options.slippageBps ?? 5, '滑点基点', 0, 1000);
    for (const input of spec.assets) {
      const s = input?.symbol;
      if (typeof s !== 'string' || !/^(sh|sz)\d{6}$/.test(s) || maps[s]) error('证券代码无效或重复');
      if (input.strategy && input.strategy !== 'hold') error('真实组合账本只模拟持有与目标权重调仓，不执行成分技术策略');
      const qty = spec.mode === 'shares' ? num(input.quantity ?? 0, '起始股数', 0, 1e12, true) : 0;
      const sellable = spec.mode === 'shares' ? num(input.sellableQty ?? qty, '起始可卖股数', 0, qty, true) : 0;
      const weight = input.weight == null ? null : num(input.weight, '目标权重', 0, 100);
      if (spec.mode === 'allocation' && weight === null) error('初始分配需要各股明确的目标权重');
      const pack = spec.barsBySymbol?.[s];
      if (!pack || pack.meta?.adjustment !== 'raw' || (pack.meta.adjust != null && pack.meta.adjust !== 'raw') || pack.meta.symbol !== s || pack.meta.corporateActionsIncluded === true || !Array.isArray(pack.bars)) error(s + ' 缺少有明确标记的不复权原始行情，拒绝重复计入复权收益');
      ruleAPI().boardOf(s);
      const map = new Map();
      for (const b of pack.bars) {
        const d = date(b.time);
        if (map.has(d)) error(s + ' 重复日线 ' + d);
        for (const k of ['open', 'high', 'low', 'close']) num(b[k], s + ' ' + k, 1e-7);
        if (b.low > Math.min(b.open, b.close) || b.high < Math.max(b.open, b.close)) error(s + ' OHLC 无效');
        if (b.volume != null) num(b.volume, '成交量', 0, 1e18);
        map.set(d, b);
        if (d >= start && d <= end) dates.add(d);
      }
      if (!map.size) error(s + ' 没有日线');
      maps[s] = map;
      const supplied = spec.booksBySymbol?.[s];
      let builtIn = null;
      if (supplied) { try { builtIn = actionAPI().getBook(s, start, end); } catch (_) { /* explicit user book may cover a different interval */ } }
      else builtIn = actionAPI().getBook(s, start, end);
      const book = supplied || builtIn;
      const verified = actionAPI().validateBook(book);
      if (verified.symbol !== s || verified.coverageStart > start || verified.coverageEnd < end ||
          (book.start && book.start > start) || (book.end && book.end < end)) error(s + ' 公司行为没有覆盖完整账本区间');
      // A public caller cannot make a manual book official by setting verified:true.
      const filingChecked = !!builtIn && book.status !== 'user-supplied' &&
        JSON.stringify(verified) === JSON.stringify(actionAPI().validateBook(builtIn));
      books[s] = Object.assign({}, verified, { verified: filingChecked, status: filingChecked ? 'filing-checked' : 'user-supplied' });
      if (!books[s].verified) warnings.add(s + ' 公司行为覆盖由导入者声明，未由系统独立核实。');
      assets.push({ symbol: s, name: input.name || s, qty, sellable, weight });
    }
    assets.sort((a, b) => a.symbol.localeCompare(b.symbol));
    const weightTotal = assets.reduce((sum, a) => sum + (a.weight ?? 0), 0);
    if (spec.mode === 'allocation' || balance !== 'none') {
      if (weightTotal > 100 + 1e-9) error('目标权重之和超过 100%');
      if (assets.some(a => a.weight == null) && assets.some(a => a.weight != null)) error('请填写所有目标权重，或全部留空按初始市值占比');
      if (spec.mode === 'allocation' && weightTotal <= 0) error('初始分配权重不能全为零');
    }
    const providedCalendar = spec.calendar || options.calendar;
    if (providedCalendar) {
      if (!Array.isArray(providedCalendar)) error('交易日历须为日期数组');
      const expected = new Set(providedCalendar.map(date).filter(d => d >= start && d <= end));
      if ([...dates].some(d => !expected.has(d)) || [...expected].some(d => !dates.has(d))) error('交易日历和行情日期不一致，拒绝补造行情');
    } else warnings.add('未提供独立交易日历；仅能发现成分股票之间不一致的日期缺口。');
    const days = [...dates].sort();
    if (!days.length) error('区间没有行情');
    if (days[0] < ruleAPI().coverageStart || days.at(-1) > ruleAPI().coverageEnd) error('所选日期超出已核验历史交易规则覆盖');
    for (const day of days) for (const a of assets) if (!maps[a.symbol].has(day)) error(a.symbol + ' 在 ' + day + ' 缺少日线，无法确认停牌或估值');
    const events = [], ids = new Set();
    for (const a of assets) for (const e of books[a.symbol].events) {
      const key = e.symbol + ':' + e.id;
      if (ids.has(key)) error('重复权益事件 ' + key);
      ids.add(key);
      // Record/ex dates are exchange sessions; no forward fill for missing dates.
      for (const d of [e.recordDate, e.exDate, e.shareListingDate].filter(Boolean)) {
        if (d >= start && d <= end && !dates.has(d)) error(e.symbol + ' 缺少权益日期日线 ' + d);
      }
      events.push(Object.assign({}, e, { key }));
    }
    return { spec, assets, days, maps, books, events, cash: money(cash), commissionRate, minCommission, slippage, warnings, balance, start, end };
  }
  function stats(equity, initialNAV) {
    let peak = initialNAV, drawdown = 0;
    for (const p of equity) {
      if (!Number.isFinite(p.value) || p.value < 0) error('净值无效');
      peak = Math.max(peak, p.value); drawdown = Math.max(drawdown, 100 * (peak - p.value) / peak);
    }
    const finalNAV = equity.at(-1).value, days = (Date.parse(equity.at(-1).time) - Date.parse(equity[0].time)) / 86400000;
    const annualized = days > 0 ? 100 * ((finalNAV / initialNAV) ** (365.25 / days) - 1) : null;
    return { initialNAV, finalNAV, totalReturn: 100 * (finalNAV / initialNAV - 1), annualized: Number.isFinite(annualized) ? annualized : null, maxDrawdown: drawdown };
  }
  function normalizeLot(qty, min, step) { const n = Math.floor(qty + 1e-9); return n < min ? 0 : min + Math.floor((n - min) / step) * step; }
  function period(d, mode) { return mode === 'monthly' ? d.slice(0, 7) : d.slice(0, 4) + '-Q' + Math.ceil(Number(d.slice(5, 7)) / 3); }
  function simulate(p, frequency) {
    const { spec, assets, days, maps, events } = p, first = days[0];
    let cash = p.cash, totalFees = 0, initialNAV, orderBatch = null;
    const pos = {}, targets = {}, initialMarked = {}, flow = {}, owned = new Map(), rights = new Map(), equity = [], fills = [], actions = [], eventLog = [], rebalances = [], skippedOrders = [], warnings = new Set(p.warnings);
    for (const a of assets) { pos[a.symbol] = { qty: a.qty, available: a.sellable }; flow[a.symbol] = 0; targets[a.symbol] = a.weight; }
    function eventInput(values, e) {
      if (!values) return undefined;
      if (Object.hasOwn(values, e.key)) return values[e.key];
      if (!Object.hasOwn(values, e.id)) return undefined;
      if (events.filter(v => v.id === e.id).length !== 1) error('跨股票权益编号重复，请以 股票代码:事件编号 指明录入值');
      return values[e.id];
    }
    function emit(time, event, phase, amount, qty) { eventLog.push({ time, id: event.id, symbol: event.symbol, phase, amount, quantity: qty }); }
    function recognize(e, eligible, day, carried) {
      if (eligible <= 0) return;
      const theoretical = eligible * e.sharesPerShare, rounded = Math.round(theoretical);
      let addedShares = rounded;
      if (Math.abs(theoretical - rounded) > 1e-7) {
        const supplied = eventInput(spec.allocatedSharesByEvent, e);
        if (!Number.isSafeInteger(supplied) || (supplied !== Math.floor(theoretical) && supplied !== Math.ceil(theoretical))) error(e.symbol + ' 送转产生零碎股，需填实际登记获配整数，不能擅自取整');
        addedShares = supplied; warnings.add(e.symbol + ' 零碎股采用手填实际登记数量。');
      }
      const cashAmount = money(eligible * e.cashPerShare);
      const r = { event: e, cash: carried && e.payDate <= day ? 0 : cashAmount, stock: carried && e.shareListingDate <= day ? 0 : addedShares };
      rights.set(e.key, r);
      actions.push(Object.assign({}, e, { eligibleShares: eligible, cashAmount, addedShares, carried }));
      emit(day, e, carried ? 'opening-entitlement' : 'ex-entitlement', r.cash, r.stock);
    }
    function settle(day, beforeOpen) {
      for (const r of rights.values()) {
        const e = r.event, s = e.symbol;
        if (beforeOpen && r.stock && e.shareListingDate <= day) {
          pos[s].qty += r.stock; pos[s].available += r.stock; emit(day, e, 'shares-listed', 0, r.stock); r.stock = 0;
        }
        // Only payments from an earlier date can finance today's opening trades.
        if (r.cash && (beforeOpen ? e.payDate < day : e.payDate <= day)) {
          cash = money(cash + r.cash); flow[s] = money(flow[s] + r.cash); emit(day, e, 'cash-paid', r.cash, 0); r.cash = 0;
        }
      }
    }
    function mark(day) {
      let value = cash, receivableCash = 0, pendingStockValue = 0;
      const holdings = {}, contributions = {}, sharesBySymbol = {};
      for (const a of assets) {
        const s = a.symbol, h = pos[s], close = maps[s].get(day).close;
        let pending = 0, receivable = 0;
        for (const r of rights.values()) if (r.event.symbol === s) { pending += r.stock; receivable = money(receivable + r.cash); }
        const mv = money(h.qty * close), pendingValue = money(pending * close), economic = money(mv + pendingValue + receivable);
        holdings[s] = { shares: h.qty, sellableQty: h.available, pendingShares: pending, close, marketValue: mv, receivableCash: receivable, pendingStockValue: pendingValue, economicValue: economic };
        sharesBySymbol[s] = h.qty; contributions[s] = economic;
        receivableCash = money(receivableCash + receivable); pendingStockValue = money(pendingStockValue + pendingValue); value = money(value + economic);
      }
      return { time: day, value, cash, receivableCash, pendingStockValue, holdings, contributions, sharesBySymbol };
    }
    function schedule(point, executionDate, type) {
      const orders = [];
      for (const a of assets) {
        const s = a.symbol, h = point.holdings[s], ideal = Math.floor(point.value * targets[s] / 100 / h.close + 1e-9);
        const delta = ideal - h.shares - h.pendingShares;
        if (delta) orders.push({ symbol: s, side: delta > 0 ? 'buy' : 'sell', requestedQty: Math.abs(delta), liquidate: ideal === 0 });
      }
      orderBatch = { type, signalDate: point.time, executionDate, orders, fillCount: 0 }; rebalances.push(orderBatch);
    }
    function execute(batch, day, prev) {
      const potential = [];
      const skip = (o, why, qty) => skippedOrders.push({ time: day, signalDate: batch.signalDate, symbol: o.symbol, side: o.side, quantity: qty ?? o.requestedQty, reason: why });
      for (const o of batch.orders) {
        const s = o.symbol, b = maps[s].get(day), oldClose = maps[s].get(prev).close;
        const ctx = Object.assign({}, spec.ruleContextBySymbol?.[s] || {}, spec.ruleContextByDate?.[s]?.[day] || {});
        const rule = ruleAPI().resolve(s, day, ctx);
        if (rule.warnings) for (const note of rule.warnings) warnings.add(note);
        const exs = events.filter(e => e.symbol === s && e.exDate === day);
        // A close-sized order is in pre-action units. Do not trade it through an ex day
        // without an exchange-provided ex-reference price and revised order terms.
        if (exs.length) { skip(o, '除权除息日：撤销前收盘旧口径指令，等待下一次调仓'); continue; }
        if (!(b.volume > 0)) { skip(o, '成交量为零或未知，无法确认开盘成交'); continue; }
        const band = ruleAPI().priceBands(rule, oldClose);
        if ((o.side === 'buy' && band.upper != null && b.open >= band.upper - 1e-9) ||
          (o.side === 'sell' && band.lower != null && b.open <= band.lower + 1e-9)) { skip(o, '开盘处于对应方向涨跌停价，保守不假定排队成交'); continue; }
        if ((band.upper != null && b.open > band.upper + 1e-9) || (band.lower != null && b.open < band.lower - 1e-9)) { skip(o, '行情开盘与已配置价格限制不一致'); continue; }
        // Execution depends on the opening print and statutory band only. No later high/low
        // is used to obtain a better fill or decide quantity. Slippage is a cost scenario.
        const rawPrice = money(b.open * (1 + (o.side === 'buy' ? 1 : -1) * p.slippage / 10000));
        const price = band.upper == null ? rawPrice : Math.max(band.lower, Math.min(rawPrice, band.upper));
        if (!(price > 0)) { skip(o, '模拟成交价非正'); continue; }
        let qty;
        if (o.side === 'buy') qty = ruleAPI().roundBuy(rule, o.requestedQty);
        else qty = ruleAPI().roundSell(rule, o.requestedQty, pos[s].available);
        if (!qty) { skip(o, '不足申报单位或无可卖股数'); continue; }
        potential.push({ o, s, qty, price, rule });
      }
      function costs(t, q) {
        const amount = money(q * t.price), commission = q ? money(Math.max(p.minCommission, amount * p.commissionRate)) : 0;
        const stampTax = t.o.side === 'sell' ? money(amount * t.rule.stampTaxRate) : 0, transferFee = money(amount * t.rule.transferFeeRate);
        return { amount, commission, stampTax, transferFee, totalFees: money(commission + stampTax + transferFee) };
      }
      function fill(t, q) {
        if (!q) { skip(t.o, '现金不足最低申报单位'); return; }
        const fee = costs(t, q), buy = t.o.side === 'buy', change = money((buy ? -1 : 1) * fee.amount - fee.totalFees);
        if (money(cash + change) < 0) { skip(t.o, '现金不足以支付成交及费用'); return; }
        cash = money(cash + change); flow[t.s] = money(flow[t.s] + change); totalFees = money(totalFees + fee.totalFees);
        pos[t.s].qty += buy ? q : -q; if (!buy) pos[t.s].available -= q;
        const openPrice = maps[t.s].get(day).open;
        fills.push(Object.assign({ time: day, signalDate: batch.signalDate, symbol: t.s, side: t.o.side, quantity: q, openPrice, price: t.price,
          slippageCost: money((buy ? 1 : -1) * (t.price - openPrice) * q) }, fee));
        batch.fillCount++; if (q < t.o.requestedQty) skip(t.o, '申报单位、可卖数量或组合现金上限，剩余不补单', t.o.requestedQty - q);
      }
      for (const t of potential.filter(t => t.o.side === 'sell')) fill(t, t.qty);
      const buys = potential.filter(t => t.o.side === 'buy');
      const qtyAt = (t, scale) => normalizeLot(t.qty * scale, t.rule.buyMin, t.rule.buyStep);
      const required = scale => buys.reduce((sum, t) => { const c = costs(t, qtyAt(t, scale)); return money(sum + c.amount + c.totalFees); }, 0);
      let scale = 1;
      if (required(1) > cash) {
        let lo = 0, hi = 1;
        for (let i = 0; i < 52; i++) { const mid = (lo + hi) / 2; if (required(mid) <= cash) lo = mid; else hi = mid; }
        scale = lo;
      }
      for (const t of buys) fill(t, qtyAt(t, scale));
    }
    // Starting shares and cash are an end-of-first-session snapshot. Settled pre-start
    // distributions are already in that snapshot; unresolved earlier rights need proof.
    for (const e of events) if (spec.mode === 'shares' && e.recordDate < first && [e.exDate, e.payDate || '', e.shareListingDate || ''].some(d => d > first)) {
      const q = eventInput(spec.openingEntitlements, e);
      if (q == null) error(e.symbol + ' 登记日在起点前且权益尚未结清；请把起点提早至登记日或补录登记日实际股数（可为0）');
      owned.set(e.key, num(q, '起点带入登记股数', 0, 1e12, true));
      if (e.exDate <= first) recognize(e, q, first, true);
    }
    for (let i = 0; i < days.length; i++) {
      const day = days[i];
      if (i > 0) {
        for (const a of assets) pos[a.symbol].available = pos[a.symbol].qty; // T+1 for prior buys; no synthetic trade on suspended bars.
        for (const e of events) if (e.exDate === day) recognize(e, owned.get(e.key) || 0, day, false);
        settle(day, true);
        if (orderBatch && orderBatch.executionDate === day) { execute(orderBatch, day, days[i - 1]); orderBatch = null; }
        settle(day, false);
      }
      for (const e of events) if (e.recordDate === day) { const q = pos[e.symbol].qty; owned.set(e.key, q); if (q) emit(day, e, 'record-close', 0, q); }
      const point = mark(day); equity.push(point);
      if (i === 0) {
        initialNAV = point.value; if (!(initialNAV > 0)) error('期初现金和持仓市值合计须为正数');
        for (const a of assets) { const s = a.symbol; initialMarked[s] = point.holdings[s].economicValue; if (targets[s] == null) targets[s] = 100 * point.holdings[s].marketValue / initialNAV; }
      }
      const next = days[i + 1];
      if (next && i === 0 && spec.mode === 'allocation') schedule(point, next, 'initial');
      else if (next && frequency !== 'none' && period(day, frequency) !== period(next, frequency)) schedule(point, next, frequency);
    }
    const last = equity.at(-1);
    const perAsset = assets.map(a => {
      const s = a.symbol, h = last.holdings[s], profit = money(h.economicValue - initialMarked[s] + flow[s]);
      return { symbol: s, name: a.name, strategy: 'portfolio-ledger', initialValue: initialMarked[s], finalValue: h.economicValue,
        finalShares: h.shares, sellableQty: h.sellableQty, pendingShares: h.pendingShares, receivableCash: h.receivableCash,
        netCashFlow: flow[s], profit, returnPct: null, contributionPct: 100 * profit / initialNAV };
    });
    if (Math.abs(money(perAsset.reduce((s, a) => s + a.profit, 0)) - money(last.value - initialNAV)) > 0.011) error('组合损益与成分贡献对账失败');
    return Object.assign(stats(equity, initialNAV), { equity, daily: equity, perAsset, fills, rebalances, actions, eventLog, skippedOrders,
      totalFees, finalCash: cash, receivableCash: last.receivableCash, pendingStockValue: last.pendingStockValue, notices: [...warnings] });
  }
  function calculate(spec) {
    const p = prepare(spec), main = simulate(p, p.balance), passive = p.balance === 'none' ? main : simulate(p, 'none');
    const baseline = Object.assign(stats(passive.equity, passive.initialNAV), { label: '同起点、同权益及费用，买入持有且不再调仓',
      equity: passive.equity.map(x => ({ time: x.time, value: x.value, cash: x.cash })), totalFees: passive.totalFees });
    return Object.assign(main, { mode: spec.mode, rebalance: p.balance, requestedStart: p.start, requestedEnd: p.end, actualStart: p.days[0], actualEnd: p.days.at(-1),
      actionCount: main.actions.length, baseline, meta: { adjustment: '不复权原价、税前现金红利及送转权益', coverage: p.books },
      caveats: ['期初按首个实际交易日收盘估值；初始分配和定期调仓均在收盘定股数、下个共同交易日开盘尝试。未分配权重保留现金。',
        '先卖后买；现金不足按同一比例缩减买单并按各板块申报单位取整，余款留现金。当日买入次个交易日可卖；起点不可卖数量仅模拟普通 T+1，不适用于长期冻结股份。',
        '登记日收盘锁定权益、除权日记应收与待上市股份、支付日收盘现金可用、上市日可卖。采用税前红利，未模拟个人持股期限补扣红利税、配股或重组。',
        '开盘涨停买入或跌停卖出、停牌、成交量未知，以及除权日旧委托不假定成交；滑点按开盘价与法定价限模拟，不代表实际排队或逐笔成交。',
        '成分损益含净买卖现金流、手续费与红利，贡献以期初组合总资产为分母；有调仓时成分“起末资产之比”不是单股投资回报。'] });
  }
  return Object.freeze({ calculate, version: '1.0.0' });
});
