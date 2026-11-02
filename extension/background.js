let captureQueue = Promise.resolve();
let creating;
const engineURL = chrome.runtime.getURL('offscreen.html');
const managerURL = chrome.runtime.getURL('manager.html');
function allowed(url) {
  try { const p = new URL(url); return p.protocol === 'https:' && p.hostname === 'statics.berriz.in' && !p.username && !p.password && /\.(m3u8|vtt|srt)$/i.test(p.pathname); } catch { return false; }
}
async function record(tabId, url) {
  if (tabId < 0 || !allowed(url) || /\/\d+\.vtt(?:\?|$)/i.test(url)) return;
  const key = `tab:${tabId}`;
  const data = (await chrome.storage.session.get(key))[key] || { urls: [] };
  if (data.urls.includes(url)) return;
  data.urls = [...data.urls, url].slice(-40);
  await chrome.storage.session.set({ [key]: data });
  await chrome.action.setBadgeText({ tabId, text: String(data.urls.length) });
  await chrome.action.setBadgeBackgroundColor({ tabId, color: '#c83b66' });
}
function queueRecord(tabId, url) { captureQueue = captureQueue.then(() => record(tabId, url)).catch(console.error); return captureQueue; }
chrome.webRequest.onBeforeRequest.addListener(d => { queueRecord(d.tabId, d.url); }, { urls: ['https://statics.berriz.in/*'] });
async function ensureEngine() {
  if (!creating) creating = (async () => {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [engineURL] });
    if (!contexts.length) await chrome.offscreen.createDocument({ url: 'offscreen.html', reasons: ['BLOBS'], justification: 'Merge media into disk-backed files and keep downloads running when the popup closes.' });
    const saved = (await chrome.storage.session.get('native')).native;
    return chrome.runtime.sendMessage({ target: 'engine', type: 'initialize', saved });
  })().finally(() => { creating = null; });
  return creating;
}
function isPage(url, expected) { return typeof url === 'string' && url.split(/[?#]/)[0] === expected; }
chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  if (item.byExtensionId !== chrome.runtime.id || !item.url?.startsWith('blob:' + chrome.runtime.getURL(''))) { suggest(); return; }
  chrome.storage.session.get(`save:${item.url}`).then(data => {
    const filename = data[`save:${item.url}`];
    suggest(filename ? { filename, conflictAction: 'uniquify' } : undefined);
  }, () => suggest());
  return true;
});
async function ownedDownload(id) {
  const [item] = await chrome.downloads.search({ id });
  if (!item || item.byExtensionId !== chrome.runtime.id) throw new Error('이 확장에서 시작한 다운로드가 아닙니다.');
  return item;
}
async function bridge(message) {
  if (message.type === 'snapshot') { await chrome.storage.session.set({ native: message.state }); return { ok: true }; }
  if (message.type === 'save') {
    if (!message.url?.startsWith('blob:' + chrome.runtime.getURL(''))) throw new Error('잘못된 파일 주소입니다.');
    const filename = String(message.filename || '');
    if (!filename || filename.startsWith('/') || filename.includes('\\') || filename.split('/').some(p => !p || p === '.' || p === '..') || /[:\x00-\x1f]/.test(filename)) throw new Error('잘못된 저장 경로입니다.');
    const key = `save:${message.url}`;
    await chrome.storage.session.set({ [key]: filename });
    try { return { id: await chrome.downloads.download({ url: message.url, filename, conflictAction: 'uniquify', saveAs: false }) }; }
    catch (error) { await chrome.storage.session.remove(key); throw error; }
  }
  if (message.type === 'download-status') {
    const item = await ownedDownload(message.id);
    if (item.state !== 'in_progress' && item.url) await chrome.storage.session.remove(`save:${item.url}`);
    return { state: item.state, filename: item.filename, bytes: item.bytesReceived, total: item.totalBytes, error: item.error, danger: item.danger, paused: item.paused };
  }
  if (message.type === 'download-cancel') { await ownedDownload(message.id); await chrome.downloads.cancel(message.id); return { ok: true }; }
  throw new Error('지원하지 않는 파일 작업입니다.');
}
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || message.target === 'engine') return;
  let action;
  if (isPage(sender.url, engineURL)) action = bridge(message);
  else if (message.type === 'metadata' && sender.tab && sender.frameId === 0 && /^https:\/\/(?:www\.)?berriz\.in\//.test(sender.url || '')) {
    action = (async () => {
      const incoming = message.metadata || {};
      const page = new URL(sender.url);
      if (incoming.pageUrl !== page.origin + page.pathname || !/\/live\/replay\//.test(page.pathname)) throw new Error('현재 다시보기의 정보가 아닙니다.');
      const metadata = { extractorVersion: Number(incoming.extractorVersion) || 0, pageUrl: incoming.pageUrl, title: String(incoming.title || '').slice(0, 180), date: String(incoming.date || '').slice(0, 10), artist: String(incoming.artist || '').slice(0, 100) };
      await chrome.storage.session.set({ [`meta:${sender.tab.id}`]: metadata }); return { ok: true };
    })();
  }
  else if (message.type === 'resources' && sender.tab && !isPage(sender.url, managerURL)) {
    action = Promise.all((Array.isArray(message.urls) ? message.urls : []).filter(allowed).slice(0, 40).map(url => queueRecord(sender.tab.id, url))).then(() => ({ ok: true }));
  } else if (isPage(sender.url, managerURL)) {
    action = (async () => {
      if (message.type === 'connect') return ensureEngine();
      if (message.type !== 'command') throw new Error('알 수 없는 요청입니다.');
      if (message.value?.command === 'reveal') { chrome.downloads.showDefaultFolder(); return { ok: true }; }
      await ensureEngine();
      return chrome.runtime.sendMessage({ target: 'engine', type: 'command', value: message.value });
    })();
  } else return;
  action.then(reply, error => reply({ error: error.message })); return true;
});
chrome.tabs.onRemoved.addListener(tabId => chrome.storage.session.remove([`tab:${tabId}`, `meta:${tabId}`]));
chrome.tabs.onUpdated.addListener((tabId, change) => {
  if (change.status === 'loading' && change.url) captureQueue = captureQueue.then(async () => {
    await chrome.storage.session.remove(`tab:${tabId}`); await chrome.action.setBadgeText({ tabId, text: '' });
    await chrome.storage.session.remove(`meta:${tabId}`);
  }).catch(console.error);
});
