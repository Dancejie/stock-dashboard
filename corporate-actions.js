// Ordinary, unrestricted A-share holder; all cash is gross CNY per old share.
(function(root,factory){const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.StockCorporateActions=api;})(typeof globalThis!=='undefined'?globalThis:this,function(){
  'use strict';
  const cn='https://static.cninfo.com.cn/finalpage/';
  const sampleStart='2025-06-16',sampleEnd='2025-07-02';
  function event(symbol,id,title,announcementDate,recordDate,exDate,cashPerShare,sharesPerShare,url,sha256){
    return {symbol,id,title,announcementDate,recordDate,exDate,payDate:cashPerShare?exDate:null,
      shareListingDate:sharesPerShare?exDate:null,cashPerShare,sharesPerShare,shareKind:sharesPerShare?'capitalization':'none',source:cn+url,sha256};
  }
  const catalog=[
    {symbol:'sh603099',name:'长白山',coverageStart:sampleStart,coverageEnd:sampleEnd,events:[
      event('sh603099','603099-2025-034','长白山旅游股份有限公司2024年年度权益分派实施公告','2025-06-13','2025-06-19','2025-06-20',0.0815,0,'2025-06-13/1223859419.PDF','28bc070b18708912a8204bd135baf131118fd02ef386a592dc366f0b29f738b9')]},
    {symbol:'sh688556',name:'高测股份',coverageStart:sampleStart,coverageEnd:sampleEnd,events:[
      event('sh688556','688556-2025-035','青岛高测科技股份有限公司2024年年度权益分派实施公告','2025-06-20','2025-06-26','2025-06-27',0.18,0.4,'2025-06-20/1223935346.PDF','5fecb694731d3a06d91daf2ad547f100cb40ec9e7d338ea741148999d60fc064')]},
    {symbol:'sz002780',name:'三夫户外',coverageStart:'2026-05-25',coverageEnd:'2026-11-10',events:[
      event('sz002780','002780-2026-027','北京三夫户外用品股份有限公司2025年度权益分派实施公告','2026-05-27','2026-06-02','2026-06-03',0.05,0,'2026-05-27/1225331603.PDF','cf3a0c56eb175078d6a80e314451b4f8166e4c6dacb19ecb25b34e6bb7f9feb7'),
      event('sz002780','002780-2026-048','北京三夫户外用品股份有限公司2026年半年度权益分派实施公告','2026-09-15','2026-09-21','2026-09-22',0.02,0,'2026-09-15/1225564252.PDF','2b0d61b4ad2f812b1559d0a5764f67bc67bff3dac937729b7896d945625b67e7')]}
  ];
  for(const book of catalog)book.source=book.events[0].source;
  function fail(s){throw new Error(s);}
  function day(s){if(typeof s!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(s)||!Number.isFinite(Date.parse(s+'T00:00:00Z'))||new Date(s+'T00:00:00Z').toISOString().slice(0,10)!==s)fail('公司行为日期须为有效 YYYY-MM-DD');return s;}
  function symbol(s){if(typeof s!=='string'||!/^(sh|sz)\d{6}$/.test(s))fail('公司行为账本代码无效');return s;}
  function url(s){try{const u=new URL(s);if(u.protocol!=='https:'||u.username||u.password||u.href.length>2048)throw Error();return u.href;}catch(e){fail('请为账本及每项权益提供公开 HTTPS 来源');}}
  function amount(n,label){if(typeof n!=='number'||!Number.isFinite(n)||n<0||n>1e6)fail(label+'应为每股非负有限数值');return n;}
  function string(s,label){if(typeof s!=='string'||!s.trim()||s.length>250)fail(label+'无效');return s.trim();}
  function validateBook(input){
    if(!input||typeof input!=='object'||Array.isArray(input))fail('公司行为账本须为 JSON 对象');
    const stock=symbol(input.symbol),coverageStart=day(input.coverageStart),coverageEnd=day(input.coverageEnd),source=url(input.source);
    if(coverageStart>coverageEnd||!Array.isArray(input.events)||input.events.length>500)fail('公司行为账本区间或事件数组无效');
    const ids=new Set(),days=new Set();
    const events=input.events.map(e=>{
      if(!e||typeof e!=='object'||symbol(e.symbol)!==stock)fail('权益事件与账本代码不一致');
      const keys=['id','symbol','title','source','recordDate','exDate','payDate','shareListingDate','cashPerShare','sharesPerShare','shareKind','announcementDate','sha256','type'];
      if(Object.keys(e).some(k=>!keys.includes(k)))fail('事件包含未支持字段；不应把配股、合并、税负等其他权益静默忽略。');
      const id=string(e.id,'公告事件编号'),title=string(e.title,'公告标题'),recordDate=day(e.recordDate),exDate=day(e.exDate);
      if(ids.has(id)||days.has(recordDate))fail('重复登记日或事件编号；请先合并核对同日权益');
      ids.add(id);days.add(recordDate);
      const cashPerShare=amount(e.cashPerShare,'税前现金'),sharesPerShare=amount(e.sharesPerShare,'新增流通股');
      if(recordDate>=exDate||!(cashPerShare||sharesPerShare))fail('除权日须晚于登记日，并有正数现金或新增流通股');
      const payDate=cashPerShare?day(e.payDate):null,shareListingDate=sharesPerShare?day(e.shareListingDate):null;
      if((!cashPerShare&&e.payDate!=null)||(!sharesPerShare&&e.shareListingDate!=null)||(payDate&&payDate<exDate)||(shareListingDate&&shareListingDate<exDate))fail('现金到账或新增股份上市日期与权益不符');
      const finalDate=[exDate,payDate||exDate,shareListingDate||exDate].sort().pop();
      if(finalDate<coverageStart||recordDate>coverageEnd)fail('事件与声明覆盖区间不相交');
      const shareKind=e.shareKind||(sharesPerShare?'unspecified':'none');
      if(!['none','capitalization','stock-dividend','unspecified'].includes(shareKind)||(sharesPerShare===0)!==(shareKind==='none'))fail('新增股份类型无效；仅支持现金、送股及转增');
      if(e.type!=null&&!['distribution','cash','capitalization','stock-dividend'].includes(e.type))fail('不支持配股、合并或其他权益类型');
      const out={id,symbol:stock,title,recordDate,exDate,payDate,shareListingDate,cashPerShare,sharesPerShare,shareKind,source:url(e.source)};
      if(e.announcementDate){out.announcementDate=day(e.announcementDate);if(out.announcementDate>recordDate)fail('实施公告日期不可晚于登记日');}
      if(e.sha256!=null){if(!/^[0-9a-f]{64}$/i.test(e.sha256))fail('公告文件 SHA-256 无效');out.sha256=e.sha256;}
      return out;
    }).sort((a,b)=>a.recordDate.localeCompare(b.recordDate));
    return {symbol:stock,name:input.name?string(input.name,'名称'):stock,coverageStart,coverageEnd,source,events};
  }
  function getBook(stock,start,end,importedBook){
    symbol(stock);day(start);day(end);if(start>end)fail('权益查询日期倒置');
    const imported=importedBook!=null,src=imported?importedBook:catalog.find(b=>b.symbol===stock);
    if(!src)fail(stock+' 无内置公司行为覆盖，请导入已核对区间和完整事件。');
    const book=validateBook(src);if(book.symbol!==stock)fail('导入账本代码与所选股票不匹配');
    if(start<book.coverageStart||end>book.coverageEnd)fail(stock+' 公司行为仅覆盖 '+book.coverageStart+' 至 '+book.coverageEnd+'；请缩短区间或导入完整账本。');
    const events=book.events.filter(e=>e.recordDate<=end&&[e.exDate,e.payDate||'',e.shareListingDate||''].some(d=>d>=start));
    return Object.assign({},book,{start,end,events,verified:!imported,status:imported?'user-supplied':'filing-checked',
      notes:['人民币税前、每一股登记持仓口径；只处理普通无限售流通A股分红与送转，不含配股、重组、投资者差异及卖出补扣红利税。',imported?'覆盖范围和事件完整性由导入人确认，应用只校验格式与日期。':'人工核对实施公告的有限预置区间；没有全市场公司行为库。']});
  }
  function listCoverage(){return catalog.map(b=>({symbol:b.symbol,name:b.name,coverageStart:b.coverageStart,coverageEnd:b.coverageEnd,eventCount:b.events.length,source:b.source}));}
  return Object.freeze({getBook,validateBook,listCoverage,version:'2026-11-10'});
});
