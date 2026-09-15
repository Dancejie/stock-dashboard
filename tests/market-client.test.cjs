'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const Market=require('../market-client.js');
const day=i=>new Date(Date.UTC(2023,0,1+i)).toISOString().slice(0,10);
const row=(time,volume=123.5)=>[time,'10','11','12','9',volume];
const json=value=>({ok:true,status:200,json:async()=>value});
const tencent=(rows,key='qfqday',stock='sz000426')=>json({data:{[stock]:{[key]:rows}}});
const fixedClock=()=>new Date('2026-09-15T08:00:00Z');
const client=transport=>Market.createClient({transport,clock:fixedClock});
const range=['2026-09-01','2026-09-15'];

test('browser global and CommonJS expose matching public entry points',()=>{
  const browser={};vm.createContext(browser);
  vm.runInContext(fs.readFileSync(require.resolve('../market-client.js'),'utf8'),browser);
  for(const name of ['getBars','getQuote','search','createClient','cleanBars']){
    assert.equal(typeof browser.StockMarket[name],'function');assert.equal(typeof Market[name],'function');
  }
});

test('640-row backward paging clips, sorts, and uses private-credential-free requests',async()=>{
  const calls=[];
  const api=client(async(url,options)=>{
    calls.push({url:new URL(url),options});
    return tencent(calls.length===1?Array.from({length:640},(_,i)=>row(day(i+100))):Array.from({length:100},(_,i)=>row(day(i))));
  });
  const result=await api.getBars('sz000426',day(50),day(730),'qfq');
  assert.equal(calls.length,2);assert.equal(result.bars.length,681);
  assert.equal(calls[0].url.searchParams.get('param'),'sz000426,day,,'+day(730)+',640,qfq');
  assert.equal(calls[1].url.searchParams.get('param'),'sz000426,day,,'+day(99)+',640,qfq');
  assert.equal(result.bars[0].time,day(50));assert.equal(result.bars.at(-1).time,day(730));
  assert.equal(result.meta.pages,2);assert.equal(result.meta.count,681);
  for(const call of calls){
    assert.equal(call.options.credentials,'omit');assert.equal(call.options.referrerPolicy,'no-referrer');
    assert.equal(call.options.mode,'cors');assert.equal(call.options.method,'GET');
    assert.equal(call.options.redirect,'error');assert(call.options.signal instanceof AbortSignal);
  }
});

test('an absent adjusted Tencent array never uses available raw prices',async()=>{
  const calls=[];
  const api=client(async url=>{
    calls.push(new URL(url));
    if(calls.length===1)return tencent([row('2026-09-01')],'day');
    return json({data:{code:'000426',klines:['2026-09-01,20,21,22,19,7']}});
  });
  const result=await api.getBars('sz000426',...range,'qfq');
  assert.equal(calls.length,2);assert.equal(calls[1].searchParams.get('fqt'),'1');
  assert.equal(result.bars[0].open,20);assert.match(result.meta.source,/东方财富.*浏览器/);
  assert.equal(result.meta.adjust,'qfq');assert.equal(result.meta.adjustment,'qfq');
});

test('hfq fallback retains fqt 2 and raw requests use Tencent day explicitly',async()=>{
  let fallback;
  const adjusted=client(async url=>{
    if(url.includes('gtimg'))throw new Error('network');
    fallback=new URL(url);return json({data:{code:'603099',klines:['2026-09-01,10,11,12,9,1']}});
  });
  await adjusted.getBars('sh603099',...range,'hfq');assert.equal(fallback.searchParams.get('fqt'),'2');
  assert.equal(fallback.searchParams.get('secid'),'1.603099');
  const raw=client(async url=>{assert.equal(new URL(url).searchParams.get('param'),'sz000426,day,,2026-09-15,640,');return tencent([row('2026-09-01')],'day');});
  assert.equal((await raw.getBars('sz000426',...range,'raw')).meta.adjust,'raw');
});

test('same-adjustment fallback failure and symbol mismatch fail closed',async()=>{
  const failed=client(async()=>{throw new Error('network unavailable');});
  await assert.rejects(failed.getBars('sz000426',...range,'qfq'),/qfq.*未降级/);
  const mismatch=client(async url=>url.includes('gtimg')?tencent([]):json({data:{code:'600000',klines:['2026-09-01,10,11,12,9,1']}}));
  await assert.rejects(mismatch.getBars('sz000426',...range,'qfq'),/股票代码不匹配/);
});

