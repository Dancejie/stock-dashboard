const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const Portfolio = require('../portfolio-engine.js');
const Quant = require('../quant-core.js');

const ZERO_COST = { commissionRate: 0, minCommission: 0, stampTaxRate: 0, slippageBps: 0, lotSize: 1 };
const day = n => new Date(Date.UTC(2024, 0, 1 + n)).toISOString().slice(0, 10);
const bar = (n, close, open = close) => ({ time: day(n), open, close, high: Math.max(open, close) * 1.01, low: Math.min(open, close) * .99, volume: 1000000 });
const data = prices => prices.map((p, i) => bar(i, p));
const near = (actual, expected, epsilon = 1e-8) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} != ${expected}`);
function spec(overrides = {}) {
  return Object.assign({ mode: 'allocation', initialCash: 100, start: day(0), end: day(2),
    assets: [{ symbol: 'A', weight: 60 }, { symbol: 'B', weight: 30 }],
    barsBySymbol: { A: data([10, 12, 9]), B: data([10, 9, 11]) }, executionOptions: ZERO_COST }, overrides);
}

test('unequal budgets are allocated once, remaining cash retained, contributions reconcile', () => {
  const r = Portfolio.calculate(spec());
  assert.deepEqual(r.equity.map(p => p.value), [100, 109, 97]);
  near(r.totalReturn, -3);
  assert.equal(r.unallocatedCash, 10);
  assert.equal(r.initialNAV, 100);
  assert.equal(r.perAsset[0].finalShares, 6);
  assert.equal(r.perAsset[1].finalShares, 3);
  near(r.perAsset.reduce((s, a) => s + a.contributionPct, 0), r.totalReturn);
  for (const p of r.equity) near(p.value, Object.values(p.contributions).reduce((s, v) => s + v, r.unallocatedCash));
});

test('fixed quantities imply their own market weights, independent of supplied weights and average costs', () => {
  const s = spec({ mode: 'shares', initialCash: 0,
    assets: [{ symbol: 'A', quantity: 2, weight: 99, avgCost: 1 }, { symbol: 'B', quantity: 5, weight: 1, avgCost: 100 }] });
  const r = Portfolio.calculate(s);
  assert.deepEqual(r.equity.map(p => p.value), [70, 69, 73]);
  near(r.totalReturn, 3 / 70 * 100);
  assert.equal(r.perAsset[0].finalShares, 2);
  assert.equal(r.perAsset[1].finalShares, 5);
  assert.ok(r.caveats.some(x => x.includes('未计分红')));
});

test('fixed-share initialCash is extra cash, never a second initial investment in the positions', () => {
  const r = Portfolio.calculate(spec({ mode: 'shares', initialCash: 30,
    assets: [{ symbol: 'A', quantity: 2 }, { symbol: 'B', quantity: 5 }] }));
  assert.deepEqual(r.equity.map(p => p.value), [100, 99, 103]);
});

test('no implicit daily rebalancing: 100 -> 160 -> 140, not 176', () => {
  const r = Portfolio.calculate(spec({ assets: [{ symbol: 'A', weight: 60 }, { symbol: 'B', weight: 40 }],
    barsBySymbol: { A: data([10, 20, 10]), B: data([10, 10, 20]) } }));
  assert.deepEqual(r.equity.map(p => p.value), [100, 160, 140]);
  near(r.totalReturn, 40);
  near(r.maxDrawdown, 12.5);
});

test('each account uses its actual budget and minimum fee: scaling a larger account is not equivalent', () => {
  const r = Portfolio.calculate(spec({ assets: [{ symbol: 'A', weight: 50 }, { symbol: 'B', weight: 50 }],
    barsBySymbol: { A: data([10, 11, 12]), B: data([10, 11, 12]) },
    executionOptions: { ...ZERO_COST, minCommission: 2 } }));
  assert.equal(r.perAsset[0].finalShares, 4);
  assert.equal(r.perAsset[1].finalShares, 4);
  assert.deepEqual(r.equity.map(p => p.value), [96, 104, 112]);
  near(r.totalReturn, 12);
  near(r.maxDrawdown, 4); // fees on the very first day count as a drawdown
  const one = Portfolio.calculate(spec({ assets: [{ symbol: 'A', weight: 100 }],
    barsBySymbol: { A: data([10, 11, 12]) }, executionOptions: { ...ZERO_COST, minCommission: 2 } }));
  assert.equal(one.perAsset[0].finalShares, 9);
  assert.equal(one.finalNAV, 116); // still holding: no invented final sell commission
});

test('A-share lot rounding and fee-inclusive affordability preserve the cash ledger', () => {
  const r = Portfolio.calculate(spec({ initialCash: 10000, assets: [{ symbol: 'A', weight: 100 }],
    barsBySymbol: { A: data([33, 33, 33]) }, executionOptions: { ...ZERO_COST, lotSize: 100, minCommission: 5 } }));
  assert.equal(r.perAsset[0].finalShares, 300);
  assert.equal(r.perAsset[0].finalCash, 95);
  assert.equal(r.finalNAV, 9995);
});

test('unaffordable asset never borrows from another allocation', () => {
  const r = Portfolio.calculate(spec({ assets: [{ symbol: 'A', weight: 90 }, { symbol: 'B', weight: 10 }],
    barsBySymbol: { A: data([10, 10, 10]), B: data([20, 20, 20]) } }));
  assert.equal(r.perAsset[1].finalShares, 0);
  assert.equal(r.perAsset[1].finalCash, 10);
  assert.equal(r.finalNAV, 100);
});

test('each allocation uses its symbol board limit default; an explicit override remains authoritative', () => {
  const seen = [];
  const context = vm.createContext({ StockQuant: { run(rows, strategy, params, options) {
    seen.push(options.limitPct);
    return Quant.run(rows, strategy, params, options);
  } } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../portfolio-engine.js'), 'utf8'), context);
  const symbols = ['sh600000', 'sz300001', 'sz301001', 'sh688001'];
  const input = spec({ assets: symbols.map(symbol => ({ symbol, weight: 25 })), barsBySymbol: Object.fromEntries(symbols.map(symbol => [symbol, data([10, 10, 10])])) });
  context.StockPortfolio.calculate(input);
  assert.deepEqual(seen, [10, 20, 20, 20]);
  seen.length = 0;
  context.StockPortfolio.calculate({ ...input, executionOptions: { ...ZERO_COST, limitPct: 5 } });
  assert.deepEqual(seen, [5, 5, 5, 5]);
});

test('all assets start and end on actual common dates, with an explicit interval notice', () => {
  const r = Portfolio.calculate(spec({ start: day(0), end: day(4),
    barsBySymbol: { A: [bar(0, 10), bar(1, 10), bar(2, 12), bar(3, 12)], B: [bar(1, 10), bar(2, 9), bar(3, 9), bar(4, 9)] } }));
  assert.equal(r.actualStart, day(1));
  assert.equal(r.actualEnd, day(3));
  assert.deepEqual(r.equity.map(p => p.time), [day(1), day(2), day(3)]);
  assert.equal(r.notices.length, 1);
});

test('unknown interior missing data throws, with no future-price fill or invented suspension', () => {
  assert.throws(() => Portfolio.calculate(spec({ barsBySymbol: { A: data([10, 12, 11]), B: [bar(0, 20), bar(2, 18)] } })), /B.*2024-01-02.*缺少行情/);
});

test('a supplied calendar detects a missing session shared by all symbols', () => {
  assert.throws(() => Portfolio.calculate(spec({ barsBySymbol: { A: [bar(0, 10), bar(2, 11)], B: [bar(0, 20), bar(2, 18)] },
    executionOptions: { ...ZERO_COST, calendar: [day(0), day(1), day(2)] } })), /缺少行情/);
});

test('zero-weight watchlist entries do not change valuation dates or require prices', () => {
  const r = Portfolio.calculate(spec({ assets: [{ symbol: 'A', weight: 60 }, { symbol: 'B', weight: 30 }, { symbol: 'NO_DATA', weight: 0 }] }));
  assert.equal(r.finalNAV, 97);
});

test('future suffix cannot alter the selected historical run', () => {
  const original = Portfolio.calculate(spec());
  const extended = Portfolio.calculate(spec({ barsBySymbol: { A: [...data([10, 12, 9]), bar(3, 900)], B: [...data([10, 9, 11]), bar(3, .01)] } }));
  assert.deepEqual(extended.equity, original.equity);
  assert.deepEqual(extended.perAsset.map(a => a.fills), original.perAsset.map(a => a.fills));
});

test('invalid weights, dates, duplicate symbols, impossible dates and adjusted shares are rejected', () => {
  assert.throws(() => Portfolio.calculate(spec({ assets: [{ symbol: 'A', weight: 101 }] })), /100%/);
  assert.throws(() => Portfolio.calculate(spec({ start: day(3) })), /开始日期/);
  assert.throws(() => Portfolio.calculate(spec({ start: '2024-02-30' })), /日期/);
  assert.throws(() => Portfolio.calculate(spec({ assets: [{ symbol: 'A', weight: 20 }, { symbol: 'A', weight: 30 }] })), /重复/);
  assert.throws(() => Portfolio.calculate(spec({ barsBySymbol: { A: [bar(0, 10), bar(0, 12)], B: data([10, 10, 10]) } })), /重复/);
  assert.throws(() => Portfolio.calculate(spec({ mode: 'shares', initialCash: 0, assets: [{ symbol: 'A', quantity: 2 }],
    barsBySymbol: { A: { bars: data([10, 10, 10]), meta: { adjustment: 'qfq' } } } })), /未复权/);
});

test('holdings cost returns aggregate by cost, not the arithmetic average of return percentages', () => {
  const r = Portfolio.holdingsSummary([{ symbol: 'A', quantity: 60, avgCost: 10 }, { symbol: 'B', quantity: 40, avgCost: 10 }], { A: 11, B: 12 });
  assert.equal(r.totalCost, 1000);
  assert.equal(r.totalMarketValue, 1140);
  assert.equal(r.totalPnL, 140);
  near(r.totalReturn, 14);
  const h = Portfolio.holdingsSummary([{ symbol: 'A', quantity: 100, avgCost: 8 }], { A: 10 });
  near(h.totalReturn, 25);
  const backtest = Portfolio.calculate(spec({ mode: 'shares', initialCash: 0, assets: [{ symbol: 'A', quantity: 100, avgCost: 8 }], barsBySymbol: { A: data([9, 9.5, 10]) } }));
  near(backtest.totalReturn, (10 / 9 - 1) * 100);
});

test('WFA optimization calls inspect training only and test once with frozen parameters plus warm-up', () => {
  const calls = [];
  const context = vm.createContext({ StockQuant: { run(rows, strategy, params, options) {
    calls.push({ rows: rows.map(x => x.time), strategy, params: { ...params }, options: { ...options } });
    const isTest = options.start === day(4);
    return { sharpe: isTest ? -9 : params.step, totalReturn: isTest ? -80 : 50, trades: [], equity: [] };
  } } });
  vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../portfolio-engine.js'), 'utf8'), context);
  const r = context.StockPortfolio.walkForward(data([10, 10, 10, 10, 9, 8]), 'grid', {}, {
    trainBars: 4, testBars: 2, gridSearch: { steps: [2, 3], downs: [3], ups: [3], lots: [1] }, executionOptions: ZERO_COST
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].rows, [day(0), day(1), day(2), day(3)]);
  assert.deepEqual(calls[1].rows, [day(0), day(1), day(2), day(3)]);
  assert.equal(calls[2].options.start, day(4));
  assert.equal(calls[2].options.end, day(5));
  assert.equal(calls[2].rows.length, 6); // history retained, execution restricted by start
  assert.deepEqual(calls[2].params, calls[1].params);
  assert.equal(r.windows[0].params.base, 10);
  assert.equal(r.windows[0].candidateCount, 2);
  assert.equal(r.windows[0].testReturn, -80);
  assert.equal(r.continuous, false);
  assert.equal(r.adopted, undefined);
  assert.equal(r.avgTestReturn, undefined);
});

test('WFA MA keeps historical indicator warm-up that a reset test slice loses', () => {
  const training = Array.from({ length: 40 }, (_, i) => bar(i, 140 - i));
  const validation = Array.from({ length: 60 }, (_, i) => bar(i + 40, 102 + i * 2));
  const r = Portfolio.walkForward([...training, ...validation], 'ma', { shortN: 5, longN: 20 }, { trainBars: 40, testBars: 60, executionOptions: { ...ZERO_COST, initialCash: 10000 } });
  const reset = Quant.run(validation, 'ma', { shortN: 5, longN: 20 }, { ...ZERO_COST, initialCash: 10000 });
  assert.equal(reset.fills.length, 0);
  assert.ok(r.windows[0].testResult.fills.length > 0);
  assert.ok(r.windows[0].testResult.fills.every(fill => (fill.time || fill.date) >= day(40)));
  assert.equal(r.windows[0].testResult.equity[0].time, day(40));
  assert.ok(r.windows[0].testReturn > 0);
});

test('WFA uses independent non-overlapping test folds and discloses unused tail', () => {
  const r = Portfolio.walkForward(data(Array(15).fill(10)), 'hold', {}, { trainBars: 4, testBars: 3, executionOptions: { ...ZERO_COST, initialCash: 100 } });
  assert.equal(r.totalWindows, 3);
  assert.deepEqual(r.windows.map(w => [w.testStart, w.testEnd]), [[day(4), day(6)], [day(7), day(9)], [day(10), day(12)]]);
  assert.equal(r.trailingUntestedBars, 2);
  assert.equal(r.continuous, false);
  assert.equal(r.optimized, false);
});
