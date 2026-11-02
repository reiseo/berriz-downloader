const M = BerrizMedia;
let state, controller, tempDirectory, activeDownload, inspecting = false;
let publishing = Promise.resolve();
let received = 0, samples = [], jobStart = 0, lastPublish = 0, subtitleStart = 0;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function rpc(message) {
  const answer = await chrome.runtime.sendMessage(message);
  if (answer?.error) throw new Error(answer.error);
  if (!answer) throw new Error('확장 프로그램 연결이 끊겼습니다.');
  return answer;
}
function publish() {
  const snapshot = structuredClone(state);
  publishing = publishing.catch(() => {}).then(() => rpc({ type: 'snapshot', state: snapshot }));
  return publishing;
}
function patchJob(values, message) {
  Object.assign(state.job, values);
  if (message) state.message = message;
  return publish();
}
function updateMetrics(force = false) {
  const now = Date.now();
  if (inspecting || !state?.job || (!force && now - lastPublish < 500)) return;
  lastPublish = now; samples.push([now, received]);
  while (samples.length > 2 && samples[1][0] < now - 8000) samples.shift();
  const elapsed = (now - samples[0][0]) / 1000;
  const rate = elapsed > .2 ? (received - samples[0][1]) / elapsed : 0;
  const job = state.job;
  const fraction = job.duration ? Math.min(1, (job.seconds || 0) / job.duration) : 0;
  const estimate = fraction > .01 ? Math.max(received, (job.bytes || 0) / fraction) : (job.estimatedBytes || 0);
  const eta = fraction > .01 && rate > 1024 ? Math.max(0, estimate - received) / rate : null;
  const subFraction = job.total && job.segments_total ? ((job.current || 0) + (job.segments_done || 0) / job.segments_total) / job.total : 0;
  const subETA = subFraction > .01 ? (now - subtitleStart) / 1000 * (1 - subFraction) / subFraction : null;
  Object.assign(job, { receivedBytes: received, bytesPerSecond: rate, estimatedBytes: Math.max(received, estimate), etaSeconds: job.state === 'progress' ? eta : job.state === 'subtitle_progress' ? subETA : null, elapsedSeconds: (now - jobStart) / 1000 });
  publish().catch(console.error);
}
function onBytes(n) { received += n; updateMetrics(); }
function checkAbort() { if (controller.signal.aborted) throw new DOMException('취소되었습니다.', 'AbortError'); }
function folderName(value) {
  const v = String(value || 'Berriz').replace(/\\/g, '/');
  if (v.startsWith('/') || v.includes(':') || v.split('/').some(p => !p || p === '.' || p === '..')) throw new Error('브라우저 다운로드 폴더 안의 하위 폴더 이름을 입력해 주세요. 예: Berriz');
  return v.split('/').map(M.safeName).join('/');
}
async function saveBlob(blob, filename, video = false) {
  const extension = filename.split('.').at(-1).toLowerCase();
  const mime = { ts: 'video/mp2t', srt: 'application/x-subrip;charset=utf-8', vtt: 'text/vtt;charset=utf-8' }[extension];
  if (!mime) throw new Error('지원하지 않는 저장 확장자입니다.');
  // slice changes MIME without reading the complete disk-backed video into RAM.
  blob = blob.slice(0, blob.size, mime);
  checkAbort(); const url = URL.createObjectURL(blob); let completed = false;
  try {
    activeDownload = (await rpc({ type: 'save', url, filename })).id;
    for (;;) {
      checkAbort(); const item = await rpc({ type: 'download-status', id: activeDownload });
      if (item.state === 'complete') {
        completed = true;
        if (!item.filename.toLowerCase().endsWith('.' + extension)) throw new Error(`브라우저가 파일 확장자를 변경했습니다: ${item.filename}. 다른 다운로드 확장의 이름 변경 설정을 확인하세요.`);
        return item.filename;
      }
      if (item.state === 'interrupted') throw new Error(`파일 저장 중단: ${item.error || '브라우저 다운로드 목록을 확인해 주세요.'}`);
      const needsAttention = item.paused || (item.danger && !['safe', 'accepted', 'allowlistedByPolicy', 'deepScannedSafe'].includes(item.danger));
      if (video) await patchJob({ state: 'saving', savedBytes: item.bytes, saveTotal: blob.size, etaSeconds: null }, needsAttention ? '파일 저장 대기 · 브라우저 다운로드 목록을 확인하세요.' : '병합 완료 · 다운로드 폴더에 파일 저장 중…');
      else if (needsAttention) { state.message = '자막 저장 대기 · 브라우저 다운로드 목록을 확인하세요.'; await publish(); }
      await pause(500);
    }
  } finally {
    if (!completed && activeDownload !== undefined) await rpc({ type: 'download-cancel', id: activeDownload }).catch(() => {});
    activeDownload = undefined; URL.revokeObjectURL(url);
  }
}
async function initialize(saved) {
  if (state) return state;
  state = { ...saved, connected: true, busy: false, folder: 'Berriz', message: '브라우저 엔진 준비됨', tracks: saved?.tracks || [], subtitles: saved?.subtitles || [], warnings: saved?.warnings || [], job: saved?.job || null };
  if (saved?.busy) { if (state.job) state.job.state = 'interrupted'; state.message = '이전 작업이 중단되었습니다. 다시 다운로드해 주세요.'; }
  await publish(); return state;
}
async function prepareDirectory() {
  const root = await navigator.storage.getDirectory();
  tempDirectory = await root.getDirectoryHandle('berriz-temp-v1', { create: true });
  for await (const [name] of tempDirectory.entries()) await tempDirectory.removeEntry(name, { recursive: true });
}
async function run(command) {
  let fileName, writable;
  try {
    if (command.command === 'inspect') {
      const result = await M.inspect(command.urls, controller.signal);
      Object.assign(state, result, { message: `영상·오디오 ${result.tracks.length}개 / 자막 ${result.subtitles.length}개를 찾았습니다.` }); return;
    }
    const folder = folderName(command.folder), base = M.safeName(command.name);
    const paths = [], errors = [];
    const selected = Array.isArray(command.subtitles) ? command.subtitles.slice(0, 50) : [];
    let path = '', size = 0;
    if (command.command === 'start') {
      await prepareDirectory(); checkAbort();
      const [video, audio] = await Promise.all([M.loadPlaylist(command.video, controller.signal), M.loadPlaylist(command.audio, controller.signal)]);
      if (!video.segments.length || !audio.segments.length) throw new Error('영상과 오디오의 개별 플레이리스트를 선택해 주세요.');
      fileName = crypto.randomUUID() + '.ts';
      const file = await tempDirectory.getFileHandle(fileName, { create: true }); writable = await file.createWritable();
      await patchJob({ state: 'progress', duration: video.duration }, '영상·오디오 다운로드 및 병합 중…');
      size = await M.mux(video, audio, chunk => writable.write(chunk), controller.signal, progress => {
        Object.assign(state.job, progress); updateMetrics();
      }, (url, signal) => M.bytes(url, signal, undefined, onBytes));
      await writable.close(); writable = null; checkAbort();
      await patchJob({ state: 'saving', bytes: size, seconds: video.duration, estimatedBytes: size, receivedBytes: received, etaSeconds: null }, '병합 완료 · 다운로드 폴더에 파일 저장 중…');
      path = await saveBlob(await file.getFile(), `${folder}/${base}.ts`, true);
      await tempDirectory.removeEntry(fileName); fileName = null;
      await patchJob({ state: 'video_complete', path, bytes: size, savedBytes: size }, '영상 저장 완료');
    }
    const actualBase = path ? path.split(/[\\/]/).at(-1).replace(/\.ts$/i, '') : base;
    subtitleStart = Date.now();
    for (let i = 0; i < selected.length; i++) {
      checkAbort(); const track = selected[i];
      await patchJob({ state: 'subtitle_progress', track: track.label || track.language, current: i, total: selected.length, segments_done: 0, segments_total: 0, etaSeconds: null }, `자막 다운로드 · ${track.label || track.language || i + 1}`);
      try {
        const cues = await M.captions(track, controller.signal, (done, total) => {
          Object.assign(state.job, { segments_done: done, segments_total: total }); updateMetrics();
        }, onBytes);
        const formats = command.subtitle_format === 'both' ? ['vtt', 'srt'] : [command.subtitle_format === 'vtt' ? 'vtt' : 'srt'];
        for (const format of formats) {
          const blob = new Blob([M.renderCues(cues, format)], { type: format === 'vtt' ? 'text/vtt;charset=utf-8' : 'application/x-subrip;charset=utf-8' });
          paths.push(await saveBlob(blob, `${folder}/${actualBase}.${M.safeName(track.language || track.name || String(i + 1))}.${format}`));
          await patchJob({ subtitles: [...paths] });
        }
      } catch (error) { checkAbort(); errors.push({ message: `${track.label || track.language}: ${error.message}` }); }
    }
    state.warnings = errors;
    if (command.command === 'subtitles' && !paths.length) throw new Error(errors.length ? '선택한 자막을 저장하지 못했습니다. 아래 오류 내용을 확인하세요.' : '저장할 자막을 선택해 주세요.');
    await patchJob({ state: 'complete', path, bytes: size, subtitles: paths, subtitle_errors: errors, subtitle_only: command.command === 'subtitles', receivedBytes: received, elapsedSeconds: (Date.now() - jobStart) / 1000, bytesPerSecond: 0, etaSeconds: 0 }, (command.command === 'subtitles' ? '자막 저장 완료' : 'TS 저장 완료') + (errors.length ? ' · 일부 자막 실패' : ''));
  } catch (error) {
    const cancelled = controller.signal.aborted;
    state.message = cancelled ? '취소됨 · 완료된 파일은 보존됩니다.' : error.name === 'QuotaExceededError' ? '임시 저장 공간이 부족합니다. 디스크 여유 공간을 확보해 주세요.' : error.message;
    if (state.job && !inspecting) Object.assign(state.job, { state: cancelled ? 'cancelled' : 'error', bytesPerSecond: 0, etaSeconds: null });
  } finally {
    if (writable) await writable.abort().catch(() => {});
    if (fileName) await tempDirectory.removeEntry(fileName).catch(() => {});
    state.busy = false; await publish();
  }
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || sender.tab || message.target !== 'engine') return;
  // Same-extension contexts only; content-script senders have a tab and are rejected above.
  if (message.type === 'initialize') { initialize(message.saved).then(reply, e => reply({ error: e.message })); return true; }
  if (message.type !== 'command' || !state) return;
  const command = message.value;
  if (command?.command === 'cancel') { controller?.abort(); reply({ ok: true }); return; }
  if (!['inspect', 'start', 'subtitles'].includes(command?.command)) { reply({ error: '지원하지 않는 작업입니다.' }); return; }
  if (state.busy) { reply({ error: '이미 진행 중인 작업이 있습니다.' }); return; }
  state.busy = true; controller = new AbortController(); state.warnings = []; inspecting = command.command === 'inspect';
  state.message = inspecting ? '스트림 분석 중…' : '다운로드 준비 중…';
  if (!inspecting) {
    jobStart = Date.now(); received = 0; samples = [[jobStart, 0]]; lastPublish = 0;
    state.job = { id: command.id, state: 'preparing', duration: command.duration || 0, bytes: 0, receivedBytes: 0, subtitles: [], subtitle_only: command.command === 'subtitles' };
  }
  publish().catch(console.error); reply({ ok: true }); run(command).catch(console.error);
});
setInterval(() => { if (state?.busy) updateMetrics(true); }, 1000);
