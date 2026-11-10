(function (root) {
  'use strict';

  const ENDPOINT = 'https://searchapi.eastmoney.com/api/suggest/get';
  const PUBLIC_TOKEN = 'D43BF722C8E33BEA60AB745A590A7C76';
  const CALLBACK = '__stockMarketSearchResult';
  const MESSAGE = 'stock-market-search-v1';
  const TIMEOUT = 10000;

  function keywordText(value) {
    if (typeof value !== 'string') throw new Error('请输入股票名称或代码。');
    const text = value.trim();
    if (Array.from(text).length > 30 || /[\u0000-\u001f\u007f]/.test(text)) throw new Error('搜索词最多 30 个字，不能包含控制字符。');
    return text;
  }

  function searchURL(keyword) {
    const query = new URLSearchParams({ input: keyword, type: '14', token: PUBLIC_TOKEN, count: '10', cb: CALLBACK });
    return ENDPOINT + '?' + query.toString();
  }

  function scriptJSON(value) {
    // JSON encoding alone does not prevent </script> from terminating HTML raw text.
    return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026')
      .replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
  }

  function frameHTML(keyword, nonce) {
    const policy = "default-src 'none'; script-src 'unsafe-inline' https://searchapi.eastmoney.com; connect-src 'none'; img-src 'none'; style-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
    return '<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer">' +
      '<meta http-equiv="Content-Security-Policy" content="' + policy + '"></head><body><script>' +
      '(function(){"use strict";var nonce=' + scriptJSON(nonce) + ',done=false;' +
      'function send(ok,payload){if(done)return;done=true;parent.postMessage({type:' + scriptJSON(MESSAGE) + ',nonce:nonce,ok:ok,payload:payload},"*");}' +
      'window.' + CALLBACK + '=function(data){send(true,data);};' +
      'var request=document.createElement("script");request.referrerPolicy="no-referrer";request.src=' + scriptJSON(searchURL(keyword)) + ';' +
      'request.onerror=function(){send(false,null);};document.head.appendChild(request);' +
      '})();</script></body></html>';
  }

  function sanitizeItems(payload) {
    const rows = payload && payload.QuotationCodeTable && payload.QuotationCodeTable.Data;
    if (!Array.isArray(rows)) throw new Error('股票搜索返回格式异常，请重试或输入六位代码。');
    const items = [], seen = new Set();
    // Only these three scalar fields cross into the parent application's state.
    for (const row of rows.slice(0, 100)) {
      if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.Code !== 'string' || !/^\d{6}$/.test(row.Code)) continue;
      if (!['0', '1', 0, 1].includes(row.MktNum) || typeof row.Name !== 'string') continue;
      const name = row.Name.trim(), market = String(row.MktNum), key = market + '.' + row.Code;
      if (!name || Array.from(name).length > 80 || /[<>\u0000-\u001f\u007f]/.test(name) || /^(?:javascript|data|vbscript)\s*:/i.test(name) || seen.has(key)) continue;
      seen.add(key);
      items.push({ Code: row.Code, Name: name, MktNum: market });
      if (items.length === 10) break;
    }
    return { items: items };
  }

  function create(env) {
    function search(keyword) {
      return new Promise(function (resolve, reject) {
        let frame = null, timer = null, listener = null, settled = false;
        function finish(error, result) {
          if (settled) return;
          settled = true;
          if (timer !== null) env.clearTimeout(timer);
          if (listener) env.removeEventListener('message', listener);
          if (frame) frame.remove();
          if (error) reject(error); else resolve(result);
        }
        try {
          const text = keywordText(keyword);
          if (!text) { finish(null, { items: [] }); return; }
          if (!env.document || !env.crypto || typeof env.crypto.getRandomValues !== 'function') throw new Error('当前浏览器不支持安全名称搜索，请输入六位代码。');
          const bytes = env.crypto.getRandomValues(new Uint8Array(16));
          const nonce = Array.from(bytes, n => n.toString(16).padStart(2, '0')).join('');
          frame = env.document.createElement('iframe');
          // Remote JSONP runs in an opaque-origin sandbox, never in the holdings page.
          // The iframe sees only the public stock keyword; it cannot read parent DOM/storage.
          frame.setAttribute('sandbox', 'allow-scripts');
          frame.setAttribute('aria-hidden', 'true');
          frame.hidden = true;
          frame.tabIndex = -1;
          frame.width = '0'; frame.height = '0';
          frame.referrerPolicy = 'no-referrer';
          frame.title = '股票名称搜索隔离请求';
          frame.srcdoc = frameHTML(text, nonce);
          listener = function (event) {
            if (event.source !== frame.contentWindow || event.origin !== 'null') return;
            const message = event.data;
            if (!message || typeof message !== 'object' || Array.isArray(message) || message.type !== MESSAGE || message.nonce !== nonce) return;
            if (message.ok !== true) { finish(new Error('名称搜索暂不可用，请重试或输入六位代码。')); return; }
            try { finish(null, sanitizeItems(message.payload)); } catch (error) { finish(error); }
          };
          env.addEventListener('message', listener);
          timer = env.setTimeout(function () { finish(new Error('名称搜索超时，请重试或输入六位代码。')); }, TIMEOUT);
          (env.document.body || env.document.documentElement).appendChild(frame);
        } catch (error) { finish(error); }
      });
    }
    return Object.freeze({ search: search });
  }

  const api = create(root);
  if (typeof module === 'object' && module.exports) module.exports = { search: api.search, createForTest: create, sanitizeItems: sanitizeItems, frameHTML: frameHTML, searchURL: searchURL, keywordText: keywordText };
  else root.StockMarketSearch = api;
})(typeof window !== 'undefined' ? window : globalThis);
