const {test}=require('node:test');
const assert=require('node:assert/strict');
const info=require('../extension/replay-info');
test('filename uses YYMMDD, artist and live title',()=>{
  assert.equal(info.filename({date:'2026. 11. 02.',artist:'IVE 안유진',title:'오늘도 안녕'}),'261102 IVE 안유진 오늘도 안녕');
  assert.equal(info.filename({date:'2026-11-02',artist:'IVE 안유진',title:'오늘도 안녕 | Berriz'}),'261102 IVE 안유진 오늘도 안녕');
});
test('invalid or missing dates are never replaced by today',()=>{
  assert.equal(info.dateOnly('2026-02-31'),'');
  assert.equal(info.filename({artist:'IVE 안유진',title:'제목'}),'IVE 안유진 제목');
  assert.equal(info.filename({title:'Like Berries, Berriz | 베리즈'}),'Berriz Replay');
});
test('timestamp dates follow Korean time',()=>{
  assert.equal(info.dateOnly('2026-11-01T16:00:00Z'),'2026-11-02');
  assert.equal(info.dateOnly('2026년 11월 2일'),'2026-11-02');
});
test('structured replay HTML metadata supplies actual date and author',()=>{
  const page='https://berriz.in/ko/ive/live/replay/example/';
  const region={querySelector(){return null;},querySelectorAll(){return [];},textContent:''};
  const doc={title:'Like Berries, Berriz',body:region,querySelector(s){return s.startsWith('main')?region:null;},querySelectorAll(s){return s.includes('ld+json')?[{textContent:JSON.stringify({'@type':'VideoObject',url:page,name:'라이브 제목',author:{name:'안유진'},publication:{'@type':'BroadcastEvent',startDate:'2026-11-01T16:00:00Z'}})}]:[];}};
  assert.deepEqual(info.extract(doc,page),{pageUrl:page,title:'라이브 제목',date:'2026-11-02',artist:'IVE 안유진'});
});
