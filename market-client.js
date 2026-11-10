(function(root,factory){
  'use strict';
  const api=factory(root);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.StockMarket=api;
})(typeof globalThis!=='undefined'?globalThis:this,function(root){
  'use strict';
  const DAY=86400000;
  function fail(message){throw new Error(message);}
  function symbol(value){if(typeof value!=='string'||!/^(sh|sz)\d{6}$/.test(value))fail('本版行情支持沪深代码，如 sh600000 或 sz000001');return value;}
  function date(value){
    if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value+'T00:00:00Z'))||new Date(value+'T00:00:00Z').toISOString().slice(0,10)!==value)fail('请输入有效起止日期');
    return value;
  }
  function shift(value,days){return new Date(Date.parse(value+'T00:00:00Z')+days*DAY).toISOString().slice(0,10);}
  function numeric(value,label,min,max){
    if(typeof value==='boolean'||value===null||value===undefined||(typeof value==='string'&&!value.trim())||(typeof value!=='number'&&typeof value!=='string'))fail(label+'不是有效数字');
    if(typeof value==='string'&&!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()))fail(label+'不是有效十进制数字');
    const n=Number(value);if(!Number.isFinite(n)||n<min||n>max)fail(label+'超出有效范围');return n;
  }
  function cleanBars(rows,start,end){
    if(!Array.isArray(rows))fail('行情格式错误，已停止计算');
    const map=new Map();
    for(const row of rows){
      if(!Array.isArray(row)||row.length<5)fail('行情包含无效日期或价格，已停止计算');
      const time=date(row[0]),open=numeric(row[1],'开盘价',1e-7,1e12),close=numeric(row[2],'收盘价',1e-7,1e12),high=numeric(row[3],'最高价',1e-7,1e12),low=numeric(row[4],'最低价',1e-7,1e12);
      if(low>Math.min(open,close)+1e-8||high<Math.max(open,close)-1e-8||high<low)fail('行情包含无效OHLC，已停止计算');
      const bar={time,open,close,high,low};
      if(row[5]!=null&&!(typeof row[5]==='string'&&!row[5].trim()))bar.volume=numeric(row[5],'成交量',0,1e18);
      if(time>=start&&time<=end){
        if(map.has(time)&&JSON.stringify(map.get(time))!==JSON.stringify(bar))fail('行情包含冲突的重复日期，已停止计算');
        map.set(time,bar);
      }
    }
    return Array.from(map.values()).sort((a,b)=>a.time.localeCompare(b.time));
  }
  async function hash(bars){
    const cryptoAPI=root.crypto||(typeof require==='function'?require('node:crypto').webcrypto:null);
    if(!cryptoAPI||!cryptoAPI.subtle)fail('当前浏览器缺少安全摘要功能，无法校验行情数据');
    const bytes=new TextEncoder().encode(JSON.stringify(bars));
    const digest=await cryptoAPI.subtle.digest('SHA-256',bytes);
    return Array.from(new Uint8Array(digest),b=>b.toString(16).padStart(2,'0')).join('').slice(0,16);
  }
  function createClient(settings){
    settings=settings||{};
    const transport=settings.transport||((url,options)=>root.fetch(url,options));
    const clock=settings.clock||(()=>new Date());
    const timeoutMs=settings.timeoutMs==null?10000:numeric(settings.timeoutMs,'请求超时',1,10000);
    function now(){const n=new Date(clock());if(!Number.isFinite(n.getTime()))fail('当前时间无效');return n;}
    function chinaParts(value){const local=new Date(value.getTime()+8*3600000);return {day:local.toISOString().slice(0,10),hour:local.getUTCHours(),minute:local.getUTCMinutes()};}
    async function request(url,type){
      const controller=new AbortController();let timer;
      try{
        return await Promise.race([
          Promise.resolve().then(()=>transport(url,{method:'GET',mode:'cors',credentials:'omit',referrerPolicy:'no-referrer',redirect:'error',signal:controller.signal}))
            .then(response=>{if(!response||!response.ok)fail('公开行情接口返回HTTP错误'+(response?' '+response.status:''));return type==='bytes'?response.arrayBuffer():response.json();}),
          new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('公开行情请求超时，请稍后重试'));},timeoutMs);})
        ]);
      }finally{clearTimeout(timer);}
    }
    async function getBars(stock,start,end,adjust){
      symbol(stock);date(start);date(end);adjust=adjust==null?'qfq':adjust;
      if(!['qfq','hfq','raw'].includes(adjust))fail('复权类型错误');
      const current=now(),cn=chinaParts(current);
      if(start>end||(Date.parse(end)-Date.parse(start))/DAY>Math.ceil(12*365.25)||start<'2000-01-01'||end>cn.day)fail('日期需为2000年至今天之内，单次跨度不超过12年');
      const effectiveEnd=end===cn.day&&(cn.hour<15||(cn.hour===15&&cn.minute<15))?shift(end,-1):end;
      if(effectiveEnd<start)fail('该区间还没有已完成的日线');
      const fq=adjust==='raw'?'':adjust,key=fq?fq+'day':'day';
      let raw=[],source='腾讯日线（浏览器直连）',pages=0;
      try{
        let cursor=effectiveEnd;
        for(let page=0;page<7;page++){
          const u=new URL('https://web.ifzq.gtimg.cn/appstock/app/fqkline/get');
          u.searchParams.set('param',stock+',day,,'+cursor+',640,'+fq);
          const result=await request(u.toString(),'json');pages++;
          const series=result&&result.data&&result.data[stock],chunk=series&&series[key];
          // Never consume .day or another array for an adjusted request.
          if(chunk==null)fail('行情源未提供所请求的'+adjust+'复权序列');
          if(!Array.isArray(chunk))fail('行情分段格式错误');
          if(!chunk.length)break;
          const earliest=chunk.map(row=>{if(!Array.isArray(row)||!row.length)fail('行情分段格式错误');return date(row[0]);}).sort()[0];
          raw.push(...chunk);
          if(earliest<=start||chunk.length<640)break;
          const next=shift(earliest,-1);if(next>=cursor)fail('行情分页未向前推进');
          if(page===6)fail('行情分页达到上限，无法确认完整区间');
          cursor=next;
        }
      }catch(error){raw=[];}
      if(!raw.length){
        source='东方财富日线（浏览器直连）';pages=1;
        const u=new URL('https://push2his.eastmoney.com/api/qt/stock/kline/get');
        const fields={secid:(stock.startsWith('sh')?'1.':'0.')+stock.slice(2),fields1:'f1,f2,f3',fields2:'f51,f52,f53,f54,f55,f56',klt:101,
          fqt:{raw:0,qfq:1,hfq:2}[adjust],beg:start.replace(/-/g,''),end:effectiveEnd.replace(/-/g,''),lmt:3000};
        Object.entries(fields).forEach(([k,v])=>u.searchParams.set(k,String(v)));
        try{
          const result=await request(u.toString(),'json');
          const series=result&&result.data;
          if(series&&series.code!=null&&String(series.code)!==stock.slice(2))fail('行情源股票代码不匹配');
          const rows=series&&series.klines;
          if(rows!=null&&!Array.isArray(rows))fail('备用行情格式错误');
          raw=(rows||[]).map(value=>{if(typeof value!=='string')fail('备用行情格式错误');return value.split(',');});
          if(raw.length>=3000&&raw.map(r=>date(r[0])).sort()[0]>start)fail('备用行情达到条数上限，请缩小区间');
        }catch(error){throw new Error('同复权公开行情暂时不可用（'+adjust+'），未降级为原始价格：'+error.message);}
      }
      const bars=cleanBars(raw,start,effectiveEnd);
      if(!bars.length)fail(stock+'在该区间没有行情');
      return {bars,meta:{symbol:stock,adjust,adjustment:adjust,source,requestedStart:start,requestedEnd:end,
        actualStart:bars[0].time,actualEnd:bars[bars.length-1].time,count:bars.length,completedOnly:true,effectiveEnd,
        fetchedAt:now().toISOString(),dataHash:await hash(bars),hashAlgorithm:'sha256-normalized-json-js-v1-16',
        corporateActionsIncluded:false,unknownVolumeCount:bars.filter(b=>b.volume===undefined).length,volumeUnit:'provider-original',pages,
        note:'复权序列用于收益模拟；原始价格模式不含分红及送转事件。日线成交量保留行情源原单位，未知不补零。浏览器JSON摘要与后端浮点序列化摘要不可直接比较。'}};
    }
    async function getQuote(stock){
      symbol(stock);
      const buffer=await request('https://qt.gtimg.cn/q='+stock,'bytes');
      const body=new TextDecoder('gb18030').decode(buffer);
      const match=body.match(new RegExp('(?:^|\\s)v_'+stock+'\\s*=\\s*"([^"\\r\\n]*)"\\s*;?'));
      if(!match)fail('实时行情格式或股票代码不匹配');
      const parts=match[1].split('~');
      const price=numeric(parts[3],'现价',Number.MIN_VALUE,Number.MAX_VALUE),prev=numeric(parts[4],'昨收价',0,Number.MAX_VALUE);
      const open=numeric(parts[5],'开盘价',0,Number.MAX_VALUE),high=numeric(parts[33],'最高价',0,Number.MAX_VALUE),low=numeric(parts[34],'最低价',0,Number.MAX_VALUE);
      const volume=numeric(parts[6],'成交量',0,Number.MAX_VALUE)*100,amount=numeric(parts[37],'成交额',0,Number.MAX_VALUE)*10000,stamp=parts[30];
      if(!Number.isFinite(volume)||!Number.isFinite(amount)||parts[2]!==stock.slice(2)||typeof stamp!=='string'||!/^\d{14}$/.test(stamp))fail('实时行情字段无效');
      const quoteDate=date(stamp.slice(0,4)+'-'+stamp.slice(4,6)+'-'+stamp.slice(6,8));
      if(Number(stamp.slice(8,10))>23||Number(stamp.slice(10,12))>59||Number(stamp.slice(12,14))>59)fail('实时报价时间无效');
      return {name:parts[1],code:parts[2],price,prevClose:prev,open,high,low,volume,amount,
        changeAmt:price-prev,changePct:prev?(price/prev-1)*100:0,
        quoteTime:quoteDate+' '+stamp.slice(8,10)+':'+stamp.slice(10,12)+':'+stamp.slice(12,14),quoteDate,source:'腾讯行情（浏览器直连）'};
    }
    async function search(keyword){
      if(typeof keyword!=='string'||!keyword.trim()||keyword.trim().length>30)fail('请输入1至30个字符的股票名称或代码');
      const u=new URL('https://searchapi.eastmoney.com/api/suggest/get');
      Object.entries({input:keyword.trim(),type:14,token:'D43BF722C8E33BDC906FB84D85E326E8',count:10}).forEach(([k,v])=>u.searchParams.set(k,String(v)));
      try{
        const result=await request(u.toString(),'json'),rows=result&&result.QuotationCodeTable&&result.QuotationCodeTable.Data;
        if(rows!=null&&!Array.isArray(rows))fail('股票搜索格式错误');
        return {items:(rows||[]).filter(x=>x&&['0','1',0,1].includes(x.MktNum)&&/^\d{6}$/.test(String(x.Code))&&typeof x.Name==='string')};
      }catch(error){throw new Error('名称搜索跨域接口暂不可用，请输入完整六位股票代码或使用隔离搜索适配器');}
    }
    return {getBars,getQuote,search};
  }
  return Object.assign(createClient(),{createClient,cleanBars,version:'1.0.0'});
});
