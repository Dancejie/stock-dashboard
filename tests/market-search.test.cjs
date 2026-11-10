const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const Search = require('../market-search.js');

const payload = rows => ({ QuotationCodeTable: { Data: rows } });
const valid = { Code: '000426', Name: '兴业银锡', MktNum: '0' };

function environment() {
  const listeners = new Set(), timers = new Map(), frames = [];
  const env = {
    document: { createElement(tag) {
      assert.equal(tag, 'iframe', 'the parent creates no remote script element');
      return { attributes: {}, contentWindow: {}, removed: false, setAttribute(k, v) { this.attributes[k] = v; }, remove() { this.removed = true; } };
    }, body: { appendChild(frame) { frames.push(frame); } } },
    crypto: { getRandomValues(bytes) { bytes.fill(37); return bytes; } },
    addEventListener(type, callback) { assert.equal(type, 'message'); listeners.add(callback); },
    removeEventListener(type, callback) { assert.equal(type, 'message'); listeners.delete(callback); },
    setTimeout(callback, delay) { assert.equal(delay, 10000); timers.set(1, callback); return 1; },
    clearTimeout(id) { timers.delete(id); }
  };
  const emit = overrides => {
    const frame = frames[0];
    const event = { source: frame.contentWindow, origin: 'null', data: { type: 'stock-market-search-v1', nonce: '25'.repeat(16), ok: true, payload: payload([valid]) }, ...overrides };
    for (const callback of [...listeners]) callback(event);
  };
  return { env, frames, listeners, timers, emit };
}

test('only bounded plain Shanghai/Shenzhen result fields survive sanitation', () => {
  const source = payload([{ ...valid, html: '<script>bad()</script>', QuoteID: '0.000426' },
    { Code: '600000', Name: ' 浦发银行 ', MktNum: 1 }, valid,
    { Code: '00700', Name: '腾讯', MktNum: '116' }, { Code: '123456', Name: 'US', MktNum: 105 },
    { Code: 600001, Name: '数字代码', MktNum: '1' }, { Code: '123456', Name: '<img src=x>', MktNum: '0' },
    { Code: '123456', Name: 'x'.repeat(81), MktNum: '0' }, { Code: '123456', Name: 'javascript:alert(1)', MktNum: '0' },
    { Code: '123456', Name: '含\n控制字符', MktNum: '0' }, { Code: '123456', Name: {}, MktNum: '0' }]);
  assert.deepEqual(Search.sanitizeItems(source), { items: [valid, { Code: '600000', Name: '浦发银行', MktNum: '1' }] });
  assert.throws(() => Search.sanitizeItems({ items: [valid] }), /格式异常/);
  assert.equal(Search.sanitizeItems(payload(Array.from({ length: 30 }, (_, i) => ({ Code: String(i).padStart(6, '0'), Name: '股票', MktNum: '0' })))).items.length, 10);
});

test('keyword encoding retains the fixed endpoint/callback and cannot escape the srcdoc script', () => {
  const keyword = '浦发</script>"&cb=evil';
  const url = new URL(Search.searchURL(keyword));
  assert.equal(url.origin, 'https://searchapi.eastmoney.com');
  assert.equal(url.pathname, '/api/suggest/get');
  assert.equal(url.searchParams.get('input'), keyword);
  assert.equal(url.searchParams.get('cb'), '__stockMarketSearchResult');
  const html = Search.frameHTML(keyword, 'nonce</script>\u2028');
  assert.equal((html.match(/<script>/g) || []).length, 1);
  assert.equal((html.match(/<\/script>/g) || []).length, 1);
  assert(!html.includes('nonce</script>'));
  const scripts = [], messages = [];
  const child = { createElement(tag) { assert.equal(tag, 'script'); return {}; }, head: { appendChild(script) { scripts.push(script); } } };
  const context = { window: {}, document: child, parent: { postMessage(value, target) { messages.push({ value, target }); } } };
  vm.runInNewContext(html.match(/<script>([\s\S]*)<\/script>/)[1], context);
  assert.equal(scripts.length, 1);
  assert.equal(scripts[0].src, url.href);
  context.window.__stockMarketSearchResult(payload([valid]));
  assert.equal(messages[0].value.nonce, 'nonce</script>\u2028');
  assert.equal(messages[0].target, '*');
});

test('opaque iframe policy and source/origin/nonce checks protect the parent; success cleans up', async () => {
  const fixture = environment(), pending = Search.createForTest(fixture.env).search('兴业银锡');
  const frame = fixture.frames[0];
  assert.equal(frame.attributes.sandbox, 'allow-scripts');
  assert(!frame.attributes.sandbox.includes('allow-same-origin'));
  assert.equal(frame.hidden, true); assert.equal(frame.tabIndex, -1);
  assert.equal(frame.referrerPolicy, 'no-referrer');
  assert(frame.srcdoc.includes("connect-src 'none'"));
  fixture.emit({ source: {} });
  fixture.emit({ origin: 'https://searchapi.eastmoney.com' });
  fixture.emit({ data: { type: 'stock-market-search-v1', nonce: 'wrong', ok: true, payload: payload([valid]) } });
  assert.equal(fixture.listeners.size, 1);
  fixture.emit();
  assert.deepEqual(await pending, { items: [valid] });
  assert.equal(frame.removed, true);
  assert.equal(fixture.listeners.size, 0); assert.equal(fixture.timers.size, 0);
});

test('timeout, provider failure, and invalid payload each remove frame and handler', async () => {
  for (const failure of ['timeout', 'provider', 'payload']) {
    const fixture = environment(), pending = Search.createForTest(fixture.env).search('浦发');
    const rejection = assert.rejects(pending);
    if (failure === 'timeout') fixture.timers.get(1)();
    else fixture.emit({ data: { type: 'stock-market-search-v1', nonce: '25'.repeat(16), ok: failure !== 'provider', payload: {} } });
    await rejection;
    assert.equal(fixture.frames[0].removed, true);
    assert.equal(fixture.listeners.size, 0); assert.equal(fixture.timers.size, 0);
  }
});

test('blank search needs no iframe and invalid keywords never trigger a network frame', async () => {
  const fixture = environment(), api = Search.createForTest(fixture.env);
  assert.deepEqual(await api.search('  '), { items: [] });
  await assert.rejects(api.search('股'.repeat(31)), /30/);
  await assert.rejects(api.search({ toString: () => '浦发' }));
  await assert.rejects(api.search('浦发\n<script>'));
  assert.equal(fixture.frames.length, 0);
});
