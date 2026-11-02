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
    const counter = /^(?:댓글|채팅|실시간\s*채팅|조회수?|좋아요|comments?|live\s*chat|views?|likes?|コメント)\s*(?:[:：]?\s*[\d,.]+\s*(?:개|명)?|[([]\s*[\d,.]+\s*[)\]])?$/i;
    return counter.test(text) || /^(?:Like Berries|Berriz|베리즈|로그인|로그인이 필요합니다|LIVE|REPLAY|다시보기|라이브)$/i.test(text) || /^Like Berries,? Berriz/i.test(text) ? '' : text;
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
    const video = videos.find(v => String(v.url || v.mainEntityOfPage || '').includes(url.pathname)) || videos.find(v => !v.url && !v.mainEntityOfPage);
    // Berriz MediaInfo.Title renders a <p>, not h1/h2/h3. The adjacent
    // MediaInfo.DateTime and ArtistProfile identify its own metadata block.
    // Source: fan-community-v1.9.25 modules 70251 / 59741 (2026-11-03).
    const excluded = 'header,nav,[role="navigation"],[role="dialog"],[role="log"],[class*="comment" i],[class*="chat" i]';
    const dateSelector = '.h-19.f-body-xs-regular.text-GRAY400';
    const titleNode = [...scope.querySelectorAll('p.f-body-xxl-semibold.text-GRAY002.break-all')].find(node => !node.closest(excluded) && node.parentElement?.querySelector(dateSelector));
    const region = titleNode?.parentElement;
    const title = titleOnly(titleNode?.textContent) || titleOnly(video?.name) || titleOnly(meta('meta[property="og:title"]')) || titleOnly(doc.title);
    const dateNode = region?.querySelector(dateSelector);
    // Adjacent date/time spans have no separator in textContent. Read each
    // date element separately before the combined row (e.g. 2026.11.0222:30).
    const displayedDate = [...(dateNode?.querySelectorAll?.('time,span') || []), dateNode].map(node => dateOnly(node?.textContent)).find(Boolean) || '';
    const broadcasts = [video?.publication].flat().filter(Boolean);
    const date = displayedDate || dateOnly(broadcasts.find(b => b.startDate)?.startDate) || dateOnly(video?.startDate) || dateOnly(meta('meta[property="video:release_date"]'));
    const person = [video?.author || video?.creator].flat().filter(Boolean).map(a => typeof a === 'string' ? a : a.name).filter(Boolean).join(' ');
    const authorNode = region?.querySelector('span.f-body-s-medium.text-GRAY002.line-clamp-1.break-all');
    const author = clean(authorNode?.textContent || person).slice(0, 80);
    const community = decodeURIComponent(url.pathname.split('/').filter(Boolean)[1] || '').replace(/[-_]+/g, ' ').toUpperCase();
    const artist = author && community && !author.toUpperCase().includes(community) ? `${community} ${author}` : author || community;
    return { extractorVersion: 2, pageUrl: url.origin + url.pathname, title: title.slice(0, 180), date, artist: artist.slice(0, 100) };
  }
  const api = { dateOnly, titleOnly, filename, extract };
  globalThis.BerrizReplayInfo = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
