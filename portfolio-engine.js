(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(function () { return require('./quant-core.js'); });
  else root.StockPortfolio = factory(function () { return root.StockQuant; });
})(typeof globalThis !== 'undefined' ? globalThis : this, function (getCore) {
  'use strict';

  var DAY = 86400000;
  function fail(message) { throw new Error(message); }
  function number(value, label, min) {
    var n = Number(value);
    if (value === null || value === '' || !Number.isFinite(n) || n < (min === undefined ? 0 : min)) fail(label + '无效');
    return n;
  }
  function date(value, label) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value + 'T00:00:00Z')) || new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) !== value) fail((label || '日期') + '无效');
    return value;
  }
  function core() {
    var q = getCore();
    if (!q || typeof q.run !== 'function') fail('StockQuant 回测引擎未加载');
    return q;
  }
  function bars(input, symbol, requireRaw) {
    var rows = Array.isArray(input) ? input : input && input.bars;
    if (!Array.isArray(rows) || !rows.length) fail(symbol + ' 缺少行情');
    var adjustment = input.adjustment || (input.meta && input.meta.adjustment);
    if (requireRaw && adjustment && !['raw', 'none'].includes(adjustment)) fail(symbol + ' 固定股数回测需要未复权价格');
    var seen = new Set();
    return rows.map(function (row) {
      var time = date(row.time, symbol + ' 行情日期');
      if (seen.has(time)) fail(symbol + ' 行情日期重复: ' + time);
      seen.add(time);
      var close = number(row.close, symbol + ' 收盘价', Number.MIN_VALUE);
      return Object.assign({}, row, { time: time, close: close });
    }).sort(function (a, b) { return a.time.localeCompare(b.time); });
  }
  function metrics(equity, initialValue) {
    if (!(initialValue > 0) || !equity.length) fail('组合初始净值或行情为空');
    var peak = initialValue, maxDrawdown = 0;
    equity.forEach(function (point) {
      if (!Number.isFinite(point.value) || point.value < 0) fail('组合净值无效');
      peak = Math.max(peak, point.value);
      maxDrawdown = Math.max(maxDrawdown, (peak - point.value) / peak * 100);
    });
    var finalValue = equity[equity.length - 1].value;
    var days = (Date.parse(equity[equity.length - 1].time) - Date.parse(equity[0].time)) / DAY;
    return {
      initialValue: initialValue, finalValue: finalValue,
      totalReturn: (finalValue / initialValue - 1) * 100,
      annualized: days > 0 ? (Math.pow(finalValue / initialValue, 365.25 / days) - 1) * 100 : null,
      maxDrawdown: maxDrawdown
    };
  }
  function calculate(spec) {
    spec = spec || {};
    if (!['allocation', 'shares'].includes(spec.mode)) fail('组合模式必须为 allocation 或 shares');
    var start = date(spec.start, '开始日期'), end = date(spec.end, '结束日期');
    if (start > end) fail('开始日期不能晚于结束日期');
    if (!Array.isArray(spec.assets) || !spec.assets.length) fail('请添加组合股票');
    var initialCash = number(spec.initialCash === undefined ? 0 : spec.initialCash, '初始现金');
    if (spec.mode === 'allocation' && initialCash <= 0) fail('分配模式需要大于零的总本金');
    var symbols = new Set(), totalWeight = 0;
    var assets = spec.assets.map(function (asset) {
      if (!asset || typeof asset.symbol !== 'string' || !asset.symbol.trim()) fail('股票代码不能为空');
      var symbol = asset.symbol.trim();
      if (symbols.has(symbol)) fail('股票代码重复: ' + symbol);
      symbols.add(symbol);
      var active = Object.assign({}, asset, { symbol: symbol });
      if (spec.mode === 'allocation') {
        active.weight = number(asset.weight, symbol + ' 权重');
        totalWeight += active.weight;
      } else {
        active.quantity = number(asset.quantity, symbol + ' 股数');
        if (!Number.isInteger(active.quantity)) fail(symbol + ' 固定股数必须为整数');
      }
      return active;
    }).filter(function (asset) { return spec.mode === 'allocation' ? asset.weight > 0 : asset.quantity > 0; });
    if (totalWeight > 100 + 1e-9) fail('组合权重之和不能超过 100%');
    if (!assets.length) fail('组合至少需要一只正权重或正持股数的股票');

    var source = spec.barsBySymbol || {}, data = {}, maps = {}, notices = [];
    assets.forEach(function (asset) {
      var rows = bars(source[asset.symbol], asset.symbol, spec.mode === 'shares');
      data[asset.symbol] = rows;
      maps[asset.symbol] = new Map(rows.map(function (row) { return [row.time, row]; }));
    });
    var common = data[assets[0].symbol].map(function (row) { return row.time; }).filter(function (time) {
      return time >= start && time <= end && assets.every(function (asset) { return maps[asset.symbol].has(time); });
    });
    if (!common.length) fail('所选区间没有所有股票共同的行情日期');
    var actualStart = common[0], actualEnd = common[common.length - 1];
    if (actualStart !== start || actualEnd !== end) notices.push('实际共同回测区间为 ' + actualStart + ' 至 ' + actualEnd + '（请求 ' + start + ' 至 ' + end + '）');
    var calendar = new Set();
    assets.forEach(function (asset) {
      data[asset.symbol].forEach(function (row) { if (row.time >= actualStart && row.time <= actualEnd) calendar.add(row.time); });
    });
    // A supplied exchange calendar can detect gaps shared by all symbols as well.
    if (spec.executionOptions && Array.isArray(spec.executionOptions.calendar)) spec.executionOptions.calendar.forEach(function (time) {
      date(time, '交易日历日期');
      if (time >= actualStart && time <= actualEnd) calendar.add(time);
    });
    var dates = Array.from(calendar).sort();
    dates.forEach(function (time) {
      assets.forEach(function (asset) {
        if (!maps[asset.symbol].has(time)) fail(asset.symbol + ' 在 ' + time + ' 缺少行情；未确认停牌，不能向前或向后填充成交数据');
      });
    });
    var unallocatedCash = spec.mode === 'allocation' ? Math.max(0, initialCash - assets.reduce(function (sum, asset) { return sum + initialCash * asset.weight / 100; }, 0)) : initialCash;
    var results = [], initialValue = initialCash;
    assets.forEach(function (asset) {
      var result, initialCapital;
      if (spec.mode === 'allocation') {
        initialCapital = initialCash * asset.weight / 100;
        var options = Object.assign({}, spec.executionOptions || {}, { initialCash: initialCapital, start: actualStart, end: actualEnd });
        if (options.limitPct === undefined) options.limitPct = /^(?:sz30[01]|sh688)/.test(asset.symbol) ? 20 : 10;
        // Caller indices must never override the shared evaluation dates.
        delete options.startIndex; delete options.endIndex; delete options.calendar;
        result = core().run(data[asset.symbol], asset.strategy || 'hold', Object.assign({}, asset.params || {}), options);
      } else {
        initialCapital = asset.quantity * maps[asset.symbol].get(actualStart).close;
        initialValue += initialCapital;
        result = { equity: dates.map(function (time) {
          return { time: time, value: asset.quantity * maps[asset.symbol].get(time).close, cash: 0, shares: asset.quantity };
        }), finalCash: 0, finalShares: asset.quantity, trades: [], fills: [] };
      }
      if (!result || !Array.isArray(result.equity)) fail(asset.symbol + ' 回测结果缺失');
      var equityMap = new Map(result.equity.map(function (point) { return [point.time, point]; }));
      dates.forEach(function (time) { if (!equityMap.has(time)) fail(asset.symbol + ' 回测净值日期不完整: ' + time); });
      var cleanEquity = dates.map(function (time) { return equityMap.get(time); });
      var assetMetrics = metrics(cleanEquity, initialCapital);
      var lastPoint = cleanEquity[cleanEquity.length - 1];
      results.push(Object.assign({}, assetMetrics, {
        symbol: asset.symbol, name: asset.name || asset.symbol,
        weight: spec.mode === 'allocation' ? asset.weight : null,
        strategy: spec.mode === 'allocation' ? (asset.strategy || 'hold') : 'fixed-shares',
        initialCapital: initialCapital, finalCash: Number(lastPoint.cash || 0), finalShares: Number(lastPoint.shares || 0),
        cash: Number(lastPoint.cash || 0), shares: Number(lastPoint.shares || 0),
        equity: cleanEquity, trades: result.trades || [], fills: result.fills || [], _map: equityMap
      }));
    });
    var equity = dates.map(function (time) {
      var value = unallocatedCash, cash = unallocatedCash, contributions = {}, sharesBySymbol = {};
      results.forEach(function (result) {
        var point = result._map.get(time);
        value += point.value;
        cash += Number(point.cash || 0);
        contributions[result.symbol] = point.value;
        sharesBySymbol[result.symbol] = Number(point.shares || 0);
      });
      return { time: time, value: value, cash: cash, contributions: contributions, sharesBySymbol: sharesBySymbol };
    });
    results.forEach(function (result) {
      delete result._map;
      result.profit = result.finalValue - result.initialCapital;
      result.contributionPct = result.profit / initialValue * 100;
      result.returnPct = result.totalReturn;
    });
    var summary = metrics(equity, initialValue);
    return Object.assign({}, summary, {
      mode: spec.mode, requestedStart: start, requestedEnd: end, actualStart: actualStart, actualEnd: actualEnd,
      initialNAV: initialValue, finalNAV: summary.finalValue, initialCash: initialCash, unallocatedCash: unallocatedCash,
      totalWeight: spec.mode === 'allocation' ? totalWeight : null,
      equity: equity, perAsset: results, assets: results, notices: notices,
      caveats: spec.mode === 'shares'
        ? ['固定股数价格收益：未计分红、拆股或其他公司行为；成本均价不参与历史净值。', '缺少完整交易日历时，只能识别股票之间不一致的行情缺口。']
        : ['起始资金分配一次，之后不自动恢复权重；各股票账户独立。', '公司行为处理取决于输入行情口径；未另行叠加分红或拆股。', '缺少完整交易日历时，只能识别股票之间不一致的行情缺口。']
    });
  }

  function holdingsSummary(items, pricesBySymbol) {
    if (!Array.isArray(items)) fail('持仓列表无效');
    var seen = new Set();
    var rows = items.map(function (item) {
      if (!item || !item.symbol || seen.has(item.symbol)) fail('持仓股票代码缺失或重复');
      seen.add(item.symbol);
      var quantity = number(item.quantity, item.symbol + ' 股数');
      var avgCost = number(item.avgCost, item.symbol + ' 持仓均价');
      var quote = (pricesBySymbol || {})[item.symbol];
      var price = number(quote && typeof quote === 'object' ? (quote.price === undefined ? quote.close : quote.price) : quote, item.symbol + ' 当前价格', Number.MIN_VALUE);
      var cost = quantity * avgCost, value = quantity * price;
      return { symbol: item.symbol, name: item.name || item.symbol, quantity: quantity, avgCost: avgCost, price: price,
        costBasis: cost, marketValue: value, unrealizedPnL: value - cost, unrealizedReturn: cost > 0 ? (value / cost - 1) * 100 : null };
    });
    var cost = rows.reduce(function (sum, row) { return sum + row.costBasis; }, 0);
    var value = rows.reduce(function (sum, row) { return sum + row.marketValue; }, 0);
    return { assets: rows, totalCost: cost, totalMarketValue: value, totalPnL: value - cost,
      totalReturn: cost > 0 ? (value / cost - 1) * 100 : null,
      caveat: '这是按手填成本计算的当前浮盈亏，不是所选历史区间的回测收益；未含历史分红及费用。' };
  }

  function walkForward(input, strategy, params, options) {
    params = Object.assign({}, params || {}); options = options || {};
    var q = core(), data = bars(input, 'WFA', false);
    var trainBars = options.trainBars === undefined ? (data.length >= 756 ? 504 : Math.floor(data.length * 0.67)) : number(options.trainBars, '训练窗口', 2);
    var testBars = options.testBars === undefined ? (data.length >= 756 ? 252 : data.length - trainBars) : number(options.testBars, '验证窗口', 1);
    if (!Number.isInteger(trainBars) || !Number.isInteger(testBars) || trainBars < 2 || trainBars + testBars > data.length) fail('数据不足以组成训练和验证窗口');
    var engineOptions = Object.assign({}, options.executionOptions || {});
    ['initialCash', 'commissionRate', 'minCommission', 'stampTaxRate', 'slippageBps', 'lotSize', 'riskFreeRate', 'limitPct'].forEach(function (key) {
      if (options[key] !== undefined) engineOptions[key] = options[key];
    });
    delete engineOptions.start; delete engineOptions.end; delete engineOptions.startIndex; delete engineOptions.endIndex;
    var folds = [];
    for (var offset = 0; offset + trainBars + testBars <= data.length; offset += testBars) {
      var train = data.slice(offset, offset + trainBars);
      var test = data.slice(offset + trainBars, offset + trainBars + testBars);
      var trainingHistory = data.slice(0, offset + trainBars);
      var chosen = Object.assign({}, params), trainResult, candidateCount = 1;
      if (strategy === 'grid' && options.optimizeGrid !== false) {
        var search = options.gridSearch || {};
        var steps = search.steps || [2, 3, 5, 7, 10], downs = search.downs || [3, 5, 8, 10];
        var ups = search.ups || [3, 5, 8, 10], lots = search.lots || [10, 50, 100, 200];
        if (![steps, downs, ups, lots].every(function (v) { return Array.isArray(v) && v.length; })) fail('网格寻优范围为空');
        // Base is known on the first training day and is frozen along with other parameters.
        var base = params.base === undefined ? number(train[0].open, '网格起始开盘价', Number.MIN_VALUE) : number(params.base, '网格基准价', Number.MIN_VALUE);
        candidateCount = 0;
        steps.forEach(function (step) { downs.forEach(function (gridDown) { ups.forEach(function (gridUp) { lots.forEach(function (lotBuy) {
          var candidate = Object.assign({}, params, { base: base, step: step, gridDown: gridDown, gridUp: gridUp, lotBuy: lotBuy });
          var evaluation = q.run(trainingHistory, strategy, candidate, Object.assign({}, engineOptions, { start: train[0].time, end: train[train.length - 1].time }));
          candidateCount++;
          if (!trainResult || (Number.isFinite(evaluation.sharpe) ? evaluation.sharpe : -Infinity) > (Number.isFinite(trainResult.sharpe) ? trainResult.sharpe : -Infinity)) {
            trainResult = evaluation; chosen = candidate;
          }
        }); }); }); });
      } else {
        if (strategy === 'grid' && chosen.base === undefined) chosen.base = number(train[0].open, '网格起始开盘价', Number.MIN_VALUE);
        trainResult = q.run(trainingHistory, strategy, chosen, Object.assign({}, engineOptions, { start: train[0].time, end: train[train.length - 1].time }));
      }
      // All known preceding bars warm up the indicators. start prevents any pre-test trade.
      var historyAndTest = data.slice(0, offset + trainBars + testBars);
      var testResult = q.run(historyAndTest, strategy, Object.assign({}, chosen), Object.assign({}, engineOptions, { start: test[0].time, end: test[test.length - 1].time }));
      folds.push({ window: folds.length + 1, trainStart: train[0].time, trainEnd: train[train.length - 1].time,
        testStart: test[0].time, testEnd: test[test.length - 1].time,
        params: Object.assign({}, chosen), candidateCount: candidateCount,
        trainReturn: trainResult.totalReturn, trainSharpe: trainResult.sharpe,
        testReturn: testResult.totalReturn, testSharpe: testResult.sharpe,
        testTrades: testResult.tradeCount === undefined ? (testResult.trades || []).length : testResult.tradeCount,
        testWinRate: testResult.winRate, trainResult: trainResult, testResult: testResult });
    }
    var covered = folds.length * testBars;
    return { windows: folds, totalWindows: folds.length, trainBars: trainBars, testBars: testBars,
      mode: 'independent-fold-diagnostic', continuous: false, optimized: strategy === 'grid' && options.optimizeGrid !== false,
      testedBars: covered, trailingUntestedBars: data.length - trainBars - covered,
      status: '样本外分窗诊断',
      caveats: ['每个验证窗口从相同现金重新开始；窗口收益不能相加或当作连续组合收益。', '参数只在训练期确定；验证期不寻优，不按训练收益宣布策略有效。', '网格参数搜索次数已披露；仍需未参与选择的最终留出区间。'] };
  }
  return { calculate: calculate, holdingsSummary: holdingsSummary, walkForward: walkForward };
});