test('strict OHLC, decimal values, dates, and conflicting duplicates reject corrupt data',()=>{
  const clean=rows=>Market.cleanBars(rows,...range);
  for(const invalid of [
    ['2026-09-01',10,11,10,9,1],['2026-09-01',10,11,12,11,1],
    ['2026-09-01',true,11,12,9,1],['2026-09-01','0x10',11,20,9,1],
    ['2026-09-01','Infinity',11,12,9,1],['2026-09-01',0,11,12,0,1],
    ['2026-02-30',10,11,12,9,1],['2026-09-1',10,11,12,9,1],
    ['2026-09-01',10,11,12,9,-1],['2026-09-01',10,11,12,9,true]
  ])assert.throws(()=>clean([invalid]));
  assert.throws(()=>clean([row('2026-09-01'),row('2026-09-01',5)]),/冲突/);
  const normalized=clean([row('2026-09-03'),row('2026-09-01'),row('2026-09-01')]);
  assert.deepEqual(normalized.map(b=>b.time),['2026-09-01','2026-09-03']);
  // Invalid records outside the interval must not be silently accepted either.
  assert.throws(()=>clean([['2020-01-01',true,11,12,9,1]]));
});

test('unknown volume stays unknown, zero stays zero, and provider units stay intact',async()=>{
  const rows=[row('2026-09-01',null),row('2026-09-02',''),row('2026-09-03','  '),row('2026-09-04',0),row('2026-09-05',123.5)];
  rows.push(row('2026-09-06').slice(0,5));
  const result=await client(async()=>tencent(rows)).getBars('sz000426',...range);
  assert.equal(result.meta.unknownVolumeCount,4);assert.equal(result.meta.volumeUnit,'provider-original');
  for(const index of [0,1,2,5])assert.equal(Object.hasOwn(result.bars[index],'volume'),false);
  assert.equal(result.bars[3].volume,0);assert.equal(result.bars[4].volume,123.5);
});

test('China 15:15 cutoff excludes the unfinished day and uses China calendar date',async()=>{
  for(const [clockValue,expectedEnd] of [['2026-09-14T17:00:00Z','2026-09-14'],['2026-09-15T07:14:59Z','2026-09-14'],['2026-09-15T07:15:00Z','2026-09-15']]){
    const api=Market.createClient({clock:()=>new Date(clockValue),transport:async url=>{
      assert.equal(new URL(url).searchParams.get('param'),'sz000426,day,,'+expectedEnd+',640,qfq');
      return tencent([row('2026-09-14'),row('2026-09-15')]);
    }});
    const result=await api.getBars('sz000426',...range);
    assert.equal(result.meta.effectiveEnd,expectedEnd);assert.equal(result.meta.actualEnd,expectedEnd);assert.equal(result.meta.completedOnly,true);
  }
  let requests=0;
  const preclose=Market.createClient({clock:()=>new Date('2026-09-15T06:00Z'),transport:async()=>{requests++;}});
  await assert.rejects(preclose.getBars('sz000426','2026-09-15','2026-09-15'),/没有已完成/);assert.equal(requests,0);
});

test('request validation rejects impossible dates, future dates, invalid adjustment and symbols before fetching',async()=>{
  let calls=0;const api=client(async()=>{calls++;});
  for(const args of [
    ['sz000426','2026-02-30','2026-09-15','qfq'],['sz000426','2026-09-02','2026-09-01','qfq'],
    ['sz000426','2026-09-01','2026-09-16','qfq'],['sz000426','1999-12-31','2026-09-15','qfq'],
    ['sz000426','2010-01-01','2026-09-15','qfq'],['sz000426',...range,'anything'],['../file',...range,'qfq']
  ])await assert.rejects(api.getBars(...args));
  assert.equal(calls,0);
});

