const test = require('node:test');
const assert = require('node:assert/strict');
const { validatePortfolio, validateWorkspace, resultHTML, chartHTML, esc, number, workspacePayload, effectiveFees, testController } = require('../workspace-ui.js');

function portfolio(overrides = {}) {
  return { id: 'test', name: '测试组合', mode: 'allocation', initialCash: 1000000, start: '2025-01-01', end: '2026-01-01', assets: [{ symbol: 'sh600000', name: '测试股票', weight: 50, quantity: 100, strategy: 'hold', params: {} }], ...overrides };
}
test('weights can leave cash, but must not overallocate', () => {
  assert.deepEqual(validatePortfolio(portfolio()), []);
  assert(validatePortfolio(portfolio({ assets: [{ symbol: 'a', weight: 60 }, { symbol: 'b', weight: 50 }] })).some(error => error.includes('超过 100%')));
});
test('fixed shares allow zero extra cash and reject fractional or missing quantities', () => {
  assert.deepEqual(validatePortfolio(portfolio({ mode: 'shares', initialCash: 0 })), []);
  assert(validatePortfolio(portfolio({ mode: 'shares', initialCash: 0, assets: [{ symbol: 'a', quantity: 1.5 }] })).some(error => error.includes('正整数')));
});
test('dates must be real dates and chronologically ordered', () => {
  assert(validatePortfolio(portfolio({ start: '2025-02-30' })).some(error => error.includes('日期')));
  assert(validatePortfolio(portfolio({ end: '2024-01-01' })).some(error => error.includes('日期')));
});
test('portfolio rejects unsupported strategy and duplicated assets', () => {
  const errors = validatePortfolio(portfolio({ assets: [{ symbol: 'same', weight: 20, strategy: 'unknown' }, { symbol: 'same', weight: 20 }] }));
  assert(errors.some(error => error.includes('策略不支持')));
  assert(errors.some(error => error.includes('重复')));
});
test('sellable quantity cannot silently exceed holdings or exist without holdings', () => {
  const data = { watchlist: [{ symbol: 'a', quantity: 100, avgCost: 10, sellableQty: 200 }], portfolios: [] };
  assert(validateWorkspace(data).some(error => error.includes('可卖股数不能超过')));
  data.watchlist[0] = { symbol: 'a', sellableQty: 100 };
  assert(validateWorkspace(data).some(error => error.includes('可卖股数不能超过')));
});
test('watch-only entries and known quantities may omit an unknown cost', () => {
  assert.deepEqual(validateWorkspace({ watchlist: [{ symbol: 'sh600000', name: '自选' }], portfolios: [] }), []);
  assert.deepEqual(validateWorkspace({ watchlist: [{ symbol: 'sh600000', quantity: 100 }], portfolios: [] }), []);
});
test('fee limits and numeric types match the workspace API', () => {
  assert(validatePortfolio(portfolio({ feeOptions: { commissionRate: 0.051 } })).some(error => error.includes('佣金')));
  assert(validatePortfolio(portfolio({ feeOptions: { stampTaxRate: 0.051 } })).some(error => error.includes('卖出税')));
  assert(validatePortfolio(portfolio({ initialCash: true })).some(error => error.includes('本金')));
  assert(validatePortfolio(portfolio({ assets: [{ symbol: 'sh600000', weight: 100, quantity: 2.5 }] })).some(error => error.includes('股数')));
});
test('blank holding cost stays absent; whitespace never becomes a zero cost', () => {
  assert.equal(number(''), undefined);
  assert.equal(number('  '), undefined);
  const payload = workspacePayload({ version: 1, watchlist: [{ symbol: 'sh600000', avgCost: '', quantity: 0 }], portfolios: [] });
  assert(!Object.hasOwn(payload.watchlist[0], 'avgCost'));
  assert.equal(payload.watchlist[0].quantity, 0);
});
test('saving strategy parameters is lossless and displayed fee defaults are explicit', () => {
  const item = portfolio({ feeOptions: {}, assets: [{ symbol: 'sh600000', weight: 100, quantity: 0, strategy: 'ma', params: { shortN: 8, longN: 30 } }] });
  const payload = workspacePayload({ version: 3, watchlist: [], portfolios: [item] });
  assert.deepEqual(payload.portfolios[0].assets[0].params, { shortN: 8, longN: 30 });
  assert.deepEqual(payload.portfolios[0].feeOptions, effectiveFees(item));
  assert.equal(payload.portfolios[0].feeOptions.commissionRate, 0.0003);
  assert.equal(payload.portfolios[0].feeOptions.stampTaxRate, 0.0005);
  assert(!Object.hasOwn(payload.portfolios[0].feeOptions, 'sellTaxRate'));
});
function controllerFixture(data) {
  const node = { textContent: '', innerHTML: '', focus() {} };
  const root = { innerHTML: '', contains: () => true, querySelector(selector) { if (selector === '[data-action="run"]' && !this.innerHTML.includes('data-action="run"')) return null; return ['#sw-save-state', '#sw-alert', '#sw-portfolio-validation', '#sw-allocation-note', '#sw-result', '[data-action="save"]', '[data-action="run"]'].includes(selector) ? { ...node } : null; } };
  Object.assign(testController.state, { root, data: JSON.parse(JSON.stringify(data)), saved: JSON.parse(JSON.stringify(data)), loading: false, saving: false, dirty: false, conflict: false, error: '', notice: '', tab: 'portfolio', expanded: true, activeId: data.portfolios[0]?.id || null, temporary: null, result: null, resultId: null, calculating: false, quoteLoading: false, quotes: {}, runToken: 0 });
  return root;
}
function action(name) {
  const button = { dataset: { action: name }, disabled: false };
  return testController.onClick({ target: { closest: () => button } });
}
test('an empty new portfolio does not enter the server payload or block watchlist saving', async () => {
  controllerFixture({ version: 1, watchlist: [{ symbol: 'sh600000', name: '测试' }], portfolios: [] });
  await action('new-portfolio');
  assert.equal(testController.state.data.portfolios.length, 0);
  assert.equal(testController.state.dirty, false);
  testController.onChange({ type: 'input', target: { dataset: { watch: '0', field: 'avgCost' }, value: '10' } });
  assert.equal(testController.state.dirty, true);
  assert.deepEqual(validateWorkspace(testController.state.data), []);
  assert.deepEqual(workspacePayload(testController.state.data).portfolios, []);
});
test('shares mode resets extra cash to zero and exposes fixed holding rather than strategy execution', () => {
  const root = controllerFixture({ version: 1, watchlist: [], portfolios: [portfolio()] });
  testController.onChange({ type: 'change', target: { dataset: { portfolio: 'mode' }, value: 'shares' } });
  assert.equal(testController.state.data.portfolios[0].initialCash, 0);
  assert(root.innerHTML.includes('固定持有（不运行策略）'));
  assert(root.innerHTML.includes('固定股数不运行策略、不模拟买卖费用'));
});
test('the first added asset promotes an empty draft and preserves its edited name', async t => {
  const previousApp = global.StockApp; t.after(() => { global.StockApp = previousApp; });
  global.StockApp = { getCurrent: () => ({ symbol: 'sh600000', name: '测试股票' }) };
  controllerFixture({ version: 1, watchlist: [], portfolios: [] });
  await action('new-portfolio');
  testController.onChange({ type: 'input', target: { dataset: { portfolio: 'name' }, value: '我的草稿' } });
  assert.equal(testController.state.data.portfolios.length, 0);
  await action('add-current-asset');
  assert.equal(testController.state.data.portfolios.length, 1);
  assert.equal(testController.state.data.portfolios[0].name, '我的草稿');
  assert.equal(testController.state.data.portfolios[0].assets[0].symbol, 'sh600000');
  assert.deepEqual(validateWorkspace(testController.state.data), []);
});
test('HTTP validation details are shown and a conflict preserves the unsaved revision', async t => {
  const previousFetch = global.fetch;
  t.after(() => { global.fetch = previousFetch; });
  global.fetch = async () => ({ ok: false, status: 422, json: async () => ({ detail: '每个组合需包含1至20只股票' }) });
  await assert.rejects(testController.request('GET'), /每个组合需包含1至20只股票/);
  controllerFixture({ version: 4, watchlist: [{ symbol: 'sh600000', name: '保存前' }], portfolios: [] });
  testController.state.data.watchlist[0].name = '未保存修改';
  testController.state.dirty = true;
  global.fetch = async () => ({ ok: false, status: 409, json: async () => ({ detail: '版本冲突' }) });
  await testController.save();
  assert.equal(testController.state.conflict, true);
  assert.equal(testController.state.data.version, 4);
  assert.equal(testController.state.data.watchlist[0].name, '未保存修改');
  assert.equal(testController.state.saved.watchlist[0].name, '保存前');
});
test('negative transaction costs cannot be saved', () => {
  assert(validatePortfolio(portfolio({ feeOptions: { commissionRate: -0.01 } })).some(error => error.includes('佣金')));
});
test('NAV starts from engine initialNAV, retaining first execution fees', () => {
  const chart = chartHTML({ initialNAV: 100, equity: [{ time: '2025-01-01', value: 99 }, { time: '2025-01-02', value: 101 }] });
  assert(chart.includes('期末 1.010'));
  assert(!chart.includes('期末 1.020'));
});
test('portfolio results show actual common dates, proper contributions, and escaped provider text', () => {
  const html = resultHTML({ actualStart: '2025-02-03', actualEnd: '2025-12-31', totalReturn: 12, annualized: 13, maxDrawdown: 5, perAsset: [{ name: '<img src=x onerror=alert(1)>', symbol: 'a', initialValue: 100, finalValue: 110, profit: 10, returnPct: 10, contributionPct: 5 }], notices: ['<script>bad()</script>'] }, portfolio());
  assert(html.includes('2025-02-03 至 2025-12-31'));
  assert(html.includes('+5.00%'));
  assert(!html.includes('<img'));
  assert(!html.includes('<script>'));
  assert(html.includes('&lt;script&gt;'));
  assert.equal(esc('"&<>\''), '&quot;&amp;&lt;&gt;&#39;');
});
