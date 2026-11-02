const $ = id => document.getElementById(id);
document.body.classList.toggle('popup', new URLSearchParams(location.search).has('popup'));
// Show active downloads at the top, including when reopening their popup.
document.querySelector('header').after(document.querySelector('.status-card'));
let visibleJobId = null;
let initialized = false;
let state = {};
let urls = [];
let tracks = [];
let trackSignature = '';
let subtitleSignature = '';
let autoAnalyzeTimer;
let autoAnalyzeSignature = '';
let autoAnalyzing = false;
let nameEdited = false, metadataEdited = false, metadataPageUrl = '';
let selectedTab = Number(new URLSearchParams(location.search).get('tab')) || null;
const seconds = value => { const s = Math.max(0, Math.floor(value || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const megabytes = bytes => bytes >= 1073741824 ? `${(bytes / 1073741824).toFixed(2)} GiB` : `${((bytes || 0) / 1048576).toFixed(1)} MiB`;
const relativeFolder = value => typeof value === 'string' && !/[:\\]/.test(value) && !value.startsWith('/') ? value : 'Berriz';

async function command(value) {
  if (value.command === 'inspect') clearTimeout(autoAnalyzeTimer);
  const response = await chrome.runtime.sendMessage({ type: 'command', value: { id: crypto.randomUUID(), ...value } });
  if (response?.error) throw new Error(response.error);
}

function showError(error) {
  const target = document.querySelector('.status-card').hidden ? $('streamStatus') : $('status');
  target.textContent = error.message;
  target.hidden = false;
}
function handle(action) { return () => Promise.resolve().then(action).catch(showError); }

function scheduleAutoAnalyze() {
  clearTimeout(autoAnalyzeTimer);
  autoAnalyzeTimer = setTimeout(async () => {
    if (!initialized || !state.connected || state.busy || autoAnalyzing || !urls.length) return;
    const signature = JSON.stringify([selectedTab, [...urls].sort()]);
    if (signature === autoAnalyzeSignature) return;
    autoAnalyzeSignature = signature;
    autoAnalyzing = true;
    try { await command({ command: 'inspect', urls: [...urls] }); }
    catch (error) { showError(error); }
    finally { autoAnalyzing = false; }
  }, 350);
}

async function refreshTabs() {
  const tabs = (await chrome.tabs.query({})).filter(tab => /^https:\/\/([^/]+\.)?berriz\.in\//.test(tab.url || ''));
  const previous = Number($('source').value) || selectedTab;
  $('source').replaceChildren(...tabs.map(tab => new Option(tab.title || tab.url, String(tab.id))));
  if (!tabs.length) $('source').add(new Option('열린 Berriz 탭 없음', ''));
  if (tabs.some(tab => tab.id === previous)) $('source').value = String(previous);
  await refreshCapture();
}

function saveForm() {
  if (!initialized) return;
  chrome.storage.session.set({ popupForm: {
    selectedTab, signature: trackSignature, video: $('video').value, audio: $('audio').value,
    name: $('name').value, folder: $('folder').value, manual: $('manual').value,
    subtitleFormat: $('subtitleFormat').value, subtitleDefaultVersion: 1, subtitles: selectedSubtitles().map(track => track.url),
    nameEdited, metadataEdited, metadataPageUrl, metadataExtractorVersion: 2, liveDate: $('liveDate').value, liveArtist: $('liveArtist').value, liveTitle: $('liveTitle').value
  } }).catch(showError);
}

function restoreForm(form) {
  if (!form || form.selectedTab !== selectedTab) return;
  if (form.metadataPageUrl && form.metadataPageUrl !== metadataPageUrl) return;
  nameEdited = form.nameEdited === true;
  metadataEdited = form.metadataEdited === true && form.metadataExtractorVersion === 2;
  if (form.metadataPageUrl && form.metadataPageUrl === metadataPageUrl && metadataEdited) {
    for (const key of ['liveDate', 'liveArtist', 'liveTitle']) if (typeof form[key] === 'string') $(key).value = form[key];
  }
  for (const key of ['name', 'folder', 'manual', 'subtitleFormat']) {
    if (key === 'name' && !nameEdited) continue;
    // Apply the new SRT default once when upgrading; remember later explicit choices.
    if (key === 'subtitleFormat' && form.subtitleDefaultVersion !== 1) continue;
    if (typeof form[key] === 'string') $(key).value = key === 'folder' ? relativeFolder(form[key]) : form[key];
  }
  updateSubtitleFormats();
  if (!nameEdited) applyGeneratedName();
  if (form.signature !== trackSignature) return;
  if ([...$('video').options].some(option => option.value === form.video)) {
    $('video').value = form.video;
    updateAudio();
  }
  if ([...$('audio').options].some(option => option.value === form.audio)) $('audio').value = form.audio;
  document.querySelectorAll('input[name="subtitle"]').forEach(input => { input.checked = (form.subtitles || []).includes(input.value); });
  updateButtons();
}

async function refreshCapture() {
  selectedTab = Number($('source').value) || null;
  const tab = selectedTab ? await chrome.tabs.get(selectedTab).catch(() => null) : null;
  const pageUrl = tab?.url ? new URL(tab.url).origin + new URL(tab.url).pathname : '';
  if (pageUrl !== metadataPageUrl) {
    metadataPageUrl = pageUrl; nameEdited = false; metadataEdited = false;
    for (const key of ['liveDate', 'liveArtist', 'liveTitle']) $(key).value = '';
    $('name').value = 'Berriz Replay';
  }
  await refreshMetadata(tab);
  const key = `tab:${selectedTab}`;
  urls = ((await chrome.storage.session.get(key))[key]?.urls || []);
  $('captured').replaceChildren(...urls.map(url => { const div = document.createElement('div'); div.textContent = url; return div; }));
  $('captureHint').textContent = urls.length ? `${urls.length}개 주소 감지됨 · 분석하면 실제 화질과 오디오를 확인합니다.` : 'Berriz 탭에서 다시보기를 재생해 주세요. 처음 설치한 경우 재생 탭을 새로고침해 주세요.';
  updateButtons();
  scheduleAutoAnalyze();
}

function applyGeneratedName() {
  $('name').value = BerrizReplayInfo.filename({ date: $('liveDate').value, artist: $('liveArtist').value, title: $('liveTitle').value });
}
async function refreshMetadata(tab) {
  if (!selectedTab) return;
  const stored = (await chrome.storage.session.get(`meta:${selectedTab}`))[`meta:${selectedTab}`];
  let metadata = stored?.pageUrl === metadataPageUrl && stored.extractorVersion === 2 ? stored : null;
  if (!metadata) metadata = await chrome.tabs.sendMessage(selectedTab, { type: 'read-replay-metadata' }, { frameId: 0 }).catch(() => null);
  if (metadata?.extractorVersion !== 2) metadata = null;
  if (!metadataEdited && metadata?.pageUrl === metadataPageUrl) {
    $('liveDate').value = BerrizReplayInfo.dateOnly(metadata.date);
    $('liveArtist').value = metadata.artist || '';
    $('liveTitle').value = metadata.title || '';
  } else if (!metadata && !metadataEdited && tab) {
    $('liveTitle').value = BerrizReplayInfo.titleOnly(tab.title);
  }
  $('metadataHint').textContent = $('liveDate').value && $('liveArtist').value && $('liveTitle').value ? '재생 페이지의 정보를 읽었습니다. 필요하면 아래에서 수정하세요.' : '페이지에서 확인되지 않은 항목이 있습니다. 날짜·아티스트·제목을 직접 보완하거나, 업데이트 후 Berriz 탭을 새로고침하세요.';
  if (!nameEdited) applyGeneratedName();
}

function updateButtons() {
  const ready = state.connected && !state.busy;
  $('analyze').disabled = !ready || !urls.length;
  $('manualAnalyze').disabled = !ready;
  $('download').disabled = !ready || !$('video').value || !$('audio').value;
  $('cancel').disabled = !state.busy;
  $('reveal').disabled = !state.connected;
  $('subtitlesOnly').disabled = !ready || !selectedSubtitles().length;
}

function selectedSubtitles() {
  const selected = new Set([...document.querySelectorAll('input[name="subtitle"]:checked')].map(input => input.value));
  return (state.subtitles || []).filter(track => selected.has(track.url));
}

function subtitleOptions() {
  return { subtitles: selectedSubtitles(), subtitle_format: $('subtitleFormat').value };
}

function updateSubtitleFormats() {
  const format = { srt: 'SRT', vtt: 'VTT', both: 'SRT + VTT' }[$('subtitleFormat').value] || 'SRT';
  document.querySelectorAll('.subtitle-format').forEach(badge => { badge.textContent = format; });
}

function render(next) {
  state = next || {};
  $('status').textContent = state.message || '대기 중';
  $('streamStatus').textContent = state.message || '대기 중';
  if (!$('folder').value && state.folder) $('folder').value = state.folder;
  tracks = state.tracks || [];
  const signature = JSON.stringify(tracks);
  if (signature !== trackSignature) {
    trackSignature = signature;
    const videos = tracks.filter(track => track.video);
    $('video').replaceChildren(...videos.map((track, index) => new Option(track.label + (index === 0 ? ' · 최고 화질 (기본)' : ''), track.url)));
    if (!videos.length) $('video').add(new Option('먼저 스트림을 분석해 주세요', ''));
    updateAudio();
  }
  const subsSignature = JSON.stringify(state.subtitles || []);
  if (subsSignature !== subtitleSignature) {
    subtitleSignature = subsSignature;
    const options = (state.subtitles || []).map(track => {
      const label = document.createElement('label'); label.className = 'subtitle-option';
      const input = document.createElement('input'); input.type = 'checkbox'; input.name = 'subtitle'; input.value = track.url;
      input.checked = track.language === 'ko'; input.onchange = updateButtons;
      const title = document.createElement('span'); title.textContent = track.label || track.language || track.name;
      const format = document.createElement('small'); format.className = 'subtitle-format'; format.title = '저장 형식';
      label.append(input, title, format); return label;
    });
    $('subtitles').replaceChildren(...options);
    if (!options.length) { const hint = document.createElement('p'); hint.className = 'muted'; hint.textContent = '자막이 감지되지 않았습니다. 다시보기 탭을 새로고침해 전체 플레이리스트를 다시 감지하거나, 자막 주소를 직접 입력할 수 있습니다.'; $('subtitles').append(hint); }
  }
  updateSubtitleFormats();
  const job = state.job;
  const activeDownload = job && ['preparing', 'started', 'progress', 'saving', 'video_complete', 'subtitle_progress', 'subtitle_saved'].includes(job.state);
  if (activeDownload) visibleJobId = job.id;
  const showProgress = Boolean(job && (activeDownload || (visibleJobId && visibleJobId === job.id)));
  document.querySelector('.status-card').hidden = !showProgress;
  $('streamStatus').hidden = showProgress;
  $('streamWarnings').hidden = showProgress;
  if (job) {
    const done = job.state === 'complete';
    const subtitleStage = ['subtitle_progress', 'subtitle_saved'].includes(job.state);
    const saving = job.state === 'saving';
    const percent = done ? 100 : saving ? Math.min(99.9, (job.savedBytes || 0) / (job.saveTotal || job.bytes || 1) * 100) : subtitleStage ? Math.min(99.9, ((job.current || 0) + (job.segments_done || 0) / (job.segments_total || 1)) / (job.total || 1) * 100) : job.duration ? Math.min(99.9, (job.seconds || 0) / job.duration * 100) : 0;
    $('progress').value = percent;
    $('percent').textContent = done || job.duration || subtitleStage ? `${percent.toFixed(1)}%` : '';
    $('stats').textContent = saving ? `파일 저장 ${megabytes(job.savedBytes)} / ${megabytes(job.saveTotal || job.bytes)}` : subtitleStage ? `자막 ${(job.current || 0) + 1} / ${job.total || 1} · ${job.segments_done || 0} / ${job.segments_total || '?'}조각` : job.subtitle_only ? `${job.subtitles?.length || 0}개 자막 파일 저장됨` : `병합한 재생 구간 ${seconds(job.seconds)}${job.duration ? ` / ${seconds(job.duration)}` : ''} · TS ${megabytes(job.bytes)}`;
    $('rate').textContent = state.busy && !saving ? `${megabytes(job.bytesPerSecond)}/s` : '—';
    $('eta').textContent = done ? '완료' : saving ? '파일 저장 중' : ['progress', 'subtitle_progress'].includes(job.state) && Number.isFinite(job.etaSeconds) ? `약 ${seconds(Math.ceil(job.etaSeconds))}` : state.busy ? '계산 중…' : '—';
    $('size').textContent = `${megabytes(job.receivedBytes)} / ${done ? megabytes(job.receivedBytes) : job.estimatedBytes ? '약 ' + megabytes(job.estimatedBytes) : '계산 중'}`;
    $('elapsed').textContent = seconds(job.elapsedSeconds);
    $('path').textContent = job.state === 'cancelled' ? (job.partial || job.path || '') : (job.path || '');
    $('savedSubtitles').replaceChildren(...(job.subtitles || job.paths || []).map(path => { const div = document.createElement('div'); div.textContent = path; return div; }));
    if (job.state === 'interrupted') $('status').textContent = '이전 작업이 중단되었습니다. 다시 다운로드해 주세요.';
  }
  $('warnings').textContent = (state.warnings || []).map(w => w.message).join('\n');
  $('streamWarnings').textContent = $('warnings').textContent;
  updateButtons();
}

function updateAudio() {
  const video = tracks.find(track => track.url === $('video').value);
  const previous = $('audio').value;
  const audioTracks = tracks.filter(track => track.audio && !track.video);
  // Restrict separate audio to the same VOD group when possible.
  const group = url => new URL(url).pathname.replace(/\/[^/]+\/[^/]+$/, '/');
  const sameGroup = video ? audioTracks.filter(track => group(track.url) === group(video.url)) : [];
  const choices = sameGroup.length ? sameGroup : audioTracks;
  $('audio').replaceChildren(...choices.map(track => new Option(track.label, track.url)));
  if (video?.audio) $('audio').add(new Option('영상에 포함된 오디오', video.url), 0);
  if (!$('audio').options.length) $('audio').add(new Option('오디오 주소도 감지하거나 직접 입력해 주세요', ''));
  if ([...$('audio').options].some(option => option.value === previous)) $('audio').value = previous;
  $('duration').textContent = video ? `${video.live ? '진행 중인 라이브는 지원하지 않습니다' : `재생 시간 ${seconds(video.duration)}`} · 재인코딩 없이 원본 화질로 저장` : '영상과 오디오를 원본 화질 그대로 합쳐 TS로 저장합니다.';
  updateButtons();
}

$('refresh').onclick = handle(refreshTabs);
$('source').onchange = handle(async () => { await refreshCapture(); saveForm(); });
$('connect').onclick = handle(async () => { const result = await chrome.runtime.sendMessage({ type: 'connect' }); if (result?.error) throw new Error(result.error); render(result); });
$('analyze').onclick = handle(() => command({ command: 'inspect', urls }));
$('manualAnalyze').onclick = handle(() => command({ command: 'inspect', urls: $('manual').value.split(/\s+/).filter(Boolean) }));
$('video').onchange = updateAudio;
$('audio').onchange = updateButtons;
$('subtitleFormat').onchange = updateSubtitleFormats;
$('name').oninput = () => { nameEdited = true; };
for (const key of ['liveDate', 'liveArtist', 'liveTitle']) $(key).oninput = () => { metadataEdited = true; nameEdited = false; applyGeneratedName(); };
$('applyName').onclick = () => { nameEdited = false; applyGeneratedName(); saveForm(); };
$('download').onclick = handle(async () => {
  const video = tracks.find(track => track.url === $('video').value);
  await command({ command: 'start', video: $('video').value, audio: $('audio').value,
    duration: video?.live ? 0 : video?.duration, name: $('name').value, folder: $('folder').value, ...subtitleOptions() });
  await chrome.storage.local.set({ folder: $('folder').value });
});
$('subtitlesOnly').onclick = handle(() => command({ command: 'subtitles', name: $('name').value, folder: $('folder').value, ...subtitleOptions() }));
$('selectAllSubs').onclick = () => { document.querySelectorAll('input[name="subtitle"]').forEach(input => { input.checked = true; }); updateButtons(); saveForm(); };
$('clearSubs').onclick = () => { document.querySelectorAll('input[name="subtitle"]').forEach(input => { input.checked = false; }); updateButtons(); saveForm(); };
$('cancel').onclick = handle(() => command({ command: 'cancel' }));
$('reveal').onclick = handle(() => command({ command: 'reveal', folder: $('folder').value }));
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  if (changes.native) render(changes.native.newValue);
  if (changes[`tab:${selectedTab}`]) refreshCapture().catch(showError);
  if (changes[`meta:${selectedTab}`]) refreshMetadata().catch(showError);
  if (changes.selectedTab) { selectedTab = changes.selectedTab.newValue; refreshTabs().catch(showError); }
});

(async () => {
  const form = (await chrome.storage.session.get('popupForm')).popupForm;
  const [active] = await chrome.tabs.query({ active: true, currentWindow: true });
  selectedTab = /^https:\/\/([^/]+\.)?berriz\.in\//.test(active?.url || '') ? active.id : form?.selectedTab || selectedTab;
  const saved = await chrome.storage.local.get('folder');
  if (saved.folder) $('folder').value = relativeFolder(saved.folder);
  const stored = await chrome.storage.session.get('native');
  render(stored.native);
  await refreshTabs();
  restoreForm(form);
  initialized = true;
  document.addEventListener('input', saveForm);
  document.addEventListener('change', saveForm);
  const result = await chrome.runtime.sendMessage({ type: 'connect' });
  if (result?.error) throw new Error(result.error);
  render(result);
  saveForm();
  scheduleAutoAnalyze();
})().catch(showError);
