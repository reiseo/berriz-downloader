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
  assert.deepEqual(info.extract(doc,page),{extractorVersion:2,pageUrl:page,title:'라이브 제목',date:'2026-11-02',artist:'IVE 안유진'});
});
function replayDocument({title='진짜 라이브 제목',hasInfo=true,excluded=false,joinedDate=false,og='',pageTitle='Like Berries, Berriz | 베리즈'}={}) {
  const region={querySelector(selector){return selector.startsWith('.h-19')?{textContent:joinedDate?'2026.11.0222:30':'2026.11.02 22:30',querySelectorAll(){return joinedDate?[{textContent:'2026.11.02'},{textContent:'22:30'}]:[];}}:selector.startsWith('span.f-body-s-medium')?{textContent:'안유진'}:null;}};
  const titleNode={textContent:title,parentElement:region,closest(){return excluded?{}:null;}};
  const scope={textContent:'댓글 66 팬닉네임 2026.11.03',querySelectorAll(selector){return selector.startsWith('p.f-body-xxl-semibold')&&hasInfo?[titleNode]:[{textContent:'댓글 66',closest(){return null;}}];}};
  return {body:scope,title:pageTitle,querySelector(selector){if(selector.startsWith('main'))return scope;if(selector.includes('og:title'))return {getAttribute(){return og;}};return null;},querySelectorAll(){return [];}};
}
test('the Berriz media paragraph wins over the comment heading and commenter names',()=>{
  const result=info.extract(replayDocument(),'https://berriz.in/ko/ive/live/replay/example/');
  assert.equal(info.filename(result),'261102 IVE 안유진 진짜 라이브 제목');
  assert.equal(result.extractorVersion,2);
});
test('comment counters and generic headings never become replay titles',()=>{
  for(const text of ['댓글 66','댓글66','댓글 (66)','댓글 1,234개','Comments 66','조회수 120'])assert.equal(info.titleOnly(text),'');
  assert.equal(info.titleOnly('댓글 읽으면서 같이 놀아요'),'댓글 읽으면서 같이 놀아요');
  const result=info.extract(replayDocument({hasInfo:false}),'https://berriz.in/ko/ive/live/replay/example/');
  assert.equal(result.title,'');assert.equal(result.date,'');assert.equal(result.artist,'IVE');
});
test('comment/chat containers cannot impersonate a media information block',()=>{
  const result=info.extract(replayDocument({excluded:true,og:'공식 라이브 제목 | Berriz'}),'https://berriz.in/ko/ive/live/replay/example/');
  assert.equal(result.title,'공식 라이브 제목');assert.equal(result.date,'');assert.equal(result.artist,'IVE');
});
test('date and time in adjacent spans do not lose the replay date',()=>{
  const result=info.extract(replayDocument({joinedDate:true}),'https://berriz.in/ko/ive/live/replay/example/');
  assert.equal(result.date,'2026-11-02');
});