test('metadata records actual sparse coverage, fetch time, browser source and deterministic hash',async()=>{
  const api=client(async()=>tencent([row('2026-09-14'),row('2026-09-10')]));
  const a=await api.getBars('sz000426',...range),b=await api.getBars('sz000426',...range);
  assert.equal(a.meta.actualStart,'2026-09-10');assert.equal(a.meta.actualEnd,'2026-09-14');
  assert.equal(a.meta.requestedStart,range[0]);assert.equal(a.meta.requestedEnd,range[1]);
  assert.equal(a.meta.fetchedAt,'2026-09-15T08:00:00.000Z');assert.match(a.meta.source,/腾讯.*浏览器直连/);
  assert.match(a.meta.dataHash,/^[0-9a-f]{16}$/);assert.equal(a.meta.dataHash,b.meta.dataHash);
  assert.equal(a.meta.hashAlgorithm,'sha256-normalized-json-js-v1-16');assert.equal(a.meta.corporateActionsIncluded,false);
});

function quoteResponse(overrides={}){
  const parts=Array(38).fill('0');Object.assign(parts,{1:'NAME',2:'000426',3:'11.5',4:'10',5:'10.2',6:'12.5',30:'20260915145958',33:'12',34:'9',37:'3.2'},overrides);
  const body='v_sz000426="'+parts.join('~')+'";';
  const [before,after]=body.split('NAME');
  // GB18030-compatible bytes for 中文; source bytes, not UTF-8 pretending to be GB18030.
  const bytes=Buffer.concat([Buffer.from(before),Buffer.from([0xd6,0xd0,0xce,0xc4]),Buffer.from(after)]);
  return {ok:true,status:200,arrayBuffer:async()=>bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)};
}

test('GB18030 quote parsing preserves Chinese name, real timestamp, shares and yuan units',async()=>{
  const api=client(async(url,options)=>{assert.equal(url,'https://qt.gtimg.cn/q=sz000426');assert.equal(options.credentials,'omit');return quoteResponse();});
  const q=await api.getQuote('sz000426');
  assert.equal(q.name,'中文');assert.equal(q.code,'000426');assert.equal(q.price,11.5);assert.equal(q.prevClose,10);
  assert.equal(q.open,10.2);assert.equal(q.high,12);assert.equal(q.low,9);
  assert.equal(q.volume,1250);assert.equal(q.amount,32000);assert.equal(q.changeAmt,1.5);assert(Math.abs(q.changePct-15)<1e-10);
  assert.equal(q.quoteTime,'2026-09-15 14:59:58');assert.equal(q.quoteDate,'2026-09-15');assert.match(q.source,/浏览器/);
});

test('quote rejects mismatched identifiers, invalid fields, impossible dates and times',async()=>{
  for(const override of [{2:'600000'},{3:'0'},{3:'NaN'},{3:'0x12'},{6:'-1'},{30:'20260230145958'},{30:'20260915245958'},{30:'20260915146058'}]){
    await assert.rejects(client(async()=>quoteResponse(override)).getQuote('sz000426'));
  }
});

test('timeouts abort stalled public requests even if the injected fetch ignores cancellation',async()=>{
  let signal;
  const api=Market.createClient({clock:fixedClock,timeoutMs:10,transport:async(url,options)=>{signal=options.signal;return new Promise(()=>{});}});
  await assert.rejects(api.getQuote('sz000426'),/超时/);assert.equal(signal.aborted,true);
});

test('HTTP and malformed quote responses are rejected without executing returned JavaScript',async()=>{
  await assert.rejects(client(async()=>({ok:false,status:503})).getQuote('sz000426'),/HTTP错误 503/);
  const payload=Buffer.from('globalThis.__remoteCodeExecuted=true;');
  await assert.rejects(client(async()=>({ok:true,arrayBuffer:async()=>payload})).getQuote('sz000426'),/格式或股票代码/);
  assert.equal(globalThis.__remoteCodeExecuted,undefined);
});

test('search returns only validated mainland stock records and clearly reports CORS failure',async()=>{
  const api=client(async()=>json({QuotationCodeTable:{Data:[{Code:'000426',Name:'中文',MktNum:'0'},{Code:'600000',Name:'中文',MktNum:1},{Code:'00700',Name:'港股',MktNum:'116'},{Code:'123456',MktNum:1},{Code:'<script>',Name:'bad',MktNum:1}]}}));
  assert.equal((await api.search('中文')).items.length,2);
  await assert.rejects(client(async()=>{throw new TypeError('Failed to fetch');}).search('中文'),/跨域接口暂不可用/);
});
