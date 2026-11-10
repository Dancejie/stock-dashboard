// Optional browser smoke: isolated temporary Chrome profile, localhost only, synthetic data.
// This exercises real IndexedDB, DOM events and reloads; it is not a live return claim.
'use strict';
const http=require('node:http'),fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..'),chrome=[process.env.CHROME_BIN,'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome','/usr/bin/chromium','/usr/bin/google-chrome'].find(p=>p&&fs.existsSync(p));
if(!chrome)throw Error('Set CHROME_BIN to a Chromium/Chrome executable');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'stock-holdout-test-'));
const page='<!doctype html><meta charset="utf-8"><div id="host"></div><script src="/quant-core.js"></script><script src="/holdout.js"></script><script src="/holdout-ui.js"></script><script>('+ (async function testPage(){
  const phase=Number(new URL(location.href).searchParams.get('phase')||1),events=[];
  const reqs=[],host=document.querySelector('#host'),field=k=>host.querySelector('[data-ho="'+k+'"]');
  const check=(truth,msg)=>{if(!truth)throw Error(msg);events.push(msg);};
  async function getBars(symbol,start,end,adjust){
    reqs.push({symbol,start,end,adjust});
    const bars=[];for(let ms=Date.parse(start);ms<=Date.parse(end);ms+=86400000){
      const d=new Date(ms);if([0,6].includes(d.getUTCDay()))continue;
      const open=10+(ms-Date.parse('2020-01-01'))/86400000*.01;
      bars.push({time:d.toISOString().slice(0,10),open,high:open+.05,low:open-.05,close:open+.02,volume:100000});
    }
    return {bars,meta:{symbol,adjust,completedOnly:true,source:'synthetic-browser-test'}};
  }
  async function wait(fn){const started=Date.now();while(!fn()){if(Date.now()-started>8000)throw Error('UI timeout: '+field('status').textContent);await new Promise(r=>setTimeout(r,20));}}
  try{
    const api=StockHoldoutUI.mount(host,{publicMode:true,getBars,
      session:async()=>({scope:'browser-synthetic-test',trusted:true,time:phase===1?'2020-03-27T09:30:00Z':'2020-04-07T09:30:00Z'}),
      getContext:()=>({symbol:'sh600000',name:'虚构测试',strategy:'hold',params:{},executionOptions:{initialCash:10000,lotSize:1,ruleMode:'fixed',symbol:'sh600000'}})});
    await api.reload();field('setup').open=true;
    if(phase===1){
      for(const [k,v] of Object.entries({mode:'prospective',trainStart:'2020-01-01',cutoff:'2020-03-27',testStart:'2020-03-30',testEnd:'2020-04-03',trials:'4',adjust:'raw'}))field(k).value=v;
      field('ack').checked=true;field('seal').click();await wait(()=>field('status').textContent.includes('已封存 #1'));
      check(reqs.length===1&&reqs[0].end==='2020-03-27','seal requested only training');check(!field('history').querySelector('button'),'early result cannot be opened');
    }else if(phase===2){
      check(field('history').textContent.includes('前瞻封存'),'IndexedDB survives page reload');check(reqs.length===0,'reload does not request prices');
      field('history').querySelector('button').click();await wait(()=>field('status').textContent.includes('已按原配置揭盲'));
      check(reqs.length===2,'mature reveal requests only calendar and frozen study');check(field('history').textContent.includes('5 个交易日'),'mature result displayed');
    }else{
      check(field('history').textContent.includes('已揭盲'),'published result survives a second reload');check(reqs.length===0,'cached result never re-fetches prices');check(!field('history').querySelector('button'),'no second reveal action');
    }
    await fetch('/report',{method:'POST',body:JSON.stringify({phase,events,ok:true})});if(phase<3)location.replace('/?phase='+(phase+1));
  }catch(e){await fetch('/report',{method:'POST',body:JSON.stringify({phase,events,ok:false,error:e.message})});}
}).toString()+')();</script>';
const reports=[];let browser,close;
const result=new Promise((ok,no)=>{close={ok,no};});
const server=http.createServer((req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(req.method==='POST'&&pathname==='/report'){
    let body='';req.on('data',s=>{body+=s;});req.on('end',()=>{try{
      const r=JSON.parse(body);reports.push(r);res.end('ok');if(!r.ok)close.no(Error(JSON.stringify(r)));else if(r.phase===3)close.ok();
    }catch(e){res.statusCode=400;res.end();close.no(e);}});return;
  }
  if(pathname==='/'){res.setHeader('content-type','text/html; charset=utf-8');return res.end(page);}
  if(['/quant-core.js','/holdout.js','/holdout-ui.js'].includes(pathname)){
    res.setHeader('content-type','text/javascript; charset=utf-8');return res.end(fs.readFileSync(path.join(root,pathname.slice(1))));
  }
  res.statusCode=404;res.end();
});
(async()=>{
  let timer;
  try{
    await new Promise(ok=>server.listen(0,'127.0.0.1',ok));
    const args=['--headless=new','--disable-background-networking','--disable-component-update','--disable-extensions','--disable-sync','--no-first-run','--no-default-browser-check','--user-data-dir='+profile];
    if(process.platform==='linux'&&process.getuid?.()===0)args.push('--no-sandbox');
    browser=spawn(chrome,[...args,'http://127.0.0.1:'+server.address().port+'/'],{stdio:'ignore'});
    browser.once('error',close.no);browser.once('exit',()=>{if(reports.length!==3)close.no(Error('Browser stopped early'));});
    timer=setTimeout(()=>close.no(Error('Browser test timed out')),35000);await result;
    console.log(JSON.stringify({ok:true,storage:'real IndexedDB; isolated Chrome profile',reports},null,2));
  }finally{
    clearTimeout(timer);
    if(browser&&browser.exitCode===null&&browser.signalCode===null)await new Promise(ok=>{browser.once('exit',ok);browser.kill();});
    server.closeAllConnections();server.close();
    fs.rmSync(profile,{recursive:true,force:true,maxRetries:4,retryDelay:250});
  }
})().catch(e=>{console.error(e.message);process.exitCode=1;});
