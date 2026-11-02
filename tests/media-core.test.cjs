const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const M = require('../extension/media-core');
const URL = 'https://statics.berriz.in/cdn/test/playlist.m3u8';
test('rejects outside hosts, encryption, fMP4 and timestamp discontinuities', () => {
  for (const url of ['https://evil.test/a.ts','http://statics.berriz.in/a.ts','https://user:secret@statics.berriz.in/a.ts']) assert.throws(() => M.checkURL(url));
  for (const tag of ['#EXT-X-KEY:METHOD=AES-128,URI="key"','#EXT-X-MAP:URI="init.mp4"','#EXT-X-DISCONTINUITY','#EXT-X-BYTERANGE:10']) assert.throws(() => M.playlist('#EXTM3U\n'+tag+'\n1.ts', URL));
});
test('output PSI has correct CRC and distinct video/audio PIDs', () => {
  const tables = M.tables();
  for (const p of tables) { const b = M.payload(p).subarray(1); const size = 3 + (b[1] & 15) * 256 + b[2]; assert.equal(M.crc32(b.subarray(0,size)),0); }
  assert.deepEqual(M.streams(Buffer.concat(tables)).streams, [{type:27,pid:256},{type:15,pid:257}]);
});
test('real source dimensions and DTS/PTS distinction are detected', { skip: !fs.existsSync('test-results/browser-only/video-first.ts') }, () => {
  const v = fs.readFileSync('test-results/browser-only/video-first.ts');
  assert.deepEqual(M.dimensions(v,256),{width:1080,height:1920});
  const p = [...M.packets(v)].find(p => ((p[1]&31)*256+p[2])===256 && (p[1]&64));
  const time = M.pesTime(p); assert.equal(time.pts,96000); assert.equal(time.dts,90000);
});
test('caption boundaries merge without changing cue times; SRT removes styling', () => {
  const first = 'WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:90000\n\n00:00:05.389 --> 00:00:06.000 align:start\n<b>A &amp; B</b>\n';
  const next = first.replace('00:00:05.389 --> 00:00:06.000','00:00:06.000 --> 00:00:07.500');
  const a=M.parseCues(first),b=M.parseCues(next,a.baseline); const cues=M.mergeCues([...a.cues,...b.cues]);
  assert.equal(cues.length,1); assert.equal(cues[0].start,5.389); assert.equal(cues[0].end,7.5);
  assert.match(M.renderCues(cues,'srt'),/00:00:05,389 --> 00:00:07,500\nA & B/);
  assert.match(M.renderCues(cues,'vtt'),/align:start/);
});
test('mux cancellation rejects and never reports completion', async () => {
  const controller = new AbortController(); controller.abort();
  const list = { segments:[URL],live:false,duration:8 };
  await assert.rejects(M.mux(list,list,()=>assert.fail('wrote after cancellation'),controller.signal,()=>assert.fail('progress after cancellation')), { name:'AbortError' });
});
test('corrupt TS packet and open live playlists fail explicitly', async () => {
  assert.throws(()=>[...M.packets(new Uint8Array(188))]);
  await assert.rejects(M.mux({live:true},{live:false},()=>{}),/다시보기/);
});
test('prefetch overlaps requests while preserving segment order',async()=>{
  const started=[],resolvers={};
  const iterator=M.segmentData(['a','b','c'],null,url=>new Promise(resolve=>{started.push(url);resolvers[url]=resolve;}));
  const first=iterator.next();await new Promise(r=>setImmediate(r));
  assert.deepEqual(started,['a','b']);resolvers.b('B');resolvers.a('A');
  assert.equal((await first).value,'A');
  assert.equal((await iterator.next()).value,'B');
  resolvers.c('C');assert.equal((await iterator.next()).value,'C');assert.equal((await iterator.next()).done,true);
});
test('closing a prefetch iterator cancels unused requests',async()=>{
  let cancelled=false;
  const iterator=M.segmentData(['a','b'],null,(url,signal)=>url==='a'?Promise.resolve('A'):new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{cancelled=true;reject(new DOMException('cancel','AbortError'));})));
  assert.equal((await iterator.next()).value,'A');await iterator.return();assert.equal(cancelled,true);
});
