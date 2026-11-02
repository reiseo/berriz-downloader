const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs');
function setup({blocked=false,failSave=false}={}) {
  let listener, latest, cancelled=false, removed=false, finish;
  const gate=new Promise(r=>finish=r),snapshots=[],saved=[],mimeTypes=[];
  const file={async createWritable(){return {async write(){},async close(){},async abort(){}};},async getFile(){return new Blob(['TS']);}};
  const directory={async* entries(){},async getFileHandle(){return file;},async removeEntry(){removed=true;}};
  const M={safeName:x=>x||'Berriz',async loadPlaylist(){return {segments:['a'],duration:100,live:false};},async mux(v,a,write,signal,progress,get){await get('a',signal);progress({seconds:50,bytes:50});if(blocked)await gate;if(signal.aborted)throw new DOMException('cancel','AbortError');return 100;},async bytes(u,s,limit,onBytes){onBytes(100);return new Uint8Array(100);},async captions(){return [{start:1,end:2,text:'test'}];},renderCues(){return 'test';}};
  const chrome={runtime:{id:'test',getURL:x=>'chrome-extension://test/'+x,onMessage:{addListener(f){listener=f;}},async sendMessage(m){
    if(m.type==='snapshot'){latest=structuredClone(m.state);snapshots.push(latest);return {ok:true};}
    if(m.type==='save'){saved.push(m.filename);return {id:1};}
    if(m.type==='download-status')return failSave?{state:'interrupted',error:'FILE_FAILED'}:{state:'complete',filename:'C:\\Downloads\\'+saved.at(-1).replaceAll('/','\\')};
    if(m.type==='download-cancel'){cancelled=true;return {ok:true};}
  }}};
  const blobURL={createObjectURL(blob){mimeTypes.push(blob.type);return URL.createObjectURL(blob);},revokeObjectURL:URL.revokeObjectURL};
  vm.runInNewContext(fs.readFileSync('extension/offscreen.js','utf8'),{BerrizMedia:M,chrome,console,structuredClone,AbortController,DOMException,Blob,URL:blobURL,crypto:require('node:crypto').webcrypto,navigator:{storage:{async getDirectory(){return {async getDirectoryHandle(){return directory;}};}}},setInterval(){},setTimeout,Date});
  const send=m=>new Promise(resolve=>listener({target:'engine',...m},{id:'test'},resolve));
  const idle=async()=>{for(let i=0;i<50;i++){await new Promise(r=>setImmediate(r));if(latest&&!latest.busy)return;}throw Error('engine did not finish');};
  return {send,idle,finish,snapshots,saved,mimeTypes,get latest(){return latest;},get removed(){return removed;}};
}
test('download completes only after browser confirms file save and removes temp data',async()=>{
  const s=setup();await s.send({type:'initialize'});await s.send({type:'command',value:{command:'start',id:'job',video:'v',audio:'a',folder:'Berriz',name:'clip'}});await s.idle();
  assert.equal(s.latest.job.state,'complete');assert.equal(s.latest.job.path,'C:\\Downloads\\Berriz\\clip.ts');assert.equal(s.latest.job.receivedBytes,100);assert.equal(s.removed,true);
  assert.ok(s.snapshots.some(x=>x.job?.state==='saving'));assert.deepEqual(s.saved,['Berriz/clip.ts']);
  assert.deepEqual(s.mimeTypes,['video/mp2t']);
});
test('duplicate start is refused, popup reconnect retains active job, cancellation cleans temporary file',async()=>{
  const s=setup({blocked:true});await s.send({type:'initialize'});await s.send({type:'command',value:{command:'start',id:'one',folder:'Berriz'}});
  await new Promise(r=>setImmediate(r));
  assert.ok((await s.send({type:'command',value:{command:'start'}})).error);
  assert.equal((await s.send({type:'initialize'})).job.id,'one');
  await s.send({type:'command',value:{command:'cancel'}});s.finish();await s.idle();
  assert.equal(s.latest.job.state,'cancelled');assert.equal(s.removed,true);assert.equal(s.saved.length,0);
});
test('browser save failure is an error, never a completed job',async()=>{
  const s=setup({failSave:true});await s.send({type:'initialize'});await s.send({type:'command',value:{command:'start',folder:'Berriz'}});await s.idle();
  assert.equal(s.latest.job.state,'error');assert.match(s.latest.message,/FILE_FAILED/);assert.equal(s.removed,true);
});
test('new engine marks an old busy job interrupted rather than pretending it resumed',async()=>{
  const s=setup();const state=await s.send({type:'initialize',saved:{busy:true,job:{state:'progress'}}});
  assert.equal(state.busy,false);assert.equal(state.job.state,'interrupted');
});
test('SRT and VTT save with their own MIME types and matching extensions',async()=>{
  const s=setup();await s.send({type:'initialize'});await s.send({type:'command',value:{command:'subtitles',folder:'Berriz',name:'261102 IVE 안유진 제목',subtitle_format:'both',subtitles:[{url:'s',language:'ko'}]}});await s.idle();
  assert.equal(s.latest.job.state,'complete');
  assert.deepEqual(s.mimeTypes,['text/vtt;charset=utf-8','application/x-subrip;charset=utf-8']);
  assert.deepEqual(s.saved,['Berriz/261102 IVE 안유진 제목.ko.vtt','Berriz/261102 IVE 안유진 제목.ko.srt']);
});
