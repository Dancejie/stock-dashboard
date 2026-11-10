/* Presentation only: share the same app state across the three mobile views. */
(() => {
  const app = document.getElementById('app');
  const media = window.matchMedia('(max-width: 700px)');
  const nav = document.querySelector('.mobile-nav');
  if (!app || !nav) return;
  app.classList.add('mobile-ui-ready');
  const settings = document.getElementById('executionSettings');
  if (settings) {
    const advanced = document.createElement('details');
    advanced.className = 'execution-advanced';
    advanced.innerHTML = '<summary>费用、滑点与无风险假设</summary><div class="audit-form"></div>';
    ['btCommission','btMinFee','btTax','btSlip','btRf'].forEach(id => {
      const label = document.getElementById(id)?.closest('label');
      if (label) advanced.lastElementChild.append(label);
    });
    settings.append(advanced);
  }
  const strategyTitle = document.querySelector('#backtestCard .card-title');
  const context = document.createElement('p'); context.className = 'strategy-context';
  strategyTitle.insertAdjacentElement('afterend', context);
  const updateContext = () => {
    const selected = window.StockApp?.getCurrent?.();
    context.textContent = selected ? `当前标的：${selected.name} · ${selected.code}` : '请先搜索并选择股票';
  };
  updateContext(); window.addEventListener('stock-selection-change', updateContext);
  const positions = { market: 0, strategy: 0, workspace: 0 };
  function show(view) {
    if (!['market','strategy','workspace'].includes(view)) return;
    positions[app.dataset.mobileView] = window.scrollY;
    app.dataset.mobileView = view;
    nav.querySelectorAll('button').forEach(button => {
      if (button.dataset.view === view) button.setAttribute('aria-current','page');
      else button.removeAttribute('aria-current');
    });
    requestAnimationFrame(() => {
      if (media.matches) window.scrollTo({ top: positions[view], behavior: 'instant' });
      handleResize();
      window.dispatchEvent(new Event('quant-layout-change'));
    });
  }
  nav.addEventListener('click', event => {
    const button = event.target.closest('[data-view]');
    if (button) show(button.dataset.view);
  });
  window.addEventListener('stock-selection-change', () => {
    if (media.matches && app.dataset.mobileView === 'workspace') show('market');
  });
  // Keep a keyboard focus target and form name for all parameter inputs.
  document.querySelectorAll('.bt-field').forEach(field => {
    const label = field.querySelector('label'), input = field.querySelector('input,select');
    if (label && input?.id) label.htmlFor = input.id;
  });
  const cards = document.querySelector('.strategy-cards');
  const updatePressed = () => cards.querySelectorAll('.strat-card').forEach(button => button.setAttribute('aria-pressed', String(button.classList.contains('active'))));
  updatePressed(); cards.addEventListener('click', updatePressed);
  // Size the canvas after visible card changes, including phone rotation.
  const chart = document.getElementById('mainChartWrap');
  new ResizeObserver(() => { if (chart.clientWidth) requestAnimationFrame(handleResize); }).observe(chart);
  media.addEventListener('change', () => { requestAnimationFrame(handleResize); window.dispatchEvent(new Event('quant-layout-change')); });
})();
