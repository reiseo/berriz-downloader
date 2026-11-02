// Recover requests already observed by this page, including SPA player changes.
function report(urls) {
  const matches = urls.filter(url => {
    try { const u = new URL(url); return u.hostname === 'statics.berriz.in' && /\.(m3u8|vtt|srt)$/i.test(u.pathname) && !/\/\d+\.vtt$/i.test(u.pathname); }
    catch { return false; }
  });
  if (matches.length) chrome.runtime.sendMessage({ type: 'resources', urls: matches }).catch(() => {});
}
report(performance.getEntriesByType('resource').map(entry => entry.name));
new PerformanceObserver(list => report(list.getEntries().map(entry => entry.name)))
  .observe({ type: 'resource', buffered: true });

// Metadata comes from the already logged-in page DOM, without reading cookies.
let metadataTimer, previousMetadata = '';
function reportMetadata() {
  const metadata = BerrizReplayInfo.extract(document, location.href);
  if (!metadata) return;
  const signature = JSON.stringify(metadata);
  if (signature === previousMetadata) return;
  previousMetadata = signature;
  chrome.runtime.sendMessage({ type: 'metadata', metadata }).catch(() => {});
}
if (window === window.top) {
  new MutationObserver(() => {
    if (!metadataTimer) metadataTimer = setTimeout(() => { metadataTimer = null; reportMetadata(); }, 700);
  }).observe(document, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['content', 'datetime'] });
  reportMetadata();
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id === chrome.runtime.id && message.type === 'read-replay-metadata') reply(BerrizReplayInfo.extract(document, location.href));
  });
}
