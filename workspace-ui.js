(function (global) {
  'use strict';

  const STRATEGIES = { hold: '买入持有', mr: '均值回归', ma: '双均线', turtle: '海龟突破', boll: '布林带', td: 'TD 序列', grid: '网格' };
  const FEE_DEFAULTS = { commissionRate: 0.0003, minCommission: 5, stampTaxRate: 0.0005, slippageBps: 5 };
  const state = { root: null, data: null, saved: null, loading: false, saving: false, dirty: false, conflict: false, error: '', notice: '', tab: 'watchlist', expanded: true, activeId: null, temporary: null, result: null, resultId: null, calculating: false, quoteLoading: false, quotes: {}, runToken: 0 };
  const clone = value => JSON.parse(JSON.stringify(value));
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const number = value => value == null || (typeof value === 'string' && !value.trim()) ? undefined : Number(value);
  const fmt = (value, digits = 2) => Number.isFinite(Number(value)) && value != null ? Number(value).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits }) : '—';
  const pct = value => Number.isFinite(Number(value)) && value != null ? `${Number(value) > 0 ? '+' : ''}${fmt(value)}%` : '—';
  const tone = value => Number(value) > 0 ? 'sw-positive' : Number(value) < 0 ? 'sw-negative' : '';
  const adapter = () => global.StockApp;
  const current = () => { try { return adapter()?.getCurrent?.() || null; } catch { return null; } };
  const makeId = () => global.crypto?.randomUUID?.() || `portfolio-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  function isoDate(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
  function newPortfolio() {
    const end = new Date(), start = new Date(end); start.setFullYear(start.getFullYear() - 1);
    return { id: makeId(), name: `组合 ${(state.data?.portfolios.length || 0) + 1}`, mode: 'allocation', initialCash: 1000000, start: isoDate(start), end: isoDate(end), assets: [], feeOptions: { ...FEE_DEFAULTS } };
  }
  function selectedPortfolio() {
    const existing = state.data?.portfolios.find(item => item.id === state.activeId);
    if (existing) return existing;
    if (!state.temporary) state.temporary = newPortfolio();
    return state.temporary;
  }
  function editablePortfolio() {
    const item = selectedPortfolio();
    state.activeId = item.id;
    return item;
  }
  function markDirty() {
    state.dirty = JSON.stringify(state.data) !== JSON.stringify(state.saved); state.notice = ''; state.error = ''; state.runToken += 1; state.calculating = false; state.result = null;
    const result = state.root?.querySelector('#sw-result'); if (result) result.innerHTML = '';
    updateStatus();
  }
  function validDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) return false;
    const date = new Date(`${value}T00:00:00Z`);
    return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }
  function validatePortfolio(item) {
    const errors = [];
    if (!String(item.name || '').trim()) errors.push('请填写组合名称。');
    if (typeof item.name !== 'string' || item.name.length > 80) errors.push('组合名称最多 80 个字符。');
    if (!['allocation', 'shares'].includes(item.mode)) errors.push('请选择组合分配方式。');
    if (!validDate(item.start) || !validDate(item.end) || item.start > item.end) errors.push('结束日期不能早于开始日期。');
    else if (item.start < '2000-01-01' || item.end > new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' }) || (Date.parse(item.end) - Date.parse(item.start)) / 86400000 > 3653) errors.push('日期需在 2000 年至今天内，单次跨度不超过 10 年。');
    if (typeof item.initialCash !== 'number' || !Number.isFinite(item.initialCash) || item.initialCash < (item.mode === 'shares' ? 0 : 0.01) || item.initialCash > 1e12) errors.push(item.mode === 'shares' ? '额外现金应为 0 至 1 万亿元之间的数值。' : '回测本金应在 0.01 元至 1 万亿元之间。');
    if (!Array.isArray(item.assets) || !item.assets.length) errors.push('至少添加一只股票。');
    if (item.assets?.length > 20) errors.push('每个组合最多保存 20 只股票。');
    const symbols = new Set();
    let weight = 0;
    for (const asset of item.assets || []) {
      if (!asset.symbol || symbols.has(asset.symbol)) errors.push('组合股票不可为空或重复。');
      if (!/^(sh|sz)\d{6}$/.test(asset.symbol || '')) errors.push('本版组合支持沪深 A 股代码。');
      symbols.add(asset.symbol);
      if (asset.name != null && (typeof asset.name !== 'string' || asset.name.length > 80)) errors.push('股票名称最多 80 个字符。');
      if (!STRATEGIES[asset.strategy || 'hold']) errors.push(`${asset.name || asset.symbol} 的策略不支持。`);
      if (asset.quantity != null && (typeof asset.quantity !== 'number' || !Number.isSafeInteger(asset.quantity) || asset.quantity < 0 || asset.quantity > 1e12)) errors.push(`${asset.name || asset.symbol} 保存的股数必须为非负整数且不超过 1 万亿。`);
      if (asset.weight != null && (typeof asset.weight !== 'number' || !Number.isFinite(asset.weight) || asset.weight < 0 || asset.weight > 100)) errors.push(`${asset.name || asset.symbol} 保存的权重需在 0% 至 100% 之间。`);
      const params = asset.params || {};
      if (typeof params !== 'object' || Array.isArray(params) || Object.keys(params).length > 25 || Object.entries(params).some(([key, value]) => key.length > 40 || typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > 1e9)) errors.push(`${asset.name || asset.symbol} 的策略参数必须为有效数值。`);
      if (item.mode === 'allocation') {
        if (!Number.isFinite(Number(asset.weight)) || Number(asset.weight) <= 0) errors.push(`${asset.name || asset.symbol} 的权重应大于 0。`);
        weight += Number(asset.weight) || 0;
      } else if (!Number.isSafeInteger(Number(asset.quantity)) || Number(asset.quantity) <= 0) errors.push(`${asset.name || asset.symbol} 的股数应为正整数。`);
    }
    if (item.mode === 'allocation' && weight > 100 + 1e-9) errors.push(`总权重 ${fmt(weight)}% 超过 100%，请调低后计算。`);
    const fees = item.feeOptions || {};
    for (const [key, label, max] of [['commissionRate', '佣金费率', 0.05], ['minCommission', '最低佣金', 10000], ['stampTaxRate', '卖出税率', 0.05], ['slippageBps', '滑点', 1000]]) {
      if (Object.prototype.hasOwnProperty.call(fees, key) && (typeof fees[key] !== 'number' || !Number.isFinite(fees[key]) || fees[key] < 0 || fees[key] > max)) errors.push(`${label}超出可用范围。`);
    }
    return [...new Set(errors)];
  }
  function validateWorkspace(data) {
    const errors = [];
    if (data.watchlist?.length > 100 || data.portfolios?.length > 30) errors.push('最多保存 100 只自选股和 30 个组合。');
    const symbols = new Set();
    for (const item of data.watchlist || []) {
      const label = item.name || item.symbol;
      if (!item.symbol || symbols.has(item.symbol)) errors.push('自选股票不可为空或重复。');
      if (!/^(sh|sz)\d{6}$/.test(item.symbol || '')) errors.push('本版自选支持沪深 A 股代码。');
      if (item.name != null && (typeof item.name !== 'string' || item.name.length > 80)) errors.push('股票名称最多 80 个字符。');
      symbols.add(item.symbol);
      for (const [key, title] of [['avgCost', '成本'], ['quantity', '持仓股数'], ['sellableQty', '可卖股数']]) {
        if (item[key] != null && item[key] !== '' && (typeof item[key] !== 'number' || !Number.isFinite(item[key]) || item[key] < 0 || item[key] > 1e12)) errors.push(`${label}的${title}应为 0 至 1 万亿之间的数值。`);
      }
      if (item.quantity != null && !Number.isSafeInteger(Number(item.quantity))) errors.push(`${label}的持仓股数应为整数。`);
      if (item.sellableQty != null && !Number.isSafeInteger(Number(item.sellableQty))) errors.push(`${label}的可卖股数应为整数。`);
      if (item.sellableQty != null && (item.quantity == null || Number(item.sellableQty) > Number(item.quantity))) errors.push(`${label}的可卖股数不能超过持仓股数。`);
    }
    const ids = new Set();
    for (const item of data.portfolios || []) { if (!item.id || typeof item.id !== 'string' || item.id.length > 100 || ids.has(item.id)) errors.push('组合标识为空、过长或重复。'); ids.add(item.id); errors.push(...validatePortfolio(item).map(error => `${item.name || '组合'}：${error}`)); }
    return [...new Set(errors)];
  }
  function effectiveFees(item) { return { ...FEE_DEFAULTS, ...(item.feeOptions || {}) }; }
  function workspacePayload(data) {
    const payload = clone(data);
    payload.watchlist.forEach(item => { for (const key of ['avgCost', 'quantity', 'sellableQty']) if (item[key] == null || (typeof item[key] === 'string' && !item[key].trim())) delete item[key]; });
    payload.portfolios.forEach(item => { item.feeOptions = effectiveFees(item); });
    return payload;
  }
  function input(label, attributes, value, extra = '') {
    return `<label class="sw-field"><span>${esc(label)}</span><input ${attributes} value="${esc(value)}" ${extra}></label>`;
  }
  function watchlistHTML() {
    const items = state.data.watchlist;
    return `<div class="sw-section-head"><div><h3>自选与持仓</h3><p>点股票名切换看板。持仓由你填写，保存后用于成本与可卖数量校验。</p></div><div class="sw-actions"><button data-action="add-current">＋ 加入当前股票</button><button data-action="refresh-quotes" ${state.quoteLoading ? 'disabled' : ''}>${state.quoteLoading ? '估值更新中…' : '更新行情估值'}</button></div></div>
      ${items.length ? `<div class="sw-watchlist">${items.map((item, index) => {
        const quote = state.quotes[item.symbol], quantity = number(item.quantity), cost = number(item.avgCost);
        const profit = quote && quantity > 0 && cost > 0 ? (quote.price - cost) * quantity : null;
        const rate = profit != null ? (quote.price / cost - 1) * 100 : null;
        return `<article class="sw-watch-row"><div class="sw-stock-name"><button class="sw-stock-jump" data-action="select-stock" data-index="${index}">${esc(item.name || item.symbol)}</button><span>${esc(item.symbol)}</span></div>
          ${input('实际成本 / 股', `type="number" min="0" step="0.0001" inputmode="decimal" data-watch="${index}" data-field="avgCost" aria-label="${esc(item.name)}实际成本"`, item.avgCost ?? '', 'placeholder="选填"')}
          ${input('持仓股数', `type="number" min="0" step="1" inputmode="numeric" data-watch="${index}" data-field="quantity" aria-label="${esc(item.name)}持仓股数"`, item.quantity ?? '', 'placeholder="选填"')}
          ${input('可卖股数', `type="number" min="0" step="1" inputmode="numeric" data-watch="${index}" data-field="sellableQty" aria-label="${esc(item.name)}可卖股数"`, item.sellableQty ?? '', 'placeholder="未填写"')}
          <div class="sw-holding-pnl"><span>现持仓浮盈</span><strong class="${tone(profit)}">${profit == null ? '—' : `${profit > 0 ? '+' : ''}${fmt(profit)} 元`}</strong><small class="${tone(rate)}">${pct(rate)}</small><small>${quote ? `${esc(quote.time)} 参考价 ${fmt(quote.price)}` : '等待行情估值'}</small></div>
          <button class="sw-remove" data-action="remove-watch" data-index="${index}" aria-label="移出${esc(item.name || item.symbol)}">移出</button></article>`;
      }).join('')}</div>` : '<div class="sw-empty"><strong>先加入一只你关注的股票</strong><p>在上方搜索股票，再点「加入当前股票」。只关注行情时，可不填写持仓。</p></div>'}
      <p class="sw-note">现持仓浮盈 =（最近可得的不复权参考价 − 你填写的成本）× 持仓股数。成本可留空，此时不计算浮盈。参考价附有行情日期，与指定区间的历史回测收益分别计算；可卖股数不会被自动推断。</p>`;
  }
  function portfolioHTML() {
    const item = selectedPortfolio(), allocation = item.mode === 'allocation', fees = effectiveFees(item);
    const errors = validatePortfolio(item), weight = item.assets.reduce((sum, row) => sum + (Number(row.weight) || 0), 0);
    const selectedIsSaved = state.data.portfolios.some(row => row.id === item.id);
    return `<div class="sw-section-head"><div><h3>组合回测</h3><p>保存多套配置，在同一日期区间比较股票与策略。权重模式模拟策略成交，固定股数模式计算持仓估值变化。</p></div><div class="sw-actions"><button data-action="new-portfolio">＋ 新建组合</button>${selectedIsSaved ? '<button data-action="delete-portfolio">删除当前配置</button>' : '<button data-action="discard-draft">放弃空草稿</button>'}</div></div>
      ${!selectedIsSaved ? '<p class="sw-note sw-draft-note">这是空组合草稿。添加股票后才能保存；它不会阻止自选与持仓的保存。</p>' : ''}<div class="sw-config-picker"><label class="sw-field"><span>已保存 / 编辑中的配置</span><select data-config="activeId" aria-label="选择组合配置">${state.data.portfolios.map(row => `<option value="${esc(row.id)}" ${row.id === item.id ? 'selected' : ''}>${esc(row.name)}</option>`).join('')}${!selectedIsSaved ? `<option value="${esc(item.id)}" selected>新组合（未保存）</option>` : ''}</select></label><span class="sw-badge">${allocation ? '权重分配' : '固定股数'} · ${item.assets.length} 只</span></div>
      <div class="sw-config-grid">${input('组合名称', 'type="text" maxlength="80" data-portfolio="name"', item.name)}
        <label class="sw-field"><span>组合方式</span><select data-portfolio="mode"><option value="allocation" ${allocation ? 'selected' : ''}>按权重分配本金</option><option value="shares" ${!allocation ? 'selected' : ''}>已有固定股数 + 额外现金</option></select></label>
        ${input(allocation ? '总本金（元）' : '持仓之外的额外现金（元）', 'type="number" min="0" step="100" inputmode="decimal" data-portfolio="initialCash"', item.initialCash)}
        ${input('开始日期', 'type="date" data-portfolio="start"', item.start)}${input('结束日期', 'type="date" data-portfolio="end"', item.end)}
      </div>
      <p class="sw-note" id="sw-allocation-note">${allocation ? `股票初始权重合计 ${fmt(weight)}%，未分配的 ${fmt(Math.max(0, 100 - weight))}% 留作现金。策略在各自资金内运行；策略参数独立于单股面板，新增股票使用模型默认参数。` : '初始组合资产 = 共同起点的持仓市值 + 额外现金。历史收益从回测起点计算，不使用上方填写的实际成本。固定股数不运行策略、不模拟买卖费用。'}</p>
      <div class="sw-assets-head"><h4>组合股票</h4><div class="sw-actions"><select id="sw-add-symbol" aria-label="从自选选择组合股票"><option value="">从自选加入…</option>${state.data.watchlist.filter(row => !item.assets.some(asset => asset.symbol === row.symbol)).map(row => `<option value="${esc(row.symbol)}">${esc(row.name || row.symbol)} · ${esc(row.symbol)}</option>`).join('')}</select><button data-action="add-watch-asset">添加</button><button data-action="add-current-asset">＋ 当前股票</button></div></div>
      ${item.assets.length ? `<div class="sw-asset-list">${item.assets.map((asset, index) => `<article class="sw-asset-row"><div class="sw-stock-name"><strong>${esc(asset.name || asset.symbol)}</strong><span>${esc(asset.symbol)}</span></div>
        ${input(allocation ? '初始权重（%）' : '起始股数', `type="number" min="0" step="${allocation ? '0.1' : '1'}" inputmode="decimal" data-asset="${index}" data-field="${allocation ? 'weight' : 'quantity'}" aria-label="${esc(asset.name)}${allocation ? '权重' : '股数'}"`, allocation ? asset.weight ?? '' : asset.quantity ?? '')}
        <label class="sw-field"><span>${allocation ? '独立策略配置' : '固定股数估值'}</span><select data-asset="${index}" data-field="strategy" aria-label="${esc(asset.name)}运行策略" ${allocation ? '' : 'disabled'}>${!allocation ? '<option value="fixed-shares" selected>固定持有（不运行策略）</option>' : ''}${Object.entries(STRATEGIES).map(([key, label]) => `<option value="${key}" ${allocation && (asset.strategy || 'hold') === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <button class="sw-remove" data-action="remove-asset" data-index="${index}" aria-label="从组合移除${esc(asset.name || asset.symbol)}">移除</button></article>`).join('')}</div>` : '<div class="sw-empty sw-empty-small">添加股票后，填写权重或股数即可计算。默认采用买入持有。</div>'}
      <details class="sw-fees" ${allocation ? '' : 'hidden'}><summary>成交费用与滑点</summary><div class="sw-fee-grid">
        ${input('佣金费率（%）', 'type="number" min="0" max="5" step="0.001" data-fee="commissionRate"', (fees.commissionRate ?? FEE_DEFAULTS.commissionRate) * 100)}
        ${input('每笔最低佣金（元）', 'type="number" min="0" max="10000" step="0.1" data-fee="minCommission"', fees.minCommission ?? 5)}
        ${input('卖出印花税（%）', 'type="number" min="0" max="5" step="0.001" data-fee="stampTaxRate"', (fees.stampTaxRate ?? 0.0005) * 100)}
        ${input('单边滑点（基点）', 'type="number" min="0" max="1000" step="1" data-fee="slippageBps"', fees.slippageBps ?? 5)}
      </div><p class="sw-note">1 基点 = 0.01%。这些是模拟假设，可按实际券商费率调整。非 A 股的交易规则需要对应市场的执行模型。</p></details>
      <div class="sw-run-row"><button class="sw-primary" data-action="run" ${errors.length || state.calculating ? 'disabled' : ''}>${state.calculating ? '组合计算中…' : '计算组合表现'}</button><span>编辑会清除旧结果；计算成功后仍需「保存更改」保存配置。</span></div>
      <div class="sw-validation" id="sw-portfolio-validation" aria-live="polite">${errors.slice(0, 4).map(error => `<p>${esc(error)}</p>`).join('')}</div>
      <div id="sw-result">${state.result && state.resultId === item.id ? resultHTML(state.result, item) : ''}</div>`;
  }
  function chartHTML(result) {
    const series = (result.equity || result.nav || []).map(row => ({ time: row.time || row.date, value: Number(row.value ?? row.equity ?? row.nav) })).filter(row => Number.isFinite(row.value));
    if (series.length < 2 || !(series[0].value > 0)) return '<p class="sw-note">净值序列不足，暂不绘图。</p>';
    const initial = Number(result.initialEquity ?? result.initialNAV ?? result.initialValue) || series[0].value;
    const values = series.map(row => row.value / initial), low = Math.min(...values, 1), high = Math.max(...values, 1), padding = Math.max((high - low) * 0.12, 0.01), min = low - padding, max = high + padding;
    const left = 62, right = 886, top = 20, bottom = 190;
    const x = index => left + (right - left) * index / (values.length - 1), y = value => bottom - (value - min) / (max - min) * (bottom - top);
    const points = values.map((value, index) => `${x(index).toFixed(2)},${y(value).toFixed(2)}`).join(' ');
    const grid = [0, 1, 2, 3].map(index => { const value = min + (max - min) * index / 3, py = y(value); return `<line x1="${left}" y1="${py}" x2="${right}" y2="${py}" stroke="currentColor" opacity=".12"/><text x="${left - 9}" y="${py + 4}" text-anchor="end">${value.toFixed(3)}</text>`; }).join('');
    return `<figure class="sw-chart"><figcaption>组合净值 <span>起点 = 1.000</span></figcaption><svg viewBox="0 0 910 230" role="img" aria-label="组合净值从 ${esc(series[0].time)} 到 ${esc(series[series.length - 1].time)}，期末 ${values[values.length - 1].toFixed(3)}"><title>组合净值曲线</title>${grid}<line x1="${left}" y1="${y(1)}" x2="${right}" y2="${y(1)}" stroke="currentColor" stroke-dasharray="4 5" opacity=".35"/><polyline points="${points}" fill="none" stroke="#C9A84C" stroke-width="2.5" vector-effect="non-scaling-stroke"/><text x="${left}" y="218">${esc(series[0].time)}</text><text x="${right}" y="218" text-anchor="end">${esc(series[series.length - 1].time)}</text></svg></figure>`;
  }
  function resultHTML(result, item) {
    const metrics = result.metrics || result, rows = result.perAsset || result.contributions || result.components || [], meta = result.meta || {};
    const adjustment = meta.adjustment || meta.adjust || result.adjustment || (item.mode === 'shares' ? '不复权价格 · 固定股数估值' : '前复权价格 · 策略成交模拟');
    const value = (row, keys) => { for (const key of keys) if (row[key] != null) return row[key]; return null; };
    const notices = [...(Array.isArray(result.notices) ? result.notices : []), ...(Array.isArray(result.caveats) ? result.caveats : result.caveats ? [result.caveats] : [])];
    return `<section class="sw-result"><div class="sw-metrics">${[['区间收益', metrics.totalReturn], ['年化收益', metrics.annualized ?? metrics.annualizedReturn], ['最大回撤', metrics.maxDrawdown]].map(([label, amount]) => `<div><span>${label}</span><strong class="${label === '最大回撤' ? '' : tone(amount)}">${pct(amount)}</strong></div>`).join('')}</div>
      <p class="sw-note">实际共同区间：${esc(meta.start || result.actualStart || result.start || item.start)} 至 ${esc(meta.end || result.actualEnd || result.end || item.end)}（请求 ${esc(result.requestedStart || item.start)} 至 ${esc(result.requestedEnd || item.end)}）<br>期初总资产 ${fmt(result.initialNAV ?? result.initialValue)} 元 · 期末总资产 ${fmt(result.finalNAV ?? result.finalValue)} 元 · ${item.mode === 'shares' ? '额外现金' : '本金'} ${fmt(item.initialCash)} 元<br>${esc(adjustment)}</p>
      ${chartHTML(result)}
      ${rows.length ? `<h4>各股票的贡献</h4><div class="sw-table-wrap"><table><thead><tr><th>股票</th><th>起始资产</th><th>期末资产</th><th>区间盈亏</th><th>区间收益</th><th>组合贡献</th></tr></thead><tbody>${rows.map(row => { const profit = value(row, ['profit', 'pnl', 'totalProfit']), ret = value(row, ['returnPct', 'totalReturn', 'return']); return `<tr><td>${esc(row.name || row.symbol)}<small>${esc(row.symbol || '')}</small></td><td>${fmt(value(row, ['initialValue', 'initialEquity', 'initialCapital', 'initialNAV']))}</td><td>${fmt(value(row, ['finalValue', 'finalEquity', 'finalCapital', 'finalNAV']))}</td><td class="${tone(profit)}">${fmt(profit)}</td><td class="${tone(ret)}">${pct(ret)}</td><td>${pct(value(row, ['contributionPct', 'contribution', 'contributionPercent']))}</td></tr>`; }).join('')}</tbody></table></div>` : ''}
      <p class="sw-note">历史回测收益不等于实际账户收益。复权数据用于连续价格与信号分析；实际成本、分红到账、成交价格和数量需按真实账户核对。</p>
      ${notices.length ? `<details class="sw-result-notes" open><summary>本次回测说明</summary><ul>${notices.map(notice => `<li>${esc(typeof notice === 'string' ? notice : notice.message || JSON.stringify(notice))}</li>`).join('')}</ul></details>` : ''}</section>`;
  }
  function render() {
    if (!state.root) return;
    const busy = state.loading || state.saving;
    state.root.innerHTML = `<div class="sw-toolbar"><div class="sw-tabs" role="tablist" aria-label="交易工作台"><button id="sw-tab-watchlist" role="tab" aria-controls="sw-panel" aria-selected="${state.tab === 'watchlist'}" tabindex="${state.tab === 'watchlist' ? 0 : -1}" data-action="tab" data-tab="watchlist">自选与持仓${state.data?.watchlist.length ? ` <span>${state.data.watchlist.length}</span>` : ''}</button><button id="sw-tab-portfolio" role="tab" aria-controls="sw-panel" aria-selected="${state.tab === 'portfolio'}" tabindex="${state.tab === 'portfolio' ? 0 : -1}" data-action="tab" data-tab="portfolio">组合回测</button></div><div class="sw-toolbar-actions"><span id="sw-save-state" class="sw-save-state" role="status"></span><button class="sw-save" data-action="save">保存更改</button><button class="sw-collapse" data-action="collapse" aria-expanded="${state.expanded}" aria-controls="sw-panel" aria-label="${state.expanded ? '收起' : '展开'}交易工作台">${state.expanded ? '收起 ∧' : '展开 ∨'}</button></div></div>
      <div id="sw-alert" role="alert" aria-live="polite"></div>
      <div id="sw-panel" class="sw-panel" role="tabpanel" aria-labelledby="sw-tab-${state.tab}" ${state.expanded ? '' : 'hidden'}>${state.loading && !state.data ? '<div class="sw-empty">正在加载你的自选与组合…</div>' : !state.data ? '<div class="sw-empty">工作台尚未加载。<button data-action="reload">重新加载</button></div>' : `<fieldset class="sw-editor" ${busy ? 'disabled' : ''}>${state.tab === 'watchlist' ? watchlistHTML() : portfolioHTML()}</fieldset>`}</div>`;
    updateStatus();
  }
  function updateStatus() {
    if (!state.root) return;
    const status = state.root.querySelector('#sw-save-state'), save = state.root.querySelector('[data-action="save"]'), alert = state.root.querySelector('#sw-alert');
    const errors = state.data ? validateWorkspace(state.data) : [];
    if (status) status.textContent = state.loading ? '加载中…' : state.saving ? '保存中…' : state.conflict ? '存在版本冲突' : state.dirty ? '有未保存更改' : state.data ? (state.activeId === state.temporary?.id && !state.data.portfolios.some(item => item.id === state.activeId) ? '空组合草稿待添加股票' : '已保存到工作台') : '尚未连接';
    if (save) { save.disabled = !state.data || !state.dirty || state.loading || state.saving || state.conflict || !!errors.length; save.title = errors[0] || ''; }
    if (alert) alert.innerHTML = state.conflict ? '<div class="sw-alert sw-alert-warning">其他页面已更新此工作台。你的本页修改仍保留，请核对后重新加载。<button data-action="reload-conflict">加载服务器版本（放弃本页修改）</button></div>' : state.error ? `<div class="sw-alert">${esc(state.error)}${!state.data ? ' <button data-action="reload">重试</button>' : ''}</div>` : state.notice ? `<div class="sw-alert sw-alert-note">${esc(state.notice)}</div>` : state.dirty && errors.length ? `<div class="sw-alert sw-alert-warning">${esc(errors[0])}</div>` : '';
    const run = state.root.querySelector('[data-action="run"]');
    if (run) {
      const item = selectedPortfolio(), errors = validatePortfolio(item);
      run.disabled = state.calculating || state.loading || state.saving || !!errors.length;
      run.textContent = state.calculating ? '组合计算中…' : '计算组合表现';
      const target = state.root.querySelector('#sw-portfolio-validation'); if (target) target.innerHTML = errors.slice(0, 4).map(error => `<p>${esc(error)}</p>`).join('');
      const note = state.root.querySelector('#sw-allocation-note'); if (note && item.mode === 'allocation') { const weight = item.assets.reduce((sum, row) => sum + (Number(row.weight) || 0), 0); note.textContent = `股票初始权重合计 ${fmt(weight)}%，未分配的 ${fmt(Math.max(0, 100 - weight))}% 留作现金。策略在各自资金内运行；策略参数独立于单股面板，新增股票使用模型默认参数。`; }
    }
  }
  async function request(method, body) {
    const response = await global.fetch('/api/workspace', { method, credentials: 'same-origin', headers: { Accept: 'application/json', ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    let payload; try { payload = await response.json(); } catch { payload = {}; }
    if (!response.ok) { const error = new Error((typeof payload.detail === 'string' ? payload.detail : '') || payload.message || payload.error || (response.status === 401 ? '请登录后加载工作台。' : `工作台请求失败（${response.status}）。`)); error.status = response.status; throw error; }
    const data = payload.workspace || payload;
    if (!Array.isArray(data.watchlist) || !Array.isArray(data.portfolios) || data.version == null) throw new Error('工作台返回格式异常，请稍后重新加载。');
    return data;
  }
  function emitChange(source) { global.dispatchEvent(new CustomEvent('stock-workspace-change', { detail: { source, version: state.saved.version, workspace: clone(state.saved) } })); }
  async function reload(options) {
    if (state.loading || state.saving) return;
    if (state.dirty && !options?.discard) { state.error = '本页有未保存修改。请先保存，或使用「加载服务器版本（放弃本页修改）」。'; state.conflict = true; updateStatus(); return; }
    state.loading = true; state.error = ''; render();
    try {
      const data = await request('GET');
      state.data = clone(data); state.saved = clone(data); state.dirty = false; state.conflict = false; state.temporary = null; state.result = null; state.activeId = data.portfolios.some(row => row.id === state.activeId) ? state.activeId : data.portfolios[0]?.id || null;
      emitChange('load');
    } catch (error) { state.error = error.message; }
    finally { state.loading = false; render(); }
  }
  async function save() {
    if (!state.data || !state.dirty || state.saving || state.loading || state.conflict) return;
    const errors = validateWorkspace(state.data); if (errors.length) { state.error = errors[0]; updateStatus(); return; }
    state.saving = true; state.error = ''; render();
    try {
      const data = await request('PUT', workspacePayload(state.data));
      state.data = clone(data); state.saved = clone(data); state.dirty = false; state.notice = state.activeId === state.temporary?.id && !data.portfolios.some(item => item.id === state.activeId) ? '已保存自选、持仓和完整组合配置；当前空组合草稿还需添加股票。' : '已保存自选、持仓和组合配置。'; emitChange('save');
    } catch (error) { if (error.status === 409) state.conflict = true; else state.error = error.message; }
    finally { state.saving = false; render(); }
  }
  function addCurrent() {
    const stock = current();
    if (!stock?.symbol) { state.error = '先在上方搜索并打开一只股票。'; updateStatus(); return; }
    if (state.data.watchlist.some(row => row.symbol === stock.symbol)) { state.notice = '这只股票已在自选中。'; updateStatus(); return; }
    if (!/^(sh|sz)\d{6}$/.test(stock.symbol)) { state.error = '本版工作台支持沪深 A 股。'; updateStatus(); return; }
    if (state.data.watchlist.length >= 100) { state.error = '自选已达 100 只，请移出一只后再添加。'; updateStatus(); return; }
    state.data.watchlist.push({ symbol: stock.symbol, name: stock.name || stock.code || stock.symbol }); markDirty(); render();
  }
  function addAsset(stock) {
    if (!stock?.symbol) { state.error = '请先选择要添加的股票。'; updateStatus(); return; }
    if (!/^(sh|sz)\d{6}$/.test(stock.symbol)) { state.error = '本版组合支持沪深 A 股。'; updateStatus(); return; }
    const item = editablePortfolio();
    if (item.assets.some(row => row.symbol === stock.symbol)) { state.notice = '这只股票已在当前组合中。'; updateStatus(); return; }
    if (item.assets.length >= 20) { state.error = '一个组合最多保存 20 只股票。'; updateStatus(); return; }
    if (!state.data.portfolios.some(row => row.id === item.id) && state.data.portfolios.length >= 30) { state.error = '已保存 30 个组合，请先删除一套配置。'; updateStatus(); return; }
    const remainder = Math.max(0, 100 - item.assets.reduce((sum, row) => sum + (Number(row.weight) || 0), 0));
    const holding = state.data.watchlist.find(row => row.symbol === stock.symbol);
    item.assets.push({ symbol: stock.symbol, name: stock.name || stock.code || stock.symbol, weight: Math.min(25, remainder), quantity: holding?.quantity ?? 0, strategy: 'hold', params: {} });
    if (!state.data.portfolios.some(row => row.id === item.id)) state.data.portfolios.push(item);
    markDirty(); render();
  }
  async function refreshQuotes() {
    if (!state.data || state.quoteLoading) return;
    if (!adapter()?.getBars) { state.error = '行情模块尚未就绪，请稍后重试。'; updateStatus(); return; }
    state.quoteLoading = true; state.error = ''; render();
    const end = new Date(), start = new Date(end); start.setDate(start.getDate() - 45);
    const queue = state.data.watchlist.map(item => ({ ...item })); let failures = 0;
    async function worker() {
      while (queue.length) {
        const item = queue.shift();
        try {
          const response = await adapter().getBars(item.symbol, isoDate(start), isoDate(end), 'raw');
          const bars = Array.isArray(response) ? response : response.bars || response.data || [];
          const last = bars.filter(bar => Number.isFinite(Number(bar.close)) && Number(bar.close) > 0).sort((a, b) => String(a.time || a.date).localeCompare(String(b.time || b.date))).at(-1);
          if (!last) throw new Error('行情为空');
          state.quotes[item.symbol] = { price: Number(last.close), time: last.time || last.date };
        } catch { failures += 1; }
      }
    }
    await Promise.all(Array.from({ length: Math.min(queue.length, 4) }, worker));
    state.quoteLoading = false; if (failures) state.error = `${failures} 只股票的行情估值暂时无法更新，其他结果已保留。`; render();
  }
  async function runPortfolio() {
    const item = selectedPortfolio();
    if (validatePortfolio(item).length || state.calculating) return;
    if (!adapter()?.runPortfolio) { state.error = '组合计算模块尚未就绪，请稍后重试。'; updateStatus(); return; }
    const token = ++state.runToken; state.calculating = true; state.error = ''; state.result = null; render();
    try {
      const result = await adapter().runPortfolio({ ...clone(item), feeOptions: effectiveFees(item) });
      if (token !== state.runToken) return;
      state.result = result; state.resultId = item.id;
    } catch (error) { if (token === state.runToken) state.error = error.message || '组合计算失败，请检查日期与股票数据。'; }
    finally { if (token === state.runToken) { state.calculating = false; render(); } }
  }
  async function onClick(event) {
    const button = event.target.closest('[data-action]'); if (!button || !state.root.contains(button) || button.disabled) return;
    const action = button.dataset.action;
    if (action === 'collapse') { state.expanded = !state.expanded; render(); return; }
    if (action === 'tab') { state.tab = button.dataset.tab; state.expanded = true; render(); state.root.querySelector(`#sw-tab-${state.tab}`)?.focus(); return; }
    if (action === 'reload' || action === 'reload-conflict') { await reload({ discard: action === 'reload-conflict' }); return; }
    if (state.loading || state.saving || !state.data) return;
    state.error = '';
    if (action === 'save') return save();
    if (action === 'add-current') return addCurrent();
    if (action === 'refresh-quotes') return refreshQuotes();
    if (action === 'select-stock') { const item = state.data.watchlist[Number(button.dataset.index)]; try { await adapter().selectStock(item.symbol, item.name); } catch (error) { state.error = error.message || '切换股票失败。'; updateStatus(); } return; }
    if (action === 'remove-watch') { state.data.watchlist.splice(Number(button.dataset.index), 1); markDirty(); render(); return; }
    if (action === 'new-portfolio') { if (state.activeId === state.temporary?.id && !state.data.portfolios.some(item => item.id === state.activeId)) { state.notice = '请先为当前空草稿添加股票，或放弃它。'; updateStatus(); return; } state.temporary = newPortfolio(); state.activeId = state.temporary.id; state.result = null; state.runToken++; state.calculating = false; render(); return; }
    if (action === 'discard-draft') { state.temporary = null; state.activeId = state.data.portfolios[0]?.id || null; state.result = null; state.runToken++; state.calculating = false; render(); return; }
    if (action === 'delete-portfolio') { const item = selectedPortfolio(); state.data.portfolios = state.data.portfolios.filter(row => row.id !== item.id); state.activeId = state.data.portfolios[0]?.id || null; state.temporary = null; markDirty(); render(); return; }
    if (action === 'add-current-asset') return addAsset(current());
    if (action === 'add-watch-asset') { const symbol = state.root.querySelector('#sw-add-symbol').value; return addAsset(state.data.watchlist.find(row => row.symbol === symbol)); }
    if (action === 'remove-asset') { editablePortfolio().assets.splice(Number(button.dataset.index), 1); markDirty(); render(); return; }
    if (action === 'run') return runPortfolio();
  }
  function updateHoldingPreview(index) {
    const item = state.data.watchlist[index], input = state.root.querySelector(`[data-watch="${index}"]`), target = input?.closest('.sw-watch-row')?.querySelector('.sw-holding-pnl');
    if (!item || !target) return;
    const quote = state.quotes[item.symbol], quantity = number(item.quantity), cost = number(item.avgCost);
    const profit = quote && quantity > 0 && cost > 0 ? (quote.price - cost) * quantity : null, rate = profit != null ? (quote.price / cost - 1) * 100 : null;
    target.innerHTML = `<span>现持仓浮盈</span><strong class="${tone(profit)}">${profit == null ? '—' : `${profit > 0 ? '+' : ''}${fmt(profit)} 元`}</strong><small class="${tone(rate)}">${pct(rate)}</small><small>${quote ? `${esc(quote.time)} 参考价 ${fmt(quote.price)}` : '等待行情估值'}</small>`;
  }
  function onChange(event) {
    const target = event.target; if (!state.data || state.saving || state.loading) return;
    if (target.dataset.config === 'activeId') { if (event.type !== 'change') return; state.activeId = target.value; state.result = null; state.runToken++; state.calculating = false; render(); return; }
    if (target.dataset.watch != null) { const index = Number(target.dataset.watch), item = state.data.watchlist[index]; const value = number(target.value); if (value == null) delete item[target.dataset.field]; else item[target.dataset.field] = value; markDirty(); updateHoldingPreview(index); return; }
    if (target.dataset.portfolio) {
      const item = editablePortfolio(), key = target.dataset.portfolio;
      if (key === 'mode' && event.type !== 'change') return;
      item[key] = key === 'initialCash' ? number(target.value) : target.value;
      if (key === 'mode') item.initialCash = target.value === 'shares' ? 0 : 1000000;
      markDirty(); if (key === 'mode') render(); return;
    }
    if (target.dataset.asset != null) { const item = editablePortfolio().assets[Number(target.dataset.asset)], key = target.dataset.field; item[key] = key === 'strategy' ? target.value : number(target.value); markDirty(); return; }
    if (target.dataset.fee) { const item = editablePortfolio(), key = target.dataset.fee; item.feeOptions ||= {}; const value = number(target.value); item.feeOptions[key] = value == null ? undefined : ['commissionRate', 'stampTaxRate'].includes(key) ? value / 100 : value; markDirty(); }
  }
  function mount(target) {
    if (state.root?.isConnected) return state.root;
    const root = document.createElement('section'); root.id = 'stockWorkspace'; root.setAttribute('aria-label', '我的交易工作台');
    if (target?.appendChild) target.appendChild(root);
    else { const anchor = document.querySelector('#topbar'); if (anchor) anchor.insertAdjacentElement('afterend', root); else (document.querySelector('#app') || document.body).prepend(root); }
    state.root = root;
    root.addEventListener('click', onClick); root.addEventListener('input', onChange); root.addEventListener('change', onChange);
    root.addEventListener('keydown', event => { if (event.target.getAttribute('role') !== 'tab' || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return; event.preventDefault(); state.tab = event.key === 'Home' ? 'watchlist' : event.key === 'End' ? 'portfolio' : state.tab === 'watchlist' ? 'portfolio' : 'watchlist'; state.expanded = true; render(); root.querySelector(`#sw-tab-${state.tab}`)?.focus(); });
    render(); reload(); return root;
  }
  global.StockWorkspace = { mount, reload, getHolding(symbol) { const item = state.saved?.watchlist.find(row => row.symbol === symbol); return item ? clone(item) : null; }, getSnapshot() { return state.saved ? clone(state.saved) : null; } };
  if (typeof module !== 'undefined' && module.exports) module.exports = { validatePortfolio, validateWorkspace, chartHTML, resultHTML, esc, number, workspacePayload, effectiveFees, testController: { state, onClick, onChange, save, request } };
})(typeof window !== 'undefined' ? window : globalThis);
