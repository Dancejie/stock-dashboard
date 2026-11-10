'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const H=require('../holdout.js'),UI=require('../holdout-ui.js'),Q=require('../quant-core.js');
const clone=x=>JSON.parse(JSON.stringify(x));
const clean={initialCash:10000,commissionRate:0,minCommission:0,stampTaxRate:0,slippageBps:0,lotSize:1,limitPct:10,riskFreeRate:0};
const spec=(extra={})=>Object.assign({symbol:'sh600000',name:'测试',strategy:'ma',params:{shortN:2,longN:5},executionOptions:{...clean},adjust:'raw',mode:'prospective',
  trainStart:'2020-01-01',cutoff:'2020-03-27',testStart:'2020-03-30',testEnd:'2020-04-03',priorTrials:3,acknowledged:true},extra);
function memory(){
  const data=new Map();return {data,async transact(o,fn){const r=clone(data.get(o)||[]);if(!fn)return r;const out=fn(r);data.set(o,clone(r));return out===undefined?undefined:clone(out);}};
}
function fixtures(){
  const bars=[];
  for(let ms=Date.parse('2020-01-01'),i=0;ms<=Date.parse('2020-06-30');ms+=86400000){
    const d=new Date(ms);if([0,6].includes(d.getUTCDay()))continue;
    const open=10+i*.015,close=open+.005;
    bars.push({time:d.toISOString().slice(0,10),open,high:close+.03,low:open-.03,close,volume:10000});i++;
  }
  return bars;
}
function harness(){
  const db=memory(),reqs=[],runs=[],bars=fixtures();
  const c={scope:'public:/x/',time:'2020-03-27T09:30:00.000Z',trusted:true,engine:'fixture-core-sha256-12345',mutate:null};
  async function getBars(symbol,start,end,adjust){
    reqs.push({symbol,start,end,adjust});
    let out=clone(bars.filter(b=>b.time>=start&&b.time<=end));
    if(c.mutate)out=c.mutate(out,{symbol,start,end,adjust});
    return {bars:out,meta:{symbol,adjust,source:'frozen-test-fixture',completedOnly:true}};
  }
  const opts={quant:{...Q,run(xs,k,p,o){runs.push({key:k,first:xs[0].time,last:xs.at(-1).time,start:o.start});return Q.run(xs,k,p,o);}},
    getBars,store:db,session:async()=>({...c}),getEngineId:async()=>c.engine};
  return {c,reqs,runs,db,opts,bars,service:H.create(opts)};
}
test('registration fetches only training; normalizes and persists exact defaults, fees, objective, clock and digest',async()=>{
  const h=harness(),s=spec({strategy:'turtle',params:{},executionOptions:{initialCash:10000,lotSize:100}});
  const sealed=await h.service.seal(s);
  assert.deepEqual(h.reqs,[{symbol:s.symbol,start:s.trainStart,end:s.cutoff,adjust:s.adjust}]);
  assert.deepEqual(h.runs.map(r=>r.key),['turtle']);
  assert.equal(sealed.id.length,64);assert.equal(sealed.plan.params.entryPeriod,20);assert.equal(sealed.plan.params.riskPct,2);
  assert.equal(sealed.plan.executionOptions.minCommission,5);assert.equal(sealed.plan.priorTrials,3);
  assert.equal(sealed.plan.train.last,s.cutoff);assert.equal(sealed.plan.mode,'prospective');
  s.params.riskPct=99;sealed.plan.params.entryPeriod=88;
  const reopened=(await H.create(h.opts).list()).rows[0];
  assert.equal(reopened.plan.params.entryPeriod,20);assert.equal(reopened.plan.params.riskPct,2);assert(!reopened.result);
});
test('an early reveal makes no market data or engine calls and cannot return a partial score',async()=>{
  const h=harness(),r=await h.service.seal(spec());h.c.time='2020-04-03T06:30:00Z';
  const before=h.reqs.length;
  await assert.rejects(()=>h.service.reveal(r.id),/尚未结束/);
  assert.equal(h.reqs.length,before);assert.equal(h.runs.length,1);assert(!(await h.service.list()).rows[0].result);
});
test('single result uses untouched evaluation cash, frozen costs, full warmup and same-cost fixed benchmark; repeat reads cache',async()=>{
  const h=harness(),r=await h.service.seal(spec({strategy:'hold',params:{}}));h.c.time='2020-04-07T09:00:00Z';
  const x=await h.service.reveal(r.id),v=x.result;
  const evalBars=h.bars.filter(b=>b.time>=r.plan.testStart&&b.time<=r.plan.testEnd);
  const qty=Math.floor(10000/evalBars[0].open),value=10000+qty*(evalBars.at(-1).close-evalBars[0].open);
  assert(Math.abs(v.strategy.finalVal-value)<1e-8);assert.equal(v.days,5);
  assert.equal(v.strategy.tradeCount,0);assert.equal(v.strategy.finalShares,qty);assert.equal(v.excessPctPoints,0);
  assert.deepEqual(h.runs.slice(1).map(a=>[a.first,a.last,a.start]),Array(2).fill(['2020-01-01','2020-04-03','2020-03-30']));
  const n=h.reqs.length;h.c.mutate=()=>{throw Error('must not fetch');};h.c.engine='a-changed-core-after-publish';
  assert.deepEqual(await H.create(h.opts).reveal(r.id),x);assert.equal(h.reqs.length,n);
});
test('overlap rejects a second candidate even if symbol, strategy, or date range is changed; concurrent tabs cannot both seal',async()=>{
  const h=harness(),one=spec(),two=spec({symbol:'sz000001',strategy:'td',params:{},testStart:'2020-04-02',testEnd:'2020-04-09'});
  const tries=await Promise.allSettled([h.service.seal(one),H.create(h.opts).seal(two)]);
  assert.equal(tries.filter(t=>t.status==='fulfilled').length,1);
  assert.match(tries.find(t=>t.status==='rejected').reason.message,/重叠/);
  assert.equal((await h.service.list()).rows.length,1);
});
test('future rows from a faulty provider are refused, not silently sliced out after training',async()=>{
  const h=harness();h.c.mutate=xs=>xs.concat({...xs.at(-1),time:'2020-03-30'});
  await assert.rejects(()=>h.service.seal(spec()),/越过/);assert.equal(h.runs.length,0);assert.deepEqual((await h.service.list()).rows,[]);
});
test('refuses engine drift or a revised training prefix without publishing a holdout score',async()=>{
  const h=harness(),r=await h.service.seal(spec({adjust:'qfq'}));
  h.c.time='2020-04-07T09:00:00Z';h.c.engine+='-v2';
  await assert.rejects(()=>h.service.reveal(r.id),/引擎已改变/);assert.equal(h.reqs.length,1);
  h.c.engine=r.plan.engine;
  h.c.mutate=(xs,req)=>{if(req.symbol===r.plan.symbol)xs[0].volume++;return xs;};
  await assert.rejects(()=>h.service.reveal(r.id),/训练行情已修订/);assert.equal(h.runs.length,1);
});
test('incomplete stock sessions cannot be dropped or future-filled; holidays require evidence the index advanced past the end',async()=>{
  const h=harness(),r=await h.service.seal(spec({testEnd:'2020-04-04'}));h.c.time='2020-04-05T09:00:00Z';
  await assert.rejects(()=>h.service.reveal(r.id),/日历尚未覆盖/);
  h.c.time='2020-04-07T09:00:00Z';h.c.mutate=(xs,req)=>req.symbol==='sh000300'?xs:xs.filter(b=>b.time!=='2020-04-01');
  await assert.rejects(()=>h.service.reveal(r.id),/不齐/);assert(!(await h.service.list()).rows[0].result);
  h.c.mutate=null;const v=(await h.service.reveal(r.id)).result;assert.equal(v.last,'2020-04-03');
});
test('no prospective backdating, no use of device time for forward studies, and historical results remain labelled replay',async()=>{
  const h=harness();h.c.time='2020-04-07T09:00:00Z';
  await assert.rejects(()=>h.service.seal(spec()),/历史回放/);
  h.c.trusted=false;
  await assert.rejects(()=>h.service.seal(spec({testStart:'2020-04-08',testEnd:'2020-04-21'})),/可信/);
  const r=await h.service.seal(spec({mode:'replay'}));assert.equal(r.plan.clock,'device-replay-only');
  assert.equal((await h.service.reveal(r.id)).plan.mode,'replay');
});
test('prospective registration rechecks the server day after fetching training data',async()=>{
  const h=harness();h.c.time='2020-03-29T15:59:59Z';
  h.c.mutate=xs=>{h.c.time='2020-03-29T16:00:01Z';return xs;};
  await assert.rejects(()=>h.service.seal(spec()),/必须早于/);assert.deepEqual((await h.service.list()).rows,[]);
});
test('missing disclosure, evaluation overrides, multi-strategy selections and insufficient warmup are rejected',async()=>{
  const h=harness();
  for(const x of [{acknowledged:false},{priorTrials:-1},{strategy:'all'},{testStart:'2020-03-27'},
    {executionOptions:{...clean,startIndex:1}},{strategy:'tsmom',params:{lookback:500}}]){
    await assert.rejects(()=>h.service.seal(spec(x)));
  }
  assert.deepEqual((await h.service.list()).rows,[]);
});
test('accidental edits invalidate receipt and result hashes; distinct Cowork identities do not share records',async()=>{
  const h=harness(),r=await h.service.seal(spec()),owner=r.plan.owner;
  h.c.scope='cowork:/x/:personB';assert.deepEqual((await h.service.list()).rows,[]);
  h.c.scope='public:/x/';h.c.time='2020-04-07T09:00:00Z';await h.service.reveal(r.id);
  const original=clone(h.db.data.get(owner));h.db.data.get(owner)[0].result.strategy.totalReturn=999;
  await assert.rejects(()=>h.service.list(),/结果指纹/);
  h.db.data.set(owner,original);h.db.data.get(owner)[0].plan.params.longN=1000;
  await assert.rejects(()=>h.service.list(),/封存指纹/);
});
function env(answers,now='2020-03-27T09:30:00Z'){
  const reqs=[],ctx={reqs,location:new URL('https://example.test/site/index.html'),now:()=>Date.parse(now),fetch:async(url,opts)=>{
    reqs.push({url,opts});const a=answers.shift();if(a.error)throw Error('network');
    return {ok:a.ok!==false,headers:{get:key=>a[key]??null},json:async()=>a.user};
  }};return ctx;
}
test('public mode uses only same-origin anonymous HEAD, never calls session or posts settings',async()=>{
  const e=env([{Date:'Fri, 27 Mar 2020 09:30:00 GMT'},{Date:'Fri, 27 Mar 2020 09:30:00 GMT',Age:'200'},{error:true}]),reader=UI.sessionReader(e,true);
  const first=await reader();assert.equal(first.trusted,true);assert.equal(first.scope,'public:/site/');
  assert.equal((await reader()).trusted,false);assert.equal((await reader()).trusted,false);
  for(const r of e.reqs){assert.equal(new URL(r.url).pathname,'/site/index.html');assert.equal(r.opts.method,'HEAD');assert.equal(r.opts.credentials,'omit');assert.equal(r.opts.cache,'no-store');}
});
test('Cowork mode uses real identity; no Date or stale clock permits replay only; anonymous requests fail closed',async()=>{
  const e=env([{Date:'Fri, 27 Mar 2020 09:30:00 GMT',user:{userId:'A'}},{user:{userId:'A'}},{Date:'Fri, 27 Mar 2019 09:30:00 GMT',user:{userId:'B'}},{ok:false}]),reader=UI.sessionReader(e,false);
  assert.deepEqual(await reader(),{scope:'cowork:/site/:A',time:'Fri, 27 Mar 2020 09:30:00 GMT',trusted:true});
  assert.equal((await reader()).trusted,false);assert.equal((await reader()).scope,'cowork:/site/:B');
  await assert.rejects(reader,/登录身份/);
  assert(e.reqs.every(r=>new URL(r.url).pathname==='/site/api/session/me'&&r.opts.credentials==='same-origin'));
});
test('freezes symbol and fixed rule mode explicitly, never silently replaces a selected historical model',async()=>{
  const h=harness();
  await assert.rejects(()=>h.service.seal(spec({executionOptions:{...clean,symbol:'sh600000',ruleMode:'historical'}})),/仅支持固定/);
  await assert.rejects(()=>h.service.seal(spec({executionOptions:{...clean,symbol:'sz000001',ruleMode:'fixed'}})),/标的不一致/);
  assert.equal(h.reqs.length,0);
  const r=await h.service.seal(spec({executionOptions:{...clean,symbol:'sh600000',ruleMode:'fixed'}}));
  assert.equal(r.plan.executionOptions.ruleMode,'fixed');assert.equal(r.plan.executionOptions.symbol,'sh600000');
});
