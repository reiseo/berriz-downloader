const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const VIDEO = 'https://statics.berriz.in/vod/2/playlist.m3u8';
const AUDIO = 'https://statics.berriz.in/vod/5/playlist.m3u8';
function setup() {
  const data = {}, callbacks = {}, calls = [];
  const engineState = { connected:true,busy:true,job:{state:'progress',seconds:30,bytesPerSecond:1200000} };
  let exists = false;
  const chrome = {
    storage:{session:{async get(k){return {[k]:data[k]};},async set(v){Object.assign(data,structuredClone(v));},async remove(k){delete data[k];}}},
    runtime:{id:'test',getURL:p=>'chrome-extension://test/'+p,async getContexts(){return exists?[{}]:[];},async sendMessage(m){calls.push(m);return m.type==='initialize'?engineState:{ok:true};},onMessage:{addListener(f){callbacks.message=f;}}},
    offscreen:{async createDocument(){calls.push('create');exists=true;}},
    webRequest:{onBeforeRequest:{addListener(f){callbacks.request=f;}}},
    action:{async setBadgeText(){},async setBadgeBackgroundColor(){}},
    tabs:{onRemoved:{addListener(){}},onUpdated:{addListener(f){callbacks.updated=f;}}},
    downloads:{onDeterminingFilename:{addListener(f){callbacks.filename=f;}},async download(v){calls.push(v);return 9;},async search(){return [{id:9,byExtensionId:'test',state:'complete',filename:'C:\\Downloads\\Berriz\\clip.ts'}];},async cancel(){},showDefaultFolder(){}}
  };
  vm.runInNewContext(fs.readFileSync('extension/background.js','utf8'),{chrome,URL,console});
  const manager={id:'test',url:'chrome-extension://test/manager.html?popup=1'};
  const engine={id:'test',url:'chrome-extension://test/offscreen.html'};
  const send=(message,sender=manager)=>new Promise(resolve=>callbacks.message(message,sender,resolve));
  return {data,callbacks,calls,send,engine,engineState,flush:()=>new Promise(r=>setImmediate(r))};
}
test('concurrent captures are preserved; numeric caption fragments do not evict playlists',async()=>{
  const {callbacks:c,data,flush}=setup();
  c.request({tabId:7,url:VIDEO});c.request({tabId:7,url:AUDIO});c.request({tabId:7,url:VIDEO});
  for(let i=0;i<100;i++)c.request({tabId:7,url:`https://statics.berriz.in/sub/${i}.vtt`});
  await flush();assert.deepEqual(data['tab:7'].urls,[VIDEO,AUDIO]);
});
test('content scripts cannot issue commands or spoof engine snapshots',()=>{
  const {callbacks:c,calls}=setup();
  for(const type of ['command','snapshot','save']) c.message({type,value:{command:'start'}},{id:'test',tab:{id:7},url:'https://berriz.in/'},()=>assert.fail('unauthorized request'));
  assert.equal(calls.length,0);
});
test('concurrent popup connections create one offscreen document and recover active progress',async()=>{
  const {send,calls,engineState}=setup();
  const results=await Promise.all([send({type:'connect'}),send({type:'connect'})]);
  assert.equal(calls.filter(x=>x==='create').length,1);
  assert.equal(results[0].job.seconds,30);assert.equal(results[1],engineState);
  await send({type:'command',value:{command:'cancel'}});
  assert.equal(calls.at(-1).value.command,'cancel');
});
test('only own blob URLs and relative download paths are accepted',async()=>{
  const {send,engine}=setup();
  assert.ok((await send({type:'save',url:'https://evil.test/clip',filename:'a.ts'},engine)).error);
  assert.ok((await send({type:'save',url:'blob:chrome-extension://test/id',filename:'../a.ts'},engine)).error);
  assert.equal((await send({type:'save',url:'blob:chrome-extension://test/id',filename:'Berriz/a.ts'},engine)).id,9);
  assert.equal((await send({type:'download-status',id:9},engine)).state,'complete');
});
test('engine snapshots preserve detailed progress independently of popup lifetime',async()=>{
  const {send,engine,data,engineState}=setup();
  await send({type:'snapshot',state:engineState},engine);
  assert.equal(data.native.job.bytesPerSecond,1200000);
  assert.equal(data.native.busy,true);
});
test('navigation clears capture for only the affected tab',async()=>{
  const {callbacks:c,data,flush}=setup();
  c.request({tabId:7,url:VIDEO});c.request({tabId:8,url:AUDIO});c.updated(7,{status:'loading',url:'https://berriz.in/'});
  await flush();assert.equal(data['tab:7'],undefined);assert.deepEqual(data['tab:8'].urls,[AUDIO]);
});
test('filename determination restores the requested subtitle extension over MIME guesses',async()=>{
  const {send,engine,callbacks:c}=setup();
  const url='blob:chrome-extension://test/subtitle';
  await send({type:'save',url,filename:'Berriz/261102 IVE 안유진 제목.ko.srt'},engine);
  const result=await new Promise(resolve=>c.filename({byExtensionId:'test',url,filename:'subtitle.txt'},resolve));
  assert.equal(result.filename,'Berriz/261102 IVE 안유진 제목.ko.srt');
  assert.equal(result.conflictAction,'uniquify');
  const other=await new Promise(resolve=>c.filename({byExtensionId:'other',url,filename:'other.txt'},resolve));
  assert.equal(other,undefined);
});
test('metadata is scoped to the top frame and exact replay page',async()=>{
  const {send,data}=setup();const page='https://berriz.in/ko/ive/live/replay/example/';
  const sender={id:'test',frameId:0,tab:{id:7},url:page};
  assert.ok((await send({type:'metadata',metadata:{pageUrl:page,title:'제목',date:'2026-11-02',artist:'IVE 안유진'}},sender)).ok);
  assert.equal(data['meta:7'].artist,'IVE 안유진');
  assert.ok((await send({type:'metadata',metadata:{pageUrl:'https://berriz.in/wrong/'}},sender)).error);
});
