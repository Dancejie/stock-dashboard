(function (global) {
  'use strict';

  // This public workspace never reads the original account or its server storage.
  const KEY = 'dance-investment-workspace-v1';
  const MAX_LENGTH = 500000;
  const empty = () => ({ version: 0, watchlist: [], portfolios: [] });
  const clone = value => JSON.parse(JSON.stringify(value));
  function fail(message, status) { const error = new Error(message); error.status = status; return error; }

  function create(options = {}) {
    function storage() {
      try {
        const value = options.storage === undefined ? global.localStorage : options.storage;
        if (!value || typeof value.getItem !== 'function' || typeof value.setItem !== 'function') throw new Error();
        return value;
      } catch { throw fail('浏览器暂不允许本机保存。请允许网站存储后重试；你的本页修改仍保留。', 503); }
    }
    function validate(data) {
      if (!data || typeof data !== 'object' || !Number.isSafeInteger(data.version) || data.version < 0 || data.version >= Number.MAX_SAFE_INTEGER || !Array.isArray(data.watchlist) || !Array.isArray(data.portfolios)) throw fail('本机配置格式不正确，原记录未被覆盖。', 422);
      if (data.watchlist.length > 100 || data.portfolios.length > 30 || [...data.watchlist, ...data.portfolios].some(item => !item || typeof item !== 'object' || Array.isArray(item))) throw fail('本机配置格式不正确或超出数量限制，原记录未被覆盖。', 422);
      try {
        const errors = options.validate ? options.validate(data) : [];
        if (errors.length) throw fail(errors[0], 422);
      } catch (error) {
        if (error.status) throw error;
        throw fail('本机配置中有无法读取的项目，原记录未被覆盖。', 422);
      }
      const result = clone({ version: data.version, watchlist: data.watchlist, portfolios: data.portfolios });
      if (JSON.stringify(result).length > MAX_LENGTH) throw fail('配置过大，请减少自选或组合后重试。', 413);
      return result;
    }
    function read() {
      let raw;
      try { raw = storage().getItem(KEY); } catch (error) { if (error.status) throw error; throw fail('无法读取本机记录，请检查浏览器的网站存储设置。', 503); }
      if (raw === null) return empty();
      let record;
      try { if (raw.length > MAX_LENGTH + 100) throw new Error(); record = JSON.parse(raw); } catch { throw fail('本机记录无法解析，原内容已保留，请勿清除浏览器数据。', 422); }
      if (record?.schema !== 1) throw fail('此配置来自其他版本。请使用保存它的版本打开，原记录已保留。', 422);
      return validate(record.workspace);
    }
    async function request(method, body) {
      if (method === 'GET') return read();
      if (method !== 'PUT') throw fail('不支持此保存操作。', 405);
      const next = validate(body);
      const locks = options.locks === undefined ? global.navigator?.locks : options.locks;
      // A browser lock makes the version check and write indivisible across tabs.
      if (!locks?.request) throw fail('此浏览器无法安全保存多页面修改。请通过 HTTPS 在最新版 Chrome、Edge 或 Safari 中打开；本页仍可计算。', 503);
      return locks.request(KEY, { mode: 'exclusive' }, () => {
        const latest = read();
        if (latest.version !== next.version) throw fail('其他页面已保存更新，请先加载本机最新版本。', 409);
        next.version += 1;
        try { storage().setItem(KEY, JSON.stringify({ schema: 1, workspace: next })); }
        catch (error) { if (error.status) throw error; throw fail('本机保存失败，可能是空间已满或浏览器限制。你的本页修改仍保留，请勿关闭页面。', 507); }
        return clone(next);
      });
    }
    return { request };
  }
  global.StockLocalWorkspace = { create, key: KEY };
  if (typeof module !== 'undefined' && module.exports) module.exports = { create, key: KEY };
})(typeof window === 'undefined' ? globalThis : window);
