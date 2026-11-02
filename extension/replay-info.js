(() => {
  'use strict';
  const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
  function dateOnly(value) {
    let input = clean(value);
    if (/^20\d{2}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(input) && Number.isFinite(Date.parse(input))) {
      const parts = Object.fromEntries(new Intl.DateTimeFormat('en', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(input)).map(p => [p.type, p.value]));
      input = `${parts.year}-${parts.month}-${parts.day}`;
    }
    const match = input.match(/\b(20\d{2})\s*[.\/년-]\s*(\d{1,2})\s*[.\/월-]\s*(\d{1,2})(?!\d)/);
    if (!match) return '';
    const [, y, m, d] = match; const date = new Date(Date.UTC(+y, +m - 1, +d));
    if (date.getUTCFullYear() !== +y || date.getUTCMonth() !== +m - 1 || date.getUTCDate() !== +d) return '';
    return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`;
  }
  function titleOnly(value) {
    const text = clean(value).replace(/\s*[|–—-]\s*(?:Berriz|베리즈).*$/i, '').trim();
    return /^(?:Like Berries|Berriz|베리즈|로그인|로그인이 필요합니다|LIVE|REPLAY|다시보기|라이브)$/i.test(text) || /^Like Berries,? Berriz/i.test(text) ? '' : text;
  }
  function filename(info) {
    const date = dateOnly(info.date);
    const day = date ? date.slice(2).replace(/-/g, '') : '';
    const artist = clean(info.artist);
    const title = titleOnly(info.title);
    return clean([day, artist, title].filter(Boolean).join(' ')) || 'Berriz Replay';
  }
  function extract(doc, href) {
    const url = new URL(href);
    if (!/\/live\/replay\//.test(url.pathname)) return null;
    const scope = doc.querySelector('main, [role="main"]') || doc.body;
    if (!scope) return null;
    const meta = selector => doc.querySelector(selector)?.getAttribute('content') || '';
    const videos = [];
    const walk = value => {
      if (!value || typeof value !== 'object') return;
      if ([value['@type']].flat().includes('VideoObject')) videos.push(value);
      for (const child of Object.values(value)) if (typeof child === 'object') { if (Array.isArray(child)) child.forEach(walk); else walk(child); }
    };
    for (const script of doc.querySelectorAll('script[type="application/ld+json"]')) { try { walk(JSON.parse(script.textContent)); } catch {} }
    const video = videos.find(v => String(v.url || v.mainEntityOfPage || '').includes(url.pathname)) || videos[0];
    const headings = [...scope.querySelectorAll('h1,h2,h3')].filter(h => !h.closest('header,nav,[role="navigation"],[role="dialog"]'));
    const heading = headings.find(h => titleOnly(h.textContent));
    const title = titleOnly(video?.name) || titleOnly(heading?.textContent) || titleOnly(meta('meta[property="og:title"]')) || titleOnly(doc.title);
    // Read metadata near the replay heading before considering the rest of the page.
    let detail = heading?.parentElement;
    for (let i = 0; detail && i < 4 && !dateOnly(detail.innerText || detail.textContent); i++) detail = detail.parentElement;
    const region = detail && detail !== doc.body ? detail : scope;
    const time = region.querySelector('time[datetime]');
    const broadcasts = [video?.publication].flat().filter(Boolean);
    const date = dateOnly(broadcasts.find(b => b.startDate)?.startDate) || dateOnly(video?.startDate) || dateOnly(time?.getAttribute('datetime')) || dateOnly(region.innerText || region.textContent) || dateOnly(meta('meta[property="video:release_date"]'));
    const person = [video?.author || video?.creator].flat().filter(Boolean).map(a => typeof a === 'string' ? a : a.name).filter(Boolean).join(' ');
    const authorNode = [...region.querySelectorAll('[rel="author"], [itemprop="author"], [data-testid*="author" i], [class*="nickname" i], [class*="artistName" i], [class*="artist-name" i], [class*="authorName" i], [class*="author-name" i]')].find(node => !node.closest('[class*="comment" i],[class*="chat" i],[role="log"]'));
    const author = clean(person || authorNode?.textContent || meta('meta[name="author"]')).slice(0, 80);
    const community = decodeURIComponent(url.pathname.split('/').filter(Boolean)[1] || '').replace(/[-_]+/g, ' ').toUpperCase();
    const artist = author && community && !author.toUpperCase().includes(community) ? `${community} ${author}` : author || community;
    return { pageUrl: url.origin + url.pathname, title: title.slice(0, 180), date, artist: artist.slice(0, 100) };
  }
  const api = { dateOnly, titleOnly, filename, extract };
  globalThis.BerrizReplayInfo = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
