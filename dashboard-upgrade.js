/* Shared data/time conventions for the existing dashboard and saved workspace. */
(function () {
  'use strict';
  const labels = {hold:'买入持有',mr:'均值回归',turtle:'海龟突破',ma:'双均线',boll:'布林带',td:'TD序列',grid:'网格',supertrend:'超级趋势',tsmom:'波动率约束动量',chandelier:'突破与吊灯止损'};
  const clean = v => String(v == null ? '' : v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const num = (v,d=2) => Number.isFinite(Number(v)) ? Number(v).toFixed(d) : '—';
  const pct = v => Number.isFinite(Number(v)) ? (v>0?'+':'')+num(v)+'%' : '—';
  let requestVersion = 0, calculationVersion = 0, quoteNow = null, lastPlan = null, lastResult = null;
  const cache = new Map();
  const warmStart = day => [offset(day,-560),'2000-01-01'].sort().at(-1);
  const today = () => new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Shanghai'});
  const offset = (day,days) => { const d=new Date(day+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+days);return d.toISOString().slice(0,10); };
  const val = (id,fallback) => {const n=Number(document.getElementById(id)?.value);return Number.isFinite(n)&&document.getElementById(id)?.value!==''?n:fallback;};
  async function api(path,options) {
    const r=await fetch(path,{credentials:'same-origin',...options});
    const data=await r.json().catch(()=>({}));
    if (!r.ok) throw new Error(typeof data.detail==='string'?data.detail:'请求失败 ('+r.status+')');
    return data;
  }
  async function getBars(symbol,start,end,adjust='qfq') {
    const key=[symbol,start,end,adjust].join('|'), old=cache.get(key);
    if (old && Date.now()-old.time<60000) return old.data;
    const result=await api('/api/market/bars?'+new URLSearchParams({symbol,start,end,adjust}));
    result.meta.adjustment=result.meta.adjust;
    cache.set(key,{time:Date.now(),data:result});
    return result;
  }
  function datesForRange(range) {
    const end=today(),d=new Date(end+'T00:00:00Z');
    if (/mo$/.test(range)) d.setUTCMonth(d.getUTCMonth()-Number(range.replace('mo','')));
    else d.setUTCFullYear(d.getUTCFullYear()-Number(range.replace('y','')));
    return {start:d.toISOString().slice(0,10),end};
  }
  function config() {
    return {initialCash:val('btCash',1000000),commissionRate:val('btCommission',.03)/100,
      minCommission:val('btMinFee',5),stampTaxRate:val('btTax',.05)/100,slippageBps:val('btSlip',5),lotSize:/^sh688/.test(S.sinaSymbol)?200:100,
      limitPct: /^(sz30|sh68)/.test(S.sinaSymbol)?20:10,riskFreeRate:val('btRf',0)/100};
  }
  function params(key) {
    if(key==='mr')return {threshold:val('btThreshold',25),batches:val('btBatches',3),tp1:val('btTP1',50),tp2:val('btTP2',100),tp3:val('btTP3',150),stopLoss:val('btSL',30),smaPeriod:60};
    if(key==='ma')return {shortN:val('btMAShort',5),longN:val('btMALong',20)};
    if(key==='boll')return {period:val('btBollPeriod',20),mult:val('btBollMult',2)};
    if(key==='grid')return {step:val('gridStep',5),gridDown:val('gridDown',5),gridUp:val('gridUp',5),lotBuy:val('gridLotBuy',100)};
    if(key==='supertrend')return {atrPeriod:val('btSTPeriod',10),mult:val('btSTMult',3)};
    if(key==='tsmom')return {lookback:val('btMomLookback',126),volPeriod:val('btMomVolPeriod',20),targetVol:val('btMomTargetVol',15),maxAllocation:val('btMomMaxAllocation',95)};
    if(key==='chandelier')return {entryPeriod:val('btCEEntry',55),atrPeriod:val('btCEATR',22),mult:val('btCEMult',3),riskPct:val('btCERisk',1)};
    return {};
  }
  function sparkline(equity) {
    if(!equity.length)return '';
    const values=equity.map(e=>e.value),min=Math.min(...values),max=Math.max(...values),span=max-min||1;
    const points=equity.map((e,i)=>(8+i/Math.max(1,equity.length-1)*704).toFixed(2)+','+(148-(e.value-min)/span*130).toFixed(2)).join(' ');
    return `<svg class="audit-nav" viewBox="0 0 720 164" role="img" aria-label="回测净值曲线"><line x1="8" x2="712" y1="148" y2="148" stroke="#444"/><polyline points="${points}" fill="none" stroke="#cfab50" stroke-width="2"/></svg>`;
  }
  function resultHTML(r,key) {
    return `<section class="verified-result"><h3>${clean(labels[key])}</h3><div class="audit-metrics">${[
      ['区间收益',pct(r.totalReturn)],['年化收益',pct(r.annualizedReturn)],['最大回撤',num(r.maxDrawdown)+'%'],
      ['Sharpe',num(r.sharpe)],['已完成交易',r.tradeCount+'笔'],['已完成胜率',r.tradeCount?num(r.winRate,1)+'%':'无已完成交易'],
      ['期末现金',num(r.finalCash)+'元'],['期末持仓',r.finalShares+'股']
    ].map(x=>`<div><span>${x[0]}</span><b>${clean(x[1])}</b></div>`).join('')}</div>${sparkline(r.equity)}
      <p class="audit-note">同标的买入持有（价格收益、未扣费用）：${pct(r.buyAndHold)}；开放仓位按期末收盘估值，未计作已完成交易。</p>
      <details><summary>成交记录与执行假设（${r.fills.length}次成交）</summary><div class="audit-table-scroll"><table class="audit-table"><thead><tr><th>信号日</th><th>成交日</th><th>方向</th><th>价格</th><th>股数</th><th>费用</th></tr></thead><tbody>${r.fills.slice(-120).map(t=>`<tr><td>${clean(t.signalDate||'初始配置')}</td><td>${clean(t.time||t.date)}</td><td>${t.side==='buy'?'买入':'卖出'}</td><td>${num(t.price)}</td><td>${clean(t.qty)}</td><td>${num(t.fee??t.fees)}</td></tr>`).join('')||'<tr><td colspan="6">该区间没有成交</td></tr>'}</tbody></table></div><ul>${r.warnings.map(w=>`<li>${clean(w)}</li>`).join('')}</ul></details></section>`;
  }
  function alphaHTML(result,benchmark,rf) {
    const map=new Map(benchmark.map(b=>[b.time,b.close]));let pairs=[];
    for(let i=1;i<result.equity.length;i++) {
      const a=result.equity[i-1],b=result.equity[i],p=map.get(a.time),q=map.get(b.time);
      if(p&&q) pairs.push([b.value/a.value-1,q/p-1]);
    }
    if(pairs.length<30)return '<p class="audit-note">基准共同样本不足30个收益日，暂不报告 Alpha/Beta。</p>';
    const n=pairs.length,dailyRf=Math.pow(1+rf,1/252)-1;
    const ys=pairs.map(x=>x[0]-dailyRf),xs=pairs.map(x=>x[1]-dailyRf),my=ys.reduce((a,b)=>a+b,0)/n,mx=xs.reduce((a,b)=>a+b,0)/n;
    const vx=xs.reduce((s,v)=>s+(v-mx)**2,0)/(n-1),vy=ys.reduce((s,v)=>s+(v-my)**2,0)/(n-1),cov=xs.reduce((s,v,i)=>s+(v-mx)*(ys[i]-my),0)/(n-1);
    if(!(vx>0&&vy>0))return '<p class="audit-note">样本方差不足，Alpha/Beta不适用。</p>';
    const beta=cov/vx,alpha=(my-beta*mx)*252,rho=cov/Math.sqrt(vx*vy),active=pairs.map(p=>p[0]-p[1]),am=active.reduce((a,b)=>a+b,0)/n;
    const te=Math.sqrt(active.reduce((s,v)=>s+(v-am)**2,0)/(n-1))*Math.sqrt(252),vol=Math.sqrt(vy*252);
    return `<section class="verified-result"><h3>相对基准表现</h3><div class="audit-metrics">${[['Alpha 点估计',pct(alpha*100)],['Beta',num(beta,3)],['策略年化波动',pct(vol*100)],['R²',num(rho*rho*100,1)+'%'],['跟踪误差',pct(te*100)],['信息比率',te?num(am*252/te,3):'—']].map(x=>`<div><span>${x[0]}</span><b>${x[1]}</b></div>`).join('')}</div><p class="audit-note">${n}个对齐日收益样本；日超额收益 OLS、Alpha按252倍年化。无风险收益假设${num(rf*100)}%/年。点估计未做显著性检验；Beta衡量市场敏感度，不能代替波动与回撤。</p></section>`;
  }
  async function backtest() {
    const btn=document.getElementById('btRun'),version=requestVersion,symbol=S.sinaSymbol,calculation=++calculationVersion;
    const valid=()=>version===requestVersion&&calculation===calculationVersion;
    const key=S.selectedStrategy||'mr',keys=key==='all'?['mr','turtle','ma','boll','td','grid','supertrend','tsmom','chandelier']:[key];
    const frozenParams=Object.fromEntries(keys.map(k=>[k,params(k)]));
    btn.disabled=true;btn.textContent='计算中…';
    const target=document.getElementById('btResults');target.innerHTML='<p class="audit-note">读取完整日线并对齐评价区间…</p>';
    try {
      const start=document.getElementById('btStart').value,end=document.getElementById('btEnd').value;
      if(!start||!end||start>end)throw new Error('请检查回测起止日期');
      const options={...config(),start,end};
      const pack=await getBars(symbol,warmStart(start),end,'qfq');
      if(!valid())return;
      const results={};
      for(const k of keys){results[k]=StockQuant.run(pack.bars,k,frozenParams[k],options);await new Promise(r=>setTimeout(r,0));}
      if(!valid())return;
      const r=results[keys[0]];lastResult={results,keys,options,meta:pack.meta,symbol};
      if(key==='grid')renderGridLines(r.levels,r.currentState.base,'回测期末基准');
      if(key==='td'){const history=S.planData||S.ohlcv,signals=StockQuant.calcTDSequential(history);renderTDMarkersOnChart(S.ohlcv,signals.filter((_,i)=>history[i].time>=S.ohlcv[0].time));}
      S._btData=pack.bars;S._btParams=params('mr');
      target.innerHTML=`<p class="audit-note"><b>复权收益模拟 · ${clean(r.equity[0].time)} → ${clean(r.equity.at(-1).time)}</b><br>${r.equity.length}根评价日线；预热数据不计交易。${clean(pack.meta.source)} · 数据指纹${clean(pack.meta.dataHash)}<br>日线收盘确认信号，下一交易日开盘尝试成交；费用及滑点已扣除。</p>`+keys.map(k=>resultHTML(results[k],k)).join('');
      const benchmarkSymbol=document.getElementById('btBenchmark').value;
      try {
        const bm=await getBars(benchmarkSymbol,start,end,'raw');
        if(valid())target.insertAdjacentHTML('beforeend',alphaHTML(r,bm.bars,options.riskFreeRate));
      }catch(e){if(valid())target.insertAdjacentHTML('beforeend',`<p class="audit-note">基准数据未完成：${clean(e.message)}</p>`);}
      if(!valid())return;
      if(r.equity.length>=90)target.insertAdjacentHTML('beforeend','<button type="button" id="runValidation" class="audit-button">运行独立滚动验证</button><div id="validationResult"></div>');
      document.getElementById('runValidation')?.addEventListener('click',()=>runValidation(pack.bars.filter(b=>b.time>=start&&b.time<=end),keys[0],frozenParams[keys[0]],options,version));
      renderPlan();
    }catch(e){if(valid())target.innerHTML=`<p class="audit-error">${clean(e.message)}</p>`;}
    finally{btn.disabled=false;btn.textContent='开始回测';}
  }
  async function runValidation(data,key,p,options,version) {
    const el=document.getElementById('validationResult'),btn=document.getElementById('runValidation');btn.disabled=true;btn.textContent='训练与验证中…';
    try{
      await new Promise(r=>setTimeout(r,20));
      const r=StockPortfolio.walkForward(data,key,p,{executionOptions:options});
      if(version!==requestVersion)return;
      el.innerHTML=`<h4>滚动样本外诊断</h4><p class="audit-note">${r.optimized?'网格参数仅在训练期寻优并冻结。':'当前策略使用界面固定参数，未自动寻优。'}验证窗口各自从现金开始；区间末尾尚有${r.trailingUntestedBars}根日线未组成完整验证窗。</p><div class="audit-table-scroll"><table class="audit-table"><thead><tr><th>训练期</th><th>验证期</th><th>候选数</th><th>训练收益</th><th>验证收益</th><th>验证交易数</th></tr></thead><tbody>${r.windows.map(w=>`<tr><td>${clean(w.trainStart)} → ${clean(w.trainEnd)}</td><td>${clean(w.testStart)} → ${clean(w.testEnd)}</td><td>${w.candidateCount}</td><td>${pct(w.trainReturn)}</td><td>${pct(w.testReturn)}</td><td>${w.testTrades}</td></tr>`).join('')}</tbody></table></div>${r.caveats.map(x=>`<p class="audit-note">${clean(x)}</p>`).join('')}`;
    }catch(e){el.innerHTML=`<p class="audit-error">${clean(e.message)}</p>`;}
    finally{btn.disabled=false;btn.textContent='运行独立滚动验证';}
  }
  function renderPlan() {
    let el=document.getElementById('orderPlanSection');
    if(!el){el=document.createElement('section');el.id='orderPlanSection';el.className='verified-result';document.getElementById('backtestCard').appendChild(el);}
    const holding=window.StockWorkspace?.getHolding(S.sinaSymbol)||{},key=S.selectedStrategy||'mr';
    const cost=Number(holding.avgCost),qty=Number(holding.quantity||0),sellable=Number(holding.sellableQty||0);
    const sameStock=el.dataset.planSymbol===S.sinaSymbol;
    const previous=id=>sameStock?(el.querySelector('#'+id)?.value||''):'';
    const previousCash=previous('planCash'),previousBase=previous('manualGridBase'),previousCapital=previous('planCapital'),previousBatches=previous('planBatchesBought'),previousStage=previous('planTpStage');
    el.dataset.planSymbol=S.sinaSymbol;
    const mrFields=key==='mr'?`<label>该策略原定总预算（元）<input id="planCapital" type="number" min="0.01" step="100" placeholder="每批额度=原定预算÷批数" value="${clean(previousCapital)}"></label>${qty>0?`<label>本轮已完成买入批数<input id="planBatchesBought" type="number" min="1" max="${clean(params('mr').batches)}" step="1" placeholder="按实际成交填写" value="${clean(previousBatches)}"></label><label>本轮已执行止盈阶段<select id="planTpStage"><option value="">请选择实际状态</option>${[['0','尚未止盈'],['1','已执行止盈1'],['2','已执行止盈1和2']].map(x=>`<option value="${x[0]}" ${previousStage===x[0]?'selected':''}>${x[1]}</option>`).join('')}</select></label>`:''}`:'';
    const chandelierFields=key==='chandelier'&&qty>0?`<label>本轮建仓日期<input id="planEntryDate" type="date" value="${clean(previous('planEntryDate'))}"></label><label>截至上一日线的本轮最高价<input id="planHighestHigh" type="number" min="0.01" step="0.01" placeholder="只统计本轮建仓后的价格" value="${clean(previous('planHighestHigh'))}"></label><label>上一日线的跟踪止损价<input id="planPreviousStop" type="number" min="0" step="0.01" placeholder="按上次已确认的跟踪线填写" value="${clean(previous('planPreviousStop'))}"></label>`:'';
    el.innerHTML=`<h3>条件单参考 · ${clean(labels[key]||'请选择单个策略')}</h3><p class="audit-note">${clean(S.name)} ${clean(S.code)} · 已完成日线截至${clean(S.ohlcv.at(-1)?.time||'—')}<br>真实持仓：${Number.isFinite(qty)?qty:'未录入'}股 / 当前可卖${Number.isFinite(sellable)?sellable:'未录入'}股 / 手动平均成本${cost>0?num(cost)+'元':'未录入'}。修改成本与持仓请使用“自选与持仓”。<br><b>与回测相同：收盘确认信号，下一交易日开盘尝试成交。不能直接改成盘中触价条件单。</b></p><div class="audit-form"><label>本次实际可用资金（元）<input id="planCash" type="number" min="0" step="100" placeholder="填入券商可用资金，可填0" value="${clean(previousCash)}"></label>${mrFields}${chandelierFields}${key==='grid'?`<label>当前实际网格基准（元）<input id="manualGridBase" type="number" min="0.01" step="0.01" placeholder="默认采用手动持仓成本" value="${clean(previousBase||(cost>0?cost:''))}"></label>`:''}</div>${key==='chandelier'&&qty>0?'<p class="audit-note">最高价与上一止损线需按本轮交易及时维护，至少更新至上一根已完成日线；本次只纳入最新一根，不会自动补算漏更新的多个交易日。</p>':''}${key==='mr'?'<p class="audit-note">批次和止盈阶段无法由平均成本推断；请按本轮实际成交填写，避免重复买入或重复止盈。首次空仓建仓时，原定总预算可以填写本次可用资金。</p>':''}<button type="button" class="audit-button" id="buildOrderDraft">检查最新日线信号并生成参考</button><div id="orderDraftOutput"></div>`;
    lastPlan=null;
    document.getElementById('buildOrderDraft').onclick=()=>buildPlan(key,holding);
  }
  function buildPlan(key,holding) {
    const out=document.getElementById('orderDraftOutput');lastPlan=null;
    try{
      if(key==='all')throw new Error('请先选择一个策略，再生成对应条件单');
      if(!S.ohlcv.length)throw new Error('请先加载股票行情');
      const position={cash:val('planCash',NaN),avgCost:Number(holding.avgCost||0),quantity:Number(holding.quantity||0),sellableQty:Number(holding.sellableQty||0)};
      if(key==='mr'){
        position.strategyCapital=val('planCapital',NaN);
        position.batchesBought=document.getElementById('planBatchesBought')?.value;
        position.tpStage=document.getElementById('planTpStage')?.value;
      }
      if(key==='grid')position.base=val('manualGridBase',position.avgCost);
      if(key==='chandelier'&&position.quantity>0){position.entryDate=document.getElementById('planEntryDate').value;position.highestHigh=val('planHighestHigh',NaN);position.previousStop=val('planPreviousStop',NaN);}
      const plan=StockQuant.plan(S.planData||S.ohlcv,key,params(key),position,config());
      const quotedDay=quoteNow?.quoteDate||quoteNow?.quoteTime?.slice(0,10),quotedTime=quoteNow?.quoteTime?.slice(11,16);
      const expired=quotedDay>plan.asOf&&quotedTime>='09:30';
      if(expired)plan.warnings.unshift('最新报价已进入信号日之后的交易时段，该信号的次日开盘已经过去。以下仅供复核，不是待执行委托；继续按规则等待新的收盘信号。');
      if(key==='grid'){
        const p=plan.params,base=plan.currentState.base;
        const levels=Array.from({length:p.gridDown+p.gridUp+1},(_,i)=>base*Math.pow(1+p.step/100,i-p.gridDown));
        renderGridLines(levels,base,'持仓/手动基准');
        plan.rules.push('当前观察买入格线：'+levels.filter(v=>v<base-.000001).reverse().map(v=>num(v)+'元').join('、')+'；卖出格线：'+levels.filter(v=>v>base+.000001).map(v=>num(v)+'元').join('、')+'。这些是收盘穿越观察线，未自动启用任何委托。');
      }
      const reasonLabels={'supertrend-up':'趋势向上翻转','supertrend-down':'趋势向下翻转','momentum-positive':'正动量入场','momentum-nonpositive':'动量退出','chandelier-breakout':'突破入场','chandelier-stop':'吊灯跟踪退出','mr-batch':'下一批建仓',stop:'成本止损',tp1:'止盈1',tp2:'止盈2',tp3:'止盈3','cross-up':'金叉','cross-down':'死叉',breakout:'高点突破','channel-exit':'低点退出','lower-band':'布林下轨','upper-band':'布林上轨',buy9:'TD做多9',buy13:'TD做多13',sell9:'TD做空9',sell13:'TD做空13','grid-buy':'网格向下穿越','grid-sell':'网格向上穿越'};
      const rows=plan.orders.map(order=>{
        const label=reasonLabels[order.reason]||order.reason;
        const condition=`${plan.asOf} 收盘已确认：${label}`;
        const action=expired?'对应开盘已过，不启用本条；等待新信号。':!order.enabled?'当前资金或可卖数量不足，本条不启用。':order.side==='buy'
          ?`下一交易日开盘尝试买入；该档金额不得超过${num(order.budget)}元（含费用）${order.quantityCap!=null?'，策略数量上限'+order.quantityCap+'股':''}，按当前参考价估算${order.qty}股。开盘重新按剩余预算及实际价向下取整。`
          :`下一交易日开盘尝试卖出${order.qty}股；已顺序扣减当前可卖余额，执行前再次核对。`;
        return {condition,action};
      });
      if(!rows.length)rows.push({condition:`${plan.asOf} 已完成日线`,action:'没有满足当前真实持仓状态的新信号，暂不生成买卖委托；等待下一根已完成日线。'});
      const lines=[`${S.name} (${S.code}) · ${labels[key]} 条件单参考`,`信号截至：${plan.asOf}；收盘确认后下一交易日开盘尝试成交。`,
        `实际平均成本：${position.avgCost>0?num(position.avgCost)+'元':'未录入'}；持仓${position.quantity}股；当前可卖${position.sellableQty}股；可用资金${num(position.cash)}元。`,
        ...rows.map((r,i)=>`${i+1}. ${r.condition} → ${r.action}`),'【持续跟踪的规则】',...plan.rules,...plan.warnings];
      lastPlan=lines.join('\n');
      out.innerHTML=`<div class="audit-table-scroll"><table class="audit-table"><thead><tr><th>已确认的最新信号</th><th>动作与限制</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${clean(r.condition)}</td><td>${clean(r.action)}</td></tr>`).join('')}</tbody></table></div><details open><summary>持续跟踪的规则</summary><ul>${plan.rules.map(rule=>`<li>${clean(rule)}</li>`).join('')}</ul></details>${plan.warnings.map(w=>`<p class="audit-note">${clean(w)}</p>`).join('')}<button type="button" class="audit-button" id="copyVerifiedPlan">复制 ${clean(labels[key])} 条件单参考</button>`;
      document.getElementById('copyVerifiedPlan').onclick=()=>copyPlan();
    }catch(e){out.innerHTML=`<p class="audit-error">${clean(e.message)}</p>`;}
  }
  async function copyPlan(){if(!lastPlan)return;try{await navigator.clipboard.writeText(lastPlan);toast('已复制当前策略条件单');}catch{toast('复制失败，请选中表格复制');}}
  async function load() {
    const version=++requestVersion,symbol=S.sinaSymbol;showLoading();quoteNow=null;lastPlan=null;lastResult=null;S.ohlcv=[];S.planData=[];
    document.getElementById('btResults').innerHTML='';document.getElementById('orderPlanSection')?.remove();
    try{
      const range=datesForRange(S.range||'1y');
      const [pack,q]=await Promise.all([getBars(symbol,warmStart(range.start),range.end,'qfq'),api('/api/market/quote?symbol='+encodeURIComponent(symbol)).catch(()=>null)]);
      if(version!==requestVersion)return;
      S.planData=pack.bars;S.ohlcv=pack.bars.filter(b=>b.time>=range.start);if(!S.ohlcv.length)throw new Error('所选区间没有可用日线');S._btData=null;S._btParams=null;quoteNow=q;if(q?.name)S.name=q.name;
      createMainChart();updateMainChart(S.ohlcv);S.charts.main.timeScale().fitContent();initDefaultMAs();updateStockInfo(S.ohlcv,q);
      clearGridLines();clearTDMarkers();removeBollingerOverlay();
      if(S.charts.indicator){S.charts.indicator.remove();S.charts.indicator=null;}
      S.activeInd=null;document.querySelectorAll('#indicatorTabs button').forEach(b=>b.classList.remove('active'));document.getElementById('indicatorChartWrap').classList.remove('open');
      document.getElementById('updateTime').textContent=q?'行情截至 '+q.quoteTime:'已完成日线截至 '+pack.meta.actualEnd;
      document.getElementById('chartPrice').textContent=num(q?.price||S.ohlcv.at(-1).close);
      const last=S.ohlcv.at(-1),previous=S.ohlcv.at(-2)||last,change=q?q.price-q.prevClose:last.close-previous.close,changePct=q?q.changePct:change/previous.close*100;
      document.getElementById('chartChange').textContent=(change>0?'+':'')+num(change)+'  '+pct(changePct);
      document.getElementById('chartPrice').style.color=colorForChange(change);document.getElementById('chartChange').style.color=colorForChange(change);
      loadDragonTiger();
      renderPlan();window.dispatchEvent(new CustomEvent('stock-selection-change',{detail:{symbol:S.sinaSymbol,name:S.name}}));
    }catch(e){if(version===requestVersion){S.ohlcv=[];S.planData=[];S.charts.main?.remove();S.charts.main=null;S.series={};document.getElementById('chartName').textContent=S.name;document.getElementById('chartPrice').textContent='—';document.getElementById('chartChange').textContent='行情加载失败';document.getElementById('siName').textContent=S.name;document.getElementById('siPrice').textContent='—';document.getElementById('siChange').textContent='行情加载失败';document.getElementById('siGrid').replaceChildren();toast(e.message);}}
    finally{if(version===requestVersion)hideLoading();}
  }
  window.StockApp={getCurrent:()=>({symbol:S.sinaSymbol,name:S.name,code:S.code,price:quoteNow?.price||S.ohlcv.at(-1)?.close}),getBars,
    selectStock:(symbol,name)=>{if(!/^(sh|sz)\d{6}$/.test(symbol))throw new Error('请选择沪深A股');S.sinaSymbol=symbol;S.code=symbol.slice(2);S.name=name||S.code;S.mktNum=symbol.startsWith('sh')?'1':'0';S.secid=S.mktNum+'.'+S.code;S.marketType='A';return load();},
    backtest,renderPlan,copyPlan,load,
    runPortfolio:async spec=>{
      const barsBySymbol={},adjust=spec.mode==='shares'?'raw':'qfq';
      for(let i=0;i<spec.assets.length;i+=3)await Promise.all(spec.assets.slice(i,i+3).map(async a=>{barsBySymbol[a.symbol]=await getBars(a.symbol,warmStart(spec.start),spec.end,adjust);}));
      const r=StockPortfolio.calculate({...spec,barsBySymbol,executionOptions:{...spec.feeOptions,lotSize:100}});
      r.dataSources=Object.fromEntries(Object.entries(barsBySymbol).map(([k,v])=>[k,v.meta]));return r;
    }};
  // The original chart/search interface remains in place; these adapters supply its data.
  window.loadStock=load;
  window.fetchKline=async(symbol,range)=>{const d=datesForRange(range||'1y');return (await getBars(symbol,d.start,d.end,'qfq')).bars;};
  window.fetchQuote=()=>api('/api/market/quote?symbol='+encodeURIComponent(S.sinaSymbol));
  window.searchStocks=async keyword=>{
    let items=[];try{items=(await api('/api/market/search?q='+encodeURIComponent(keyword))).items;}catch(e){if(!/^\d{6}$/.test(keyword))throw e;}
    const mapped=items.map(x=>({code:x.Code,name:x.Name,mktNum:String(x.MktNum),secid:String(x.MktNum)+'.'+x.Code,market:'A',marketLabel:String(x.MktNum)==='1'?'沪市':'深市'}));
    if(!mapped.length&&/^\d{6}$/.test(keyword)){const market=/^[569]/.test(keyword)?'1':'0';mapped.push({code:keyword,name:keyword,mktNum:market,secid:market+'.'+keyword,market:'A'});}
    return mapped;
  };
  window.runBacktest=backtest;window.generateOrderPlan=renderPlan;window.copyOrderPlan=copyPlan;
  window.autoFillGridParams=async()=>{toast('参数请在独立滚动验证的训练期选择；历史网格基准使用评价起点价格。');};
  function controls(){
    document.getElementById('btRun').insertAdjacentHTML('beforebegin',`<div class="audit-form" id="executionSettings"><label>开始日期<input type="date" id="btStart"></label><label>结束日期<input type="date" id="btEnd"></label><label>模拟本金（元）<input type="number" id="btCash" min="100" value="1000000"></label><label>佣金率（%）<input type="number" id="btCommission" min="0" step="0.001" value="0.03"></label><label>最低佣金（元/笔）<input type="number" id="btMinFee" min="0" step="1" value="5"></label><label>卖出印花税（%）<input type="number" id="btTax" min="0" step="0.001" value="0.05"></label><label>滑点（万分之一）<input type="number" id="btSlip" min="0" value="5"></label><label>无风险年收益假设（%）<input type="number" id="btRf" min="0" value="0" step="0.1"></label><label>比较基准<select id="btBenchmark"><option value="sh000300">沪深300</option><option value="sh000001">上证指数</option><option value="sh000905">中证500</option><option value="sh000852">中证1000</option></select></label></div><p class="audit-note">费用为可编辑假设，请按券商和历史时期调整。本版模拟沪深股票；不含分红现金、送转股事件或跨市场税费。</p>`);
    const setDates=()=>{const d=datesForRange(document.getElementById('btPeriod').value||'1y');document.getElementById('btStart').value=d.start;document.getElementById('btEnd').value=d.end;};setDates();
    document.getElementById('btPeriod').addEventListener('change',()=>{setDates();S.range=document.getElementById('btPeriod').value;document.querySelectorAll('#rangeButtons button').forEach(b=>b.classList.toggle('active',b.dataset.range===S.range));load();});
    document.getElementById('gridBase').closest('.bt-field').innerHTML='<label>历史网格基准</label><p class="audit-note">自动取评价起点开盘价。真实平均持仓成本在条件单中填写。</p>';
    const hint=document.getElementById('gridOptHint');if(hint)hint.textContent='滚动验证只在训练期选择参数，验证期固定执行。';
    document.querySelector('[onclick="autoFillGridParams()"]')?.remove();
    document.querySelector('.strat-card[data-strat="turtle"] .strat-desc').textContent='20日高点突破，ATR与资金约束定仓';
    // Replace the old anonymous range listeners to prevent stale asynchronous writes.
    const old=document.getElementById('rangeButtons'),replacement=old.cloneNode(true);old.replaceWith(replacement);
    replacement.addEventListener('click',e=>{const b=e.target.closest('button');if(!b)return;S.range=b.dataset.range;replacement.querySelectorAll('button').forEach(x=>x.classList.toggle('active',x===b));if(['1y','3y','6y'].includes(S.range)){document.getElementById('btPeriod').value=S.range;setDates();}load();});
    const invalidate=()=>{calculationVersion++;lastResult=null;document.getElementById('btResults').innerHTML='<p class="audit-note">参数已变化，请重新回测。</p>';};
    document.querySelectorAll('#executionSettings input,#executionSettings select,.strat-param-group input').forEach(el=>el.addEventListener('input',()=>{invalidate();lastPlan=null;document.getElementById('orderDraftOutput')?.replaceChildren();}));
    document.querySelectorAll('.strat-card').forEach(el=>el.addEventListener('click',()=>{invalidate();if(S.selectedStrategy!=='grid')clearGridLines();if(S.selectedStrategy!=='td')clearTDMarkers();setTimeout(renderPlan,0);}));
    window.addEventListener('stock-workspace-change',renderPlan);
  }
  controls();
  window.StockWorkspace?.mount();
  load();
})();
