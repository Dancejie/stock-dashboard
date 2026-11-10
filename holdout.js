/* Final, single-hypothesis holdout. Persistent receipts protect against accidental edits,
 * not deliberate changes by someone who controls the browser or the hosting server. */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory(require('node:crypto').webcrypto);
  else root.StockHoldout = factory(root.crypto);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (crypto) {
  'use strict';
  const DAY = 86400000, FORMAT = 'daily-final-holdout-v1';
  function fail(s) { throw new Error(s); }
  function day(s) {
    if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s) || !Number.isFinite(Date.parse(s)) ||
      new Date(s).toISOString().slice(0,10) !== s) fail('日期须为有效的 YYYY-MM-DD');
    return s;
  }
  function shift(s,n) { return new Date(Date.parse(day(s))+n*DAY).toISOString().slice(0,10); }
  function clock(iso) {
    const ms = Date.parse(iso); if (!Number.isFinite(ms)) fail('无法确认时间');
    const cn = new Date(ms+8*3600000).toISOString(), today = cn.slice(0,10);
    return {ms, iso:new Date(ms).toISOString(), today, completed:cn.slice(11,16) >= '15:15' ? today : shift(today,-1)};
  }
  function canonical(x) {
    if (x === null || typeof x === 'boolean' || typeof x === 'string') return JSON.stringify(x);
    if (typeof x === 'number' && Number.isFinite(x)) return JSON.stringify(x);
    if (Array.isArray(x)) return '['+x.map(canonical).join(',')+']';
    if (x && typeof x === 'object' && Object.getPrototypeOf(x) === Object.prototype)
      return '{'+Object.keys(x).sort().map(k=>JSON.stringify(k)+':'+canonical(x[k])).join(',')+'}';
    fail('封存内容含不支持的数据');
  }
  function copy(x) { return JSON.parse(canonical(x)); }
  async function digest(x) {
    if (!crypto || !crypto.subtle) fail('当前页面不支持 SHA-256，请在 HTTPS 页面打开');
    const bytes = await crypto.subtle.digest('SHA-256',new TextEncoder().encode(canonical(x)));
    return Array.from(new Uint8Array(bytes),v=>v.toString(16).padStart(2,'0')).join('');
  }
  // A single read/write transaction per owner prevents concurrent tabs from registering
  // a different strategy on an overlapping holdout, or publishing two different results.
  function indexedStore(idb, path) {
    if (!idb) fail('浏览器持久化不可用，不能封存实验');
    const db = new Promise((resolve,reject)=>{
      const req = idb.open('stock-holdout-v1:'+path,1);
      req.onupgradeneeded = () => req.result.createObjectStore('ledger');
      req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('请关闭其他旧版实验页面后重试'));
    });
    return {async transact(owner,mutate) {
      const d = await db;
      return new Promise((resolve,reject)=>{
        const tx = d.transaction('ledger',mutate?'readwrite':'readonly'), table = tx.objectStore('ledger');
        let output, cause;
        tx.oncomplete = () => resolve(output);
        tx.onabort = tx.onerror = () => reject(cause || tx.error || new Error('未能保存实验记录'));
        const req = table.get(owner);
        req.onsuccess = () => {
          try {
            const rows = req.result || [];
            if (!Array.isArray(rows)) fail('实验账本格式异常');
            output = mutate ? mutate(rows) : rows;
            if (mutate) table.put(rows,owner);
          } catch (e) { cause=e; tx.abort(); }
        };
      });
    }};
  }
  function barRows(pack,symbol,adjust,start,end) {
    const m=pack && pack.meta, bars=pack && pack.bars;
    if (!m || m.symbol!==symbol || (m.adjustment||m.adjust)!==adjust || m.completedOnly!==true ||
      !Array.isArray(bars)||!bars.length) fail('行情缺失、复权口径不符或没有已完成日线');
    const out=[]; let prev='';
    for (const b of bars) {
      if (!b||day(b.time)<start||b.time>end||b.time<=prev) fail('行情越过允许日期或日期无序，拒绝用于实验');
      const row={time:b.time};
      for(const k of ['open','high','low','close']) {
        if(!Number.isFinite(b[k])||b[k]<=0) fail('日线价格无效'); row[k]=b[k];
      }
      if(b.low>Math.min(b.open,b.close)+1e-8||b.high<Math.max(b.open,b.close)-1e-8||b.high<b.low) fail('日线价格范围无效');
      if(b.volume!=null) { if(!Number.isFinite(b.volume)||b.volume<0) fail('成交量无效'); row.volume=b.volume; }
      out.push(row); prev=b.time;
    }
    return out;
  }
  function numbers(x,allowed) {
    if (x==null) return {};
    if (typeof x!=='object'||Array.isArray(x)||Object.getPrototypeOf(x)!==Object.prototype) fail('参数须为数值对象');
    const out={};
    for(const [k,v] of Object.entries(x)) {
      if(!/^[A-Za-z][A-Za-z0-9]*$/.test(k)||['constructor','prototype'].includes(k)||
        (allowed&&!allowed.includes(k))||typeof v!=='number'||!Number.isFinite(v)) fail('参数无效：'+k);
      out[k]=v;
    }
    return out;
  }
  function info(r) {
    const out={};
    for (const k of ['start','end','totalReturn','maxDrawdown','tradeCount','finalVal','finalShares','totalFees']) {
      if(k==='start'||k==='end') out[k]=day(r[k]);
      else { if(!Number.isFinite(r[k])) fail('回测指标不完整：'+k); out[k]=r[k]; }
    }
    out.days=r.equity.length;
    return out;
  }
  function execution(value,defaults,symbol) {
    const {ruleMode=defaults.ruleMode||'fixed',symbol:specified,...numeric}=value||{};
    if(specified!=null&&specified!==symbol)fail('成交设置中的标的与封存标的不一致');
    if(ruleMode!=='fixed')fail('最终留出当前仅支持固定成交规则：未来法规不能提前冻结；请在主面板明确切换后重新读取，不会自动替换历史规则');
    return Object.assign(numbers(numeric,Object.keys(defaults).filter(k=>typeof defaults[k]==='number')),{symbol,ruleMode});
  }
  function minWarmup(strategy,p) {
    return {hold:1,grid:1,mr:p.smaPeriod,ma:p.longN+1,boll:p.period+1,turtle:Math.max(p.entryPeriod||0,p.exitPeriod||0,p.atrPeriod||0)+1,
      td:14,supertrend:p.atrPeriod+1,tsmom:Math.max(p.lookback||0,p.volPeriod||0)+1,chandelier:Math.max(p.entryPeriod||0,p.atrPeriod||0)+1}[strategy];
  }
  function overlaps(a,b){return a.testStart<=b.testEnd&&b.testStart<=a.testEnd;}
  function ensureWindow(x,now) {
    for(const k of ['trainStart','cutoff','testStart','testEnd']) day(x[k]);
    if (x.trainStart<'2000-01-01'||x.trainStart>=x.cutoff||x.cutoff>=x.testStart||x.testStart>x.testEnd||
      Date.parse(x.testEnd)-Date.parse(x.trainStart)>10*366*DAY) fail('须满足训练开始 < 截止日 < 留出开始 ≤ 留出结束，全程不超过十年');
    if(x.cutoff>now.completed) fail('训练截止日不能晚于已完成日线的可用日期');
    if(x.mode==='prospective') {
      if(!now.trusted) fail('缺少可信在线时间，仅可使用历史回放');
      if(x.testStart<=now.today) fail('前瞻封存必须早于留出开始日；已发生区间只能历史回放');
    } else if(x.mode==='replay') {
      if(x.testEnd>now.completed) fail('历史回放要求留出区间已结束');
    } else fail('请选择前瞻封存或历史回放');
  }
  async function verify(rows,owner) {
    const ids=new Set();
    for(const r of rows) {
      if(!r||!r.plan||r.plan.format!==FORMAT||r.plan.owner!==owner||r.id!==await digest(r.plan)||ids.has(r.id))
        fail('封存指纹不匹配或账本格式异常，停止读取');
      ids.add(r.id);
      if(r.result && r.resultHash!==await digest({id:r.id,result:r.result})) fail('已揭盲结果指纹不匹配');
    }
  }
  function create({quant,getBars,session,store,getEngineId}) {
    if(!quant||!getBars||!session||!store||!getEngineId) fail('留出实验未配置完整');
    async function who() {
      const s=await session(); if(!s||!s.scope) fail('无法确定本地实验空间');
      return Object.assign(clock(s.time),{scope:s.scope,owner:await digest(['holdout-owner',s.scope]),trusted:s.trusted===true});
    }
    async function read(w) {const rows=await store.transact(w.owner);await verify(rows,w.owner);return rows;}
    async function list() {const w=await who();return {today:w.today,completed:w.completed,trusted:w.trusted,rows:await read(w)};}
    async function seal(input) {
      const x=copy(input), w=await who();
      ensureWindow(x,w);
      if(!/^(sh|sz)\d{6}$/.test(x.symbol)||!quant.strategies.includes(x.strategy)||x.strategy==='all') fail('请选择一只股票和一个策略，不能封存策略比较');
      if(!['qfq','raw'].includes(x.adjust)) fail('请选择明确价格口径');
      const options=execution(x.executionOptions,quant.defaults,x.symbol);
      if(x.acknowledged!==true||!Number.isInteger(x.priorTrials)||x.priorTrials<0||x.priorTrials>1000000) fail('请披露此前试验次数并确认已看历史的限制');
      if((await read(w)).some(r=>overlaps(x,r.plan))) fail('本机此日期与已有实验重叠，不能更换标的或参数再试');
      // Only the training date range is requested here. No holdout series, candidates,
      // optimization, comparison or validation score participates in registration.
      const engine=await getEngineId();
      if(typeof engine!=='string'||engine.length<12) fail('无法取得回测引擎版本指纹');
      const pack=await getBars(x.symbol,x.trainStart,x.cutoff,x.adjust);
      const bars=barRows(pack,x.symbol,x.adjust,x.trainStart,x.cutoff);
      const r=quant.run(bars,x.strategy,numbers(x.params),options);
      if(bars.length<minWarmup(x.strategy,r.params)) fail('训练数据不足以预热冻结的指标，请延长训练区间');
      const w2=await who();if(w2.owner!==w.owner)fail('会话已变更，未封存');
      ensureWindow(x,w2); // also after a slow request crossing the start-date boundary
      const plan={format:FORMAT,owner:w.owner,mode:x.mode,sealedAt:w2.iso,clock:w2.trusted?'server':'device-replay-only',
        trainStart:x.trainStart,cutoff:x.cutoff,testStart:x.testStart,testEnd:x.testEnd,
        symbol:x.symbol,name:String(x.name||x.symbol).slice(0,80),strategy:x.strategy,params:copy(r.params),
        executionOptions:execution(r.config,quant.defaults,x.symbol),engine,engineVersion:quant.version,
        adjust:x.adjust,dataPolicy:'completed OHLCV; same units and prefix hash; reject incomplete sessions',
        startingPosition:'cash only; pre-start data warms indicators; prior close signal may fill at first evaluation open',
        baseline:'same symbol, buy and hold, same starting cash and costs',outcomes:['totalReturn','holdReturn','excessPctPoints','maxDrawdown','tradeCount'],
        priorTrials:x.priorTrials,acknowledged:true,train:{hash:await digest(bars),count:bars.length,first:bars[0].time,last:bars.at(-1).time,source:String(pack.meta.source||'未知')},
        trialNumber:0};
      // Number is part of the signed plan; a competing registration must retry, not
      // silently acquire a different trial number or overwrite the other tab.
      const old=await read(w);plan.trialNumber=old.length+1;
      const atCommit=await who();if(atCommit.owner!==w.owner)fail('会话已变更，未封存');
      ensureWindow(x,atCommit);plan.sealedAt=atCommit.iso;plan.clock=atCommit.trusted?'server':'device-replay-only';
      const monotonic=()=>globalThis.performance.now(), checkedAt=monotonic();
      const row={id:await digest(plan),plan};
      await store.transact(w.owner,rows=>{
        // Server Date has seconds precision. A tab sleeping or waiting on an IDB
        // transaction must not register across midnight with a stale server time.
        if(plan.mode==='prospective' && atCommit.ms+monotonic()-checkedAt+1000>=Date.parse(plan.testStart+'T00:00:00+08:00'))
          fail('留出开始时刻已接近或经过，未进行事后封存');
        if(rows.some(item=>overlaps(plan,item.plan)))fail('重叠留出区间已有封存，不可更换候选');
        if(rows.length!==old.length)fail('其他页面刚登记了实验，请刷新重试');
        if(rows.length>=200)fail('此浏览器实验账本已满');
        rows.push(row);
      });
      return copy(row);
    }
    async function reveal(id) {
      const w=await who(),rows=await read(w),rec=rows.find(r=>r.id===id);
      if(!rec)fail('未找到本机已封存的实验');
      if(rec.result)return copy(rec); // no re-fetch, re-fit, re-optimization or re-scoring
      const p=rec.plan;
      if(p.mode==='prospective'&&!w.trusted)fail('缺少可信在线时间，前瞻实验未揭盲');
      if(w.completed<p.testEnd)fail('留出期尚未结束：不请求数据、不显示中间收益');
      if(await getEngineId()!==p.engine||quant.version!==p.engineVersion)fail('回测引擎已改变，不能替换封存版本计算');
      // Use the index only as an observed market calendar. If the chosen end was a
      // holiday and the reference feed has not advanced beyond it, wait, never trim.
      const calEnd=[shift(p.testEnd,15),w.completed].sort()[0];
      const ref=barRows(await getBars('sh000300',p.testStart,calEnd,'raw'),'sh000300','raw',p.testStart,calEnd);
      if(ref.at(-1).time<p.testEnd)fail('交易日历尚未覆盖预设结束日，暂不揭盲');
      const sessions=ref.filter(b=>b.time<=p.testEnd).map(b=>b.time);
      if(!sessions.length)fail('留出期没有可验证的交易日');
      const pack=await getBars(p.symbol,p.trainStart,p.testEnd,p.adjust);
      const data=barRows(pack,p.symbol,p.adjust,p.trainStart,p.testEnd);
      const prefix=data.filter(b=>b.time<=p.cutoff);
      if(await digest(prefix)!==p.train.hash)fail('训练行情已修订或复权基准变化，停止揭盲，不使用混合口径');
      const period=data.filter(b=>b.time>=p.testStart);
      if(period.length!==sessions.length||period.some((b,i)=>b.time!==sessions[i]))
        fail('留出日线与市场交易日历不齐（含可能停牌），不补价、不展示部分结果');
      const opts=Object.assign({},p.executionOptions,{start:p.testStart,end:p.testEnd});
      const sr=quant.run(data,p.strategy,copy(p.params),opts),br=quant.run(data,'hold',{},opts);
      const strategy=info(sr),benchmark=info(br);
      const result={revealedAt:w.iso,first:sessions[0],last:sessions.at(-1),days:sessions.length,
        prefixHash:p.train.hash,seriesHash:await digest(data),holdoutHash:await digest(period),
        calendarHash:await digest(sessions),source:String(pack.meta.source||'未知'),strategy,benchmark,
        excessPctPoints:strategy.totalReturn-benchmark.totalReturn};
      const resultHash=await digest({id,result}), w2=await who();if(w2.owner!==w.owner)fail('会话已变更，未写入结果');
      const saved=await store.transact(w.owner,items=>{
        const row=items.find(item=>item.id===id);if(!row||canonical(row.plan)!==canonical(p))fail('封存记录已变更');
        if(!row.result){row.result=result;row.resultHash=resultHash;}
        return row;
      });
      await verify([saved],w.owner);
      return copy(saved);
    }
    return {list,seal,reveal};
  }
  return {create,indexedStore,day,shift,clock,digest,format:FORMAT};
});
