/* Small, responsive NAV charts. Values come from the existing backtest engines. */
(function (global) {
  'use strict';
  const escapeHTML = value => String(value == null ? '' : value).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const normalized = (rows, initialValue) => {
    const series = (rows || []).map(row => ({ time: String(row.time || row.date || ''), value: Number(row.value ?? row.equity ?? row.nav) })).filter(row => Number.isFinite(row.value));
    const initial = Number(initialValue) || series[0]?.value;
    return initial > 0 ? series.map(row => ({ time: row.time, value: row.value / initial })) : [];
  };
  function geometry(series, width) {
    const w = Math.max(240, Math.round(width || 360)), h = 220;
    const left = 50, right = w - 12, top = 18, bottom = h - 34;
    const low = Math.min(1, ...series.map(row => row.value)), high = Math.max(1, ...series.map(row => row.value));
    const padding = Math.max((high - low) * .12, .01), min = low - padding, max = high + padding;
    const x = index => left + (right - left) * index / Math.max(1, series.length - 1);
    const y = value => bottom - (value - min) / (max - min) * (bottom - top);
    return { w, h, left, right, top, bottom, min, max, x, y };
  }
  function svgHTML(series, width, selected, title) {
    const g = geometry(series, width), point = series[selected] || series.at(-1);
    const points = series.map((row, i) => `${g.x(i).toFixed(2)},${g.y(row.value).toFixed(2)}`).join(' ');
    const grid = [0, 1, 2].map(i => { const value = g.min + (g.max - g.min) * i / 2, py = g.y(value); return `<line x1="${g.left}" x2="${g.right}" y1="${py}" y2="${py}" stroke="var(--border, #e6e7e8)"/><text x="${g.left - 8}" y="${py + 4}" text-anchor="end">${value.toFixed(2)}</text>`; }).join('');
    const midpoint = g.w >= 500 ? `<text x="${g.x(Math.floor((series.length - 1) / 2))}" y="${g.h - 10}" text-anchor="middle">${escapeHTML(series[Math.floor((series.length - 1) / 2)].time)}</text>` : '';
    const aria = `${title}从 ${series[0].time} 到 ${series.at(-1).time}，期末 ${series.at(-1).value.toFixed(3)}`;
    return `<svg viewBox="0 0 ${g.w} ${g.h}" width="100%" height="${g.h}" role="img" aria-label="${escapeHTML(aria)}" style="display:block;width:100%;height:${g.h}px;max-height:none;color:var(--text-secondary,#72757c)"><title>${escapeHTML(aria)}</title><g font-family="system-ui,sans-serif" font-size="11" fill="currentColor">${grid}<polygon points="${g.left},${g.bottom} ${points} ${g.right},${g.bottom}" fill="var(--chart-fill,#eadbd3)" opacity=".45"/><line x1="${g.left}" x2="${g.right}" y1="${g.y(1)}" y2="${g.y(1)}" stroke="var(--text-secondary,#72757c)" stroke-dasharray="3 4" opacity=".5"/><polyline points="${points}" fill="none" stroke="var(--chart-line,#8a4b38)" stroke-width="2" vector-effect="non-scaling-stroke"/><line class="quant-chart-crosshair" x1="${g.x(selected)}" x2="${g.x(selected)}" y1="${g.top}" y2="${g.bottom}" stroke="var(--text-secondary,#72757c)" stroke-dasharray="3 4" opacity=".5"/><circle class="quant-chart-point" cx="${g.x(selected)}" cy="${g.y(point.value)}" r="4" fill="var(--chart-line,#8a4b38)" stroke="var(--bg-card,#fff)" stroke-width="2"/><text x="${g.left}" y="${g.h - 10}">${escapeHTML(series[0].time)}</text>${midpoint}<text x="${g.right}" y="${g.h - 10}" text-anchor="end">${escapeHTML(series.at(-1).time)}</text></g></svg>`;
  }
  function readout(series, index) {
    const row = series[index], change = (row.value - 1) * 100;
    return `${row.time} · 净值 ${row.value.toFixed(3)} · ${change > 0 ? '+' : ''}${change.toFixed(2)}%`;
  }
  function html(rows, options) {
    const opts = options || {}, series = normalized(rows, opts.initialValue);
    if (series.length < 2) return '<p class="audit-note sw-note">净值序列不足，暂不绘图。</p>';
    const title = opts.title || '回测净值', index = series.length - 1;
    return `<figure class="${escapeHTML(opts.className || '')} quant-nav-chart" data-quant-series="${escapeHTML(JSON.stringify(series))}" data-chart-title="${escapeHTML(title)}"><figcaption>${escapeHTML(title)} <span>初始本金 = 1.000</span></figcaption><output class="quant-chart-readout">${escapeHTML(readout(series, index))}</output><div class="quant-chart-stage">${svgHTML(series, 360, index, title)}</div><label class="quant-chart-control"><span class="quant-chart-hint">拖动查看每日净值</span><input class="quant-chart-slider" type="range" min="0" max="${index}" step="1" value="${index}" aria-label="${escapeHTML(title)}：选择交易日" aria-valuetext="${escapeHTML(readout(series, index))}" style="display:block;width:100%;min-height:44px;accent-color:var(--chart-line,#8a4b38)"></label></figure>`;
  }
  const mounted = new Map();
  let resizeObserver;
  function paint(figure, entry) {
    const stage = figure.querySelector('.quant-chart-stage');
    if (!stage) return;
    const width = stage.clientWidth || figure.clientWidth;
    if (!width) return;
    const rounded = Math.round(width);
    if (entry.width === rounded) return;
    entry.width = rounded;
    stage.innerHTML = svgHTML(entry.series, rounded, entry.selected, entry.title);
  }
  function hydrate(root) {
    if (!root?.querySelectorAll) return;
    for (const [figure] of mounted) if (!figure.isConnected) { resizeObserver?.unobserve(figure); mounted.delete(figure); }
    if (!resizeObserver && global.ResizeObserver) resizeObserver = new global.ResizeObserver(entries => { for (const observed of entries) { const data = mounted.get(observed.target); if (data) paint(observed.target, data); } });
    root.querySelectorAll('.quant-nav-chart').forEach(figure => {
      if (mounted.has(figure)) return;
      let series; try { series = JSON.parse(figure.dataset.quantSeries); } catch { return; }
      if (!Array.isArray(series) || series.length < 2) return;
      const entry = { series, title: figure.dataset.chartTitle || '回测净值', selected: series.length - 1, width: 0 };
      mounted.set(figure, entry);
      const slider = figure.querySelector('.quant-chart-slider'), output = figure.querySelector('.quant-chart-readout');
      slider?.addEventListener('input', () => {
        entry.selected = Math.max(0, Math.min(series.length - 1, Number(slider.value)));
        const text = readout(series, entry.selected); output.textContent = text; slider.setAttribute('aria-valuetext', text);
        const g = geometry(series, entry.width), marker = figure.querySelector('.quant-chart-point'), line = figure.querySelector('.quant-chart-crosshair');
        marker?.setAttribute('cx', g.x(entry.selected)); marker?.setAttribute('cy', g.y(series[entry.selected].value));
        line?.setAttribute('x1', g.x(entry.selected)); line?.setAttribute('x2', g.x(entry.selected));
      });
      paint(figure, entry); resizeObserver?.observe(figure);
    });
  }
  if (global.addEventListener) global.addEventListener('resize', () => { for (const [figure, entry] of mounted) if (figure.isConnected) paint(figure, entry); });
  global.StockResponsiveChart = { html, hydrate, normalized, geometry };
  if (typeof module !== 'undefined' && module.exports) module.exports = global.StockResponsiveChart;
})(typeof window !== 'undefined' ? window : globalThis);
