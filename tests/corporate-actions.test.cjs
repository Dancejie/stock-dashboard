'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),C=require('../corporate-actions.js');
const builtin=()=>C.getBook('sh688556','2025-06-16','2025-07-02');
function custom(){
  return {symbol:'sh600000',name:'导入示例',coverageStart:'2025-06-10',coverageEnd:'2025-07-10',source:'https://example.org/archive',
    events:[{id:'event-1',symbol:'sh600000',title:'测试权益分派实施公告',source:'https://example.org/one.pdf',recordDate:'2025-06-19',exDate:'2025-06-20',payDate:'2025-06-23',shareListingDate:'2025-06-24',cashPerShare:0.1,sharesPerShare:0.2}]};
}
test('filing-checked windows contain actual gross per-share terms including capitalization',()=>{
  const a=builtin(),e=a.events[0];assert.equal(a.verified,true);assert.equal(a.status,'filing-checked');
  assert.deepEqual([e.recordDate,e.exDate,e.payDate,e.shareListingDate,e.cashPerShare,e.sharesPerShare],['2025-06-26','2025-06-27','2025-06-27','2025-06-27',0.18,0.4]);
  assert.equal(e.shareKind,'capitalization');assert.match(e.source,/static.cninfo.com.cn.*1223935346/);assert.match(e.sha256,/^[0-9a-f]{64}$/);
  const cash=C.getBook('sh603099','2025-06-16','2025-07-02').events[0];assert.equal(cash.cashPerShare,0.0815);assert.equal(cash.shareListingDate,null);
  const sanfo=C.getBook('sz002780','2026-05-25','2026-11-10').events;
  assert.deepEqual(sanfo.map(e=>[e.recordDate,e.exDate,e.payDate,e.cashPerShare]),[['2026-06-02','2026-06-03','2026-06-03',0.05],['2026-09-21','2026-09-22','2026-09-22',0.02]]);
  assert.equal(C.listCoverage().length,3);
});
test('queries fail closed outside coverage; covered no-event and missing book are distinct',()=>{
  assert.throws(()=>C.getBook('sh688556','2025-06-15','2025-07-02'),/仅覆盖/);
  assert.throws(()=>C.getBook('sh688556','2025-06-16','2025-07-03'),/仅覆盖/);
  assert.throws(()=>C.getBook('sz000001','2025-06-16','2025-07-02'),/无内置/);
  assert.deepEqual(C.getBook('sh603099','2025-06-23','2025-06-25').events,[]);
});
test('delayed payment/listing and prior entitlements survive date slicing, imported data cannot self-verify',()=>{
  const b=custom();b.verified=true;b.status='filing-checked';
  const late=C.getBook(b.symbol,'2025-06-23','2025-06-24',b);assert.equal(late.events.length,1);assert.equal(late.events[0].recordDate,'2025-06-19');
  assert.equal(late.verified,false);assert.equal(late.status,'user-supplied');
  assert.deepEqual(C.getBook(b.symbol,'2025-06-25','2025-07-10',b).events,[]);
  assert.throws(()=>C.getBook('sz000001','2025-06-10','2025-06-11',b),/不匹配/);
});
test('import requires unambiguous actionable dates, positive numeric entitlements and source links',()=>{
  for(const patch of [{recordDate:'2025-02-30'},{exDate:'2025-06-19'},{payDate:'2025-06-19'},{shareListingDate:null},{cashPerShare:'0.1'},{sharesPerShare:-1},{cashPerShare:0,sharesPerShare:0},{source:'javascript:1'},{source:'https://name:pw@example.org'},{type:'rights-issue'},{rightsPerShare:0.2},{symbol:'sh600001'}]){
    const b=custom();Object.assign(b.events[0],patch);assert.throws(()=>C.validateBook(b));
  }
  const b=custom();b.events.push({...b.events[0],id:'other-id'});assert.throws(()=>C.validateBook(b),/重复/);
});
test('returned events and coverage can be edited without mutating source records',()=>{
  const a=builtin();a.events[0].cashPerShare=999;assert.equal(builtin().events[0].cashPerShare,0.18);
  C.listCoverage()[0].coverageEnd='2999-01-01';assert.equal(C.listCoverage()[0].coverageEnd,'2025-07-02');
});
test('offline import example and browser built-ins reproduce every audited filing and hash',()=>{
  const books=require('../fixtures/corporate-action-books.json'),audit=require('../fixtures/corporate-action-verification.json');
  for(const book of books){
    const a=C.getBook(book.symbol,book.coverageStart,book.coverageEnd),b=C.getBook(book.symbol,book.coverageStart,book.coverageEnd,book);
    assert.deepEqual(a.events,b.events);assert.equal(b.verified,false);
    assert.deepEqual(a.events.map(e=>e.sha256),audit.books.find(x=>x.symbol===book.symbol).verifiedFiles.map(f=>f.sha256));
  }
});
