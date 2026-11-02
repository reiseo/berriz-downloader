/* Browser-only HLS/TS engine. No native executable, WASM, or third-party runtime. */
(() => {
  'use strict';
  const TS = 188;
  const decoder = new TextDecoder();
  function checkURL(value, extensions = /\.(m3u8|ts|vtt|srt)$/i) {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.hostname !== 'statics.berriz.in' || url.username || url.password || (url.port && url.port !== '443') || !extensions.test(url.pathname)) throw new Error('Berriz CDN의 지원되는 미디어 주소만 사용할 수 있습니다.');
    return url.href;
  }
  function abort(signal) { if (signal?.aborted) throw new DOMException('취소되었습니다.', 'AbortError'); }
  async function bytes(url, signal, limit = 64 * 1024 * 1024, onBytes = () => {}) {
    checkURL(url);
    for (let attempt = 0; attempt < 3; attempt++) {
      abort(signal);
      const controller = new AbortController();
      const cancel = () => controller.abort();
      signal?.addEventListener('abort', cancel, { once: true });
      const timer = setTimeout(cancel, 30000);
      try {
        const response = await fetch(url, { signal: controller.signal, credentials: 'omit' });
        checkURL(response.url);
        if (!response.ok) throw new Error(`미디어 요청 실패: HTTP ${response.status}`);
        if (Number(response.headers.get('content-length')) > limit) throw new Error('미디어 조각이 지원 크기를 초과했습니다.');
        const reader = response.body.getReader();
        const chunks = []; let size = 0;
        try {
          for (;;) {
            const item = await reader.read(); if (item.done) break;
            size += item.value.length;
            onBytes(item.value.length);
            if (size > limit) throw new Error('미디어 조각이 지원 크기를 초과했습니다.');
            chunks.push(item.value);
          }
        } finally { await reader.cancel().catch(() => {}); }
        const output = new Uint8Array(size); let offset = 0;
        for (const chunk of chunks) { output.set(chunk, offset); offset += chunk.length; }
        return output;
      } catch (error) {
        abort(signal);
        if (attempt === 2) throw error;
      } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
    }
  }
  async function text(url, signal, onBytes) { return decoder.decode(await bytes(url, signal, 4 * 1024 * 1024, onBytes)); }
  function attrs(line) {
    return Object.fromEntries([...line.matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)].map(m => [m[1], m[2].replace(/^"|"$/g, '')]));
  }
  function playlist(body, url) {
    if (!body.trimStart().startsWith('#EXTM3U')) throw new Error('HLS 플레이리스트가 아닙니다.');
    const lines = body.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.some(line => /^#EXT-X-KEY:/.test(line) && attrs(line).METHOD !== 'NONE')) throw new Error('암호화된 스트림은 이 브라우저 병합 엔진에서 지원하지 않습니다.');
    if (lines.some(line => /^#EXT-X-(MAP|BYTERANGE|DISCONTINUITY)(:|$)/.test(line))) throw new Error('fMP4·바이트 범위·시간 단절 스트림은 지원하지 않습니다.');
    const children = []; const segments = []; let duration = 0; let next = null;
    for (const line of lines) {
      if (line.startsWith('#EXT-X-MEDIA:')) {
        const a = attrs(line);
        if (a.URI && ['AUDIO', 'SUBTITLES'].includes(a.TYPE)) children.push({ url: new URL(a.URI, url).href, kind: a.TYPE === 'SUBTITLES' ? 'subtitle' : 'audio', language: a.LANGUAGE || '', name: a.NAME || '' });
      } else if (line.startsWith('#EXT-X-STREAM-INF:')) next = attrs(line);
      else if (line.startsWith('#EXTINF:')) duration += Number(line.slice(8).split(',')[0]);
      else if (!line.startsWith('#')) {
        if (next) { children.push({ url: new URL(line, url).href, resolution: next.RESOLUTION, bandwidth: Number(next.BANDWIDTH || 0) }); next = null; }
        else segments.push(new URL(line, url).href);
      }
    }
    return { url, children, segments, duration, live: !lines.includes('#EXT-X-ENDLIST') };
  }
  async function loadPlaylist(url, signal) { return playlist(await text(url, signal), url); }
  function payload(packet) {
    const control = (packet[3] >> 4) & 3;
    if (!control) throw new Error('잘못된 TS 패킷입니다.');
    if (!(control & 1)) return null;
    const offset = 4 + ((control & 2) ? packet[4] + 1 : 0);
    if (offset > TS) throw new Error('잘못된 TS adaptation field입니다.');
    return packet.subarray(offset);
  }
  function* packets(data) {
    if (data.length % TS) throw new Error('188바이트 MPEG-TS 조각만 지원합니다.');
    for (let i = 0; i < data.length; i += TS) {
      const p = data.subarray(i, i + TS);
      if (p[0] !== 0x47 || (p[1] & 0x80) || (p[3] & 0xc0)) throw new Error('손상되거나 암호화된 TS 패킷입니다.');
      yield p;
    }
  }
  const pid = p => ((p[1] & 31) << 8) | p[2];
  function section(p) {
    const b = payload(p);
    if (!b || !(p[1] & 0x40)) return null;
    const s = b.subarray(1 + b[0]);
    if (s.length < 3 || 3 + ((s[1] & 15) << 8 | s[2]) > s.length) throw new Error('여러 패킷에 걸친 PSI 테이블은 지원하지 않습니다.');
    return s.subarray(0, 3 + ((s[1] & 15) << 8 | s[2]));
  }
  function streams(data) {
    let pmtPID = null;
    for (const p of packets(data)) {
      if (pid(p) === 0) {
        const s = section(p); if (!s || s[0] !== 0) continue;
        for (let i = 8; i < s.length - 4; i += 4) if (s[i] || s[i + 1]) { pmtPID = ((s[i + 2] & 31) << 8) | s[i + 3]; break; }
      } else if (pid(p) === pmtPID) {
        const s = section(p); if (!s || s[0] !== 2) continue;
        const list = [];
        for (let i = 12 + (((s[10] & 15) << 8) | s[11]); i < s.length - 4;) {
          list.push({ type: s[i], pid: ((s[i + 1] & 31) << 8) | s[i + 2] });
          i += 5 + (((s[i + 3] & 15) << 8) | s[i + 4]);
        }
        return { streams: list, pcrPID: ((s[8] & 31) << 8) | s[9] };
      }
    }
    throw new Error('TS에서 프로그램 정보를 찾지 못했습니다.');
  }
  function stamp(b, i) {
    if (i + 4 >= b.length) throw new Error('잘못된 PES 시간 정보입니다.');
    return (b[i] & 14) * 536870912 + b[i + 1] * 4194304 + (b[i + 2] & 254) * 16384 + b[i + 3] * 128 + (b[i + 4] >> 1);
  }
  function pesTime(p) {
    const b = payload(p);
    if (!b || b[0] || b[1] || b[2] !== 1 || !(b[7] & 0x80)) throw new Error('시간 정보가 없는 PES는 병합할 수 없습니다.');
    return { pts: stamp(b, 9), dts: stamp(b, (b[7] & 0x40) ? 14 : 9) };
  }
  // SPS parsing supplies dimensions when only a media playlist was captured.
  function dimensions(data, videoPID) {
    for (const packet of packets(data)) {
      if (pid(packet) !== videoPID) continue;
      const b = payload(packet); if (!b) continue;
      for (let i = 0; i + 5 < b.length; i++) if (b[i] === 0 && b[i + 1] === 0 && b[i + 2] === 1 && (b[i + 3] & 31) === 7) {
        try {
          const raw = [...b.subarray(i + 4)].filter((v, j, a) => !(v === 3 && j > 1 && a[j - 1] === 0 && a[j - 2] === 0));
          let bit = 0;
          const read = n => { let v = 0; while (n--) { if (bit >= raw.length * 8) throw Error(); v = v * 2 + ((raw[bit >> 3] >> (7 - (bit++ & 7))) & 1); } return v; };
          const ue = () => { let n = 0; while (!read(1)) { if (++n > 30) throw Error(); } return 2 ** n - 1 + read(n); };
          const se = () => { const n = ue(); return (n & 1) ? (n + 1) / 2 : -n / 2; };
          const profile = read(8); read(16); ue(); let chroma = 1; let separate = 0;
          if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
            chroma = ue(); if (chroma === 3) separate = read(1); ue(); ue(); read(1);
            if (read(1)) for (let k = 0; k < (chroma === 3 ? 12 : 8); k++) if (read(1)) {
              let last = 8, next = 8;
              for (let j = 0; j < (k < 6 ? 16 : 64); j++) { if (next) next = (last + se() + 256) % 256; last = next || last; }
            }
          }
          ue(); const order = ue();
          if (order === 0) ue(); else if (order === 1) { read(1); se(); se(); const count = ue(); for (let j = 0; j < count; j++) se(); }
          ue(); read(1); const width = (ue() + 1) * 16, heightMap = (ue() + 1) * 16;
          const frame = read(1); if (!frame) read(1); read(1);
          const crop = read(1) ? [ue(), ue(), ue(), ue()] : [0, 0, 0, 0];
          const c = separate ? 0 : chroma;
          return { width: width - (crop[0] + crop[1]) * (c === 1 || c === 2 ? 2 : 1), height: heightMap * (2 - frame) - (crop[2] + crop[3]) * (c === 1 ? 2 : 1) * (2 - frame) };
        } catch { /* Try another repeated SPS. */ }
      }
    }
    return null;
  }
  async function inspect(urls, signal) {
    if (!Array.isArray(urls) || !urls.length || urls.length > 40) throw new Error('주소를 1~40개 입력해 주세요.');
    const seen = new Set(), tracks = [], subtitles = [], warnings = [];
    const languages = { ko: '한국어', en: 'English', ja: '日本語', 'zh-Hans': '简体中文', 'zh-Hant': '繁體中文' };
    async function visit(item, depth = 0) {
      checkURL(item.url); if (seen.has(item.url)) return;
      if (depth > 4 || seen.size >= 50) throw new Error('플레이리스트 구조가 너무 복잡합니다.');
      seen.add(item.url);
      const direct = /\.(vtt|srt)$/i.test(new URL(item.url).pathname);
      const list = direct ? { segments: [item.url], duration: 0, live: false, children: [] } : await loadPlaylist(item.url, signal);
      if (list.children.length) { for (const child of list.children) await visit(child, depth + 1); return; }
      if (!list.segments.length) throw new Error('미디어 조각이 없습니다.');
      if (item.kind === 'subtitle' || /\.(vtt|srt)$/i.test(new URL(list.segments[0]).pathname)) {
        const language = item.language || new URL(item.url).pathname.split('/').at(-2).replace(/-\d+$/, '');
        const name = item.name || language;
        subtitles.push({ ...item, language, name, label: (languages[language] || language) + (/auto/i.test(name) ? ' · 자동 자막' : ''), format: /\.srt$/i.test(item.url) ? 'SRT' : 'VTT' }); return;
      }
      const data = await bytes(list.segments[0], signal);
      const info = streams(data); const v = info.streams.find(s => s.type === 0x1b); const a = info.streams.find(s => s.type === 0x0f);
      if (!v && !a) throw new Error('H.264 / AAC MPEG-TS만 지원합니다.');
      const size = v ? dimensions(data, v.pid) : null;
      const resolution = item.resolution?.split('x').map(Number);
      const video = v ? { codec_name: 'h264', width: size?.width || resolution?.[0] || 0, height: size?.height || resolution?.[1] || 0 } : null;
      const audio = a ? { codec_name: 'aac' } : null;
      tracks.push({ ...item, video, audio, duration: list.duration, live: list.live,
        label: video ? `${Math.min(video.width, video.height) || '?'}p · ${video.width} × ${video.height} · H264${audio ? ' · 오디오 포함' : ''}` : 'AAC · 오디오' });
    }
    for (const url of new Set(urls)) { try { await visit({ url }); } catch (error) { abort(signal); warnings.push({ url, message: error.message }); } }
    tracks.sort((a, b) => (b.video?.width || 0) * (b.video?.height || 0) - (a.video?.width || 0) * (a.video?.height || 0) || (b.bandwidth || 0) - (a.bandwidth || 0));
    return { tracks, subtitles, warnings };
  }
  function crc32(data) {
    let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte << 24; for (let i = 0; i < 8; i++) crc = (crc << 1) ^ ((crc & 0x80000000) ? 0x04c11db7 : 0); }
    return crc >>> 0;
  }
  function tablePacket(id, sectionBytes) {
    const p = new Uint8Array(TS).fill(255); p.set([0x47, 0x40 | (id >> 8), id & 255, 0x10, 0]);
    p.set(sectionBytes, 5); const crc = crc32(sectionBytes);
    new DataView(p.buffer).setUint32(5 + sectionBytes.length, crc);
    return p;
  }
  function tables() {
    return [tablePacket(0, [0, 0xb0, 13, 0, 1, 0xc1, 0, 0, 0, 1, 0xf0, 0]),
      tablePacket(4096, [2, 0xb0, 23, 0, 1, 0xc1, 0, 0, 0xe1, 0, 0xf0, 0, 0x1b, 0xe1, 0, 0xf0, 0, 0x0f, 0xe1, 1, 0xf0, 0])];
  }
  async function* segmentData(urls, signal, get = bytes) {
    const controller = new AbortController();
    const cancel = () => controller.abort();
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    const pending = []; let index = 0;
    const fill = () => {
      while (pending.length < 2 && index < urls.length && !controller.signal.aborted) {
        const url = urls[index++];
        pending.push(Promise.resolve().then(() => get(url, controller.signal)).then(data => ({ data }), error => ({ error })));
      }
    };
    try {
      abort(controller.signal); fill();
      while (pending.length) {
        const item = await pending.shift(); abort(controller.signal);
        if (item.error) throw item.error;
        yield item.data;
        fill();
      }
    } finally {
      controller.abort(); signal?.removeEventListener('abort', cancel);
      await Promise.allSettled(pending);
    }
  }
  async function* groups(list, type, signal, get = bytes) {
    let group = null, lastTime = null, epoch = 0;
    for await (const data of segmentData(list.segments, signal, get)) {
      abort(signal); const info = streams(data);
      const source = info.streams.find(s => s.type === type);
      if (!source || (type === 0x1b && info.pcrPID !== source.pid)) throw new Error('지원하지 않는 TS 트랙 또는 PCR 구조입니다.');
      for (const p of packets(data)) {
        if (pid(p) !== source.pid) continue;
        if ((p[1] & 0x40) && payload(p)) {
          if (group) yield group;
          const t = pesTime(p);
          if (lastTime !== null && t.dts + epoch < lastTime - 2 ** 32) epoch += 2 ** 33;
          const time = t.dts + epoch;
          if (lastTime !== null && time < lastTime) throw new Error('트랙의 시간이 역행하여 안전하게 병합할 수 없습니다.');
          lastTime = time; group = { time, packets: [] };
        }
        if (!group) throw new Error('첫 미디어 조각이 PES 중간에서 시작합니다.');
        if (group.packets.length >= 178481) throw new Error('단일 PES가 32 MiB를 초과하여 이 스트림을 처리할 수 없습니다.');
        group.packets.push(p.slice());
      }
    }
    if (group) yield group;
  }
  async function mux(videoList, audioList, write, signal, progress = () => {}, get = bytes) {
    if (videoList.live || audioList.live) throw new Error('현재 버전은 종료된 다시보기만 지원합니다.');
    const vg = groups(videoList, 0x1b, signal, get), ag = groups(audioList, 0x0f, signal, get);
    try {
    let [v, a] = await Promise.all([vg.next(), ag.next()]);
    if (v.done || a.done) throw new Error('영상 또는 오디오가 비어 있습니다.');
    const start = Math.min(v.value.time, a.value.time); const counters = new Map();
    const psi = tables(); let buffer = new Uint8Array(TS * 11000), used = 0, total = 0, lastProgress = 0, lastTable = -Infinity;
    async function put(packet, targetPID) {
      const p = packet.slice(); p[1] = (p[1] & 0xe0) | (targetPID >> 8); p[2] = targetPID & 255;
      const next = counters.get(targetPID) || 0, hasPayload = p[3] & 0x10;
      p[3] = (p[3] & 0xf0) | (hasPayload ? next : (next + 15) & 15);
      if (hasPayload) counters.set(targetPID, (next + 1) & 15);
      buffer.set(p, used); used += TS;
      if (used === buffer.length) { await write(buffer); total += used; used = 0; buffer = new Uint8Array(buffer.length); }
    }
      while (!v.done || !a.done) {
        abort(signal);
        const video = a.done || (!v.done && v.value.time <= a.value.time), group = video ? v.value : a.value;
        if (group.time - lastTable >= 9000) { await put(psi[0], 0); await put(psi[1], 4096); lastTable = group.time; }
        for (const p of group.packets) await put(p, video ? 256 : 257);
        if (Date.now() - lastProgress > 400) { progress({ seconds: (group.time - start) / 90000, bytes: total + used }); lastProgress = Date.now(); }
        if (video) v = await vg.next(); else a = await ag.next();
      }
      if (used) { await write(buffer.subarray(0, used)); total += used; }
      progress({ seconds: videoList.duration, bytes: total }); return total;
    } finally { await Promise.allSettled([vg.return(), ag.return()]); }
  }
  const timestamp = value => value.replace(',', '.').split(':').reduce((a, b) => a * 60 + Number(b), 0);
  function parseCues(text, baseline = null) {
    text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    const map = /X-TIMESTAMP-MAP\s*=\s*LOCAL:([^,\n]+),\s*MPEGTS:(\d+)/.exec(text); let offset = 0;
    if (map) { const current = [timestamp(map[1]), Number(map[2])]; baseline ||= current; offset = (((current[1] - baseline[1] + 2 ** 32) % 2 ** 33 + 2 ** 33) % 2 ** 33 - 2 ** 32) / 90000 - (current[0] - baseline[0]); }
    const cues = [];
    for (const block of text.split(/\n\s*\n/)) {
      if (/^(NOTE|STYLE|REGION)(\s|$)/.test(block)) continue;
      const match = /^(\d+:\d{2}(?::\d{2})?[.,]\d{3})\s+-->\s+(\d+:\d{2}(?::\d{2})?[.,]\d{3})([^\n]*)\n([\s\S]*)/m.exec(block);
      if (match) cues.push({ start: Math.max(0, timestamp(match[1]) + offset), end: Math.max(0, timestamp(match[2]) + offset), settings: match[3].trim(), text: match[4].trim() });
    }
    return { cues: cues.filter(c => c.end > c.start), baseline };
  }
  function mergeCues(cues) {
    const result = [];
    for (const cue of cues.sort((a, b) => a.start - b.start || a.end - b.end)) {
      const last = result.at(-1);
      if (last && last.text === cue.text && last.settings === cue.settings && cue.start <= last.end + .002) last.end = Math.max(last.end, cue.end);
      else result.push({ ...cue });
    }
    return result;
  }
  function clock(value, separator) {
    let ms = Math.max(0, Math.round(value * 1000)); const h = Math.floor(ms / 3600000); ms %= 3600000;
    const m = Math.floor(ms / 60000); ms %= 60000; const s = Math.floor(ms / 1000); ms %= 1000;
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}${separator}${String(ms).padStart(3, '0')}`;
  }
  function renderCues(cues, format) {
    const plain = s => s.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]*>/g, '').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (m, k) => {
      const values = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
      if (k[0] !== '#') return values[k.toLowerCase()] || m;
      const n = /^#x/i.test(k) ? parseInt(k.slice(2), 16) : Number(k.slice(1)); return n <= 0x10ffff ? String.fromCodePoint(n) : m;
    });
    return (format === 'vtt' ? 'WEBVTT\n\n' : '') + cues.map((c, i) => `${format === 'srt' ? (i + 1) + '\n' : ''}${clock(c.start, format === 'srt' ? ',' : '.')} --> ${clock(c.end, format === 'srt' ? ',' : '.')}${format === 'vtt' && c.settings ? ' ' + c.settings : ''}\n${format === 'srt' ? plain(c.text) : c.text}`).join('\n\n') + '\n';
  }
  async function captions(track, signal, progress = () => {}, onBytes) {
    const list = /\.m3u8$/i.test(new URL(track.url).pathname) ? await loadPlaylist(track.url, signal) : { segments: [track.url], live: false };
    if (list.live || list.segments.length > 20000) throw new Error('완료된 다시보기 자막만 지원합니다.');
    const texts = new Array(list.segments.length); let index = 0, complete = 0;
    const results = await Promise.allSettled(Array.from({ length: Math.min(6, texts.length) }, async () => {
      while (index < texts.length) { const i = index++; texts[i] = await text(list.segments[i], signal, onBytes); progress(++complete, texts.length); }
    }));
    const failed = results.find(r => r.status === 'rejected'); if (failed) throw failed.reason;
    let baseline = null; const cues = [];
    for (const body of texts) { const parsed = parseCues(body, baseline); baseline = parsed.baseline; cues.push(...parsed.cues); }
    if (!cues.length) throw new Error('자막 문장이 없습니다.'); return mergeCues(cues);
  }
  function safeName(value) {
    let name = String(value || 'Berriz Replay').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\.ts$/i, '').replace(/^[ .]+|[ .]+$/g, '').slice(0, 120) || 'Berriz Replay';
    if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(\.|$)/i.test(name)) name = '_' + name;
    return name;
  }
  const api = { checkURL, bytes, text, playlist, loadPlaylist, streams, dimensions, packets, payload, pesTime, crc32, tables, inspect, mux, segmentData, parseCues, mergeCues, renderCues, captions, safeName };
  globalThis.BerrizMedia = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
