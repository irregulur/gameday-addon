'use strict';
// TimStreams: JSON schedule (tim-streams.com/api/live-upcoming) -> embed page with an
// XOR-obfuscated script -> "ticket" URL whose body XOR-decodes to a signed m3u8.
// Ported from live-sport-plugin src/providers/TimStreamsProvider.js.
// Note: segments are MPEG-TS prefixed by a 42-byte WebP header (served as image/webp
// from tiktokcdn); ffmpeg/ExoPlayer resync on 0x47 and play them fine.

const { UA, fetchJson, fetchText, TtlCache } = require('../util');

const API = 'https://tim-streams.com/api/live-upcoming';
const GENRE_FIGHTING = 3;
const GENRE_AMFOOTBALL = 8; // sub_genre 2 = NCAA Football
const cache = new TtlCache(50);
const resolved = new TtlCache(300);

const unescape = (s) => String(s || '')
  .replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"');

// API times ("2026-11-07T12:00") are US Eastern wall-clock.
function parseEt(s) {
  const m = /^(\d{4})-(\d\d)-(\d\d)T(\d\d):(\d\d)/.exec(s || '');
  if (!m) return 0;
  const asUtc = Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5]);
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hourCycle: 'h23',
    year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric',
  }).formatToParts(asUtc).map((p) => [p.type, p.value]));
  const etOfUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute);
  return asUtc + (asUtc - etOfUtc); // shift by the ET offset at that instant
}

async function events() {
  return cache.get('events', 3 * 60_000, async () => {
    const data = await fetchJson(API, { timeout: 15000 });
    const out = [];
    for (const e of data.events || []) {
      const title = unescape(e.name);
      let sport;
      if (e.genre === GENRE_AMFOOTBALL && e.sub_genre === 2) sport = 'cfb';
      else if (e.genre === GENRE_FIGHTING && /\bufc\b/i.test(title)) sport = 'ufc';
      else continue;
      const streams = (e.streams || []).filter((s) => !s.vip && /^https?:\/\//.test(s.url || ''));
      if (!streams.length) continue;
      // CFB titles are "Away Team Mascot @ Home Team Mascot".
      const [away, home] = sport === 'cfb' && title.includes(' @ ') ? title.split(' @ ') : ['', ''];
      out.push({
        key: e.url, title, home, away, sport, start: parseEt(e.time),
        streams: streams.map((s) => ({ name: s.name, url: s.url })),
      });
    }
    return out;
  });
}

// Embed page hides its player script as: _a=[..bytes..],_x=N,_s=M; fromCharCode(((_a[i]^_x)-_s+256)%256)
function decodeEmbed(html) {
  const loop = /String\.fromCharCode\(\s*\(+\s*(\w+)\[\w+\]\s*\^\s*(\w+)\s*\)\s*-\s*(\w+)\s*\+\s*256\s*\)\s*(?:%\s*256|&\s*255)\s*\)/.exec(html);
  if (!loop) return '';
  const esc = (v) => v.replace(/\$/g, '\\$');
  const arr = new RegExp(`${esc(loop[1])}\\s*=\\s*\\[([\\d,\\s]+)\\]`).exec(html);
  const x = new RegExp(`${esc(loop[2])}\\s*=\\s*(\\d+)`).exec(html);
  const s = new RegExp(`${esc(loop[3])}\\s*=\\s*(\\d+)`).exec(html);
  if (!arr || !x || !s) return '';
  return arr[1].split(',').map((c) => String.fromCharCode(((+c ^ +x[1]) - +s[1] + 256) % 256)).join('');
}

async function embedToM3u8(embedUrl) {
  return resolved.get(embedUrl, 10 * 60_000, async () => {
    const html = await fetchText(embedUrl, { timeout: 8000, headers: { Referer: 'https://tim-streams.com/' } });
    const js = decodeEmbed(html);
    const direct = /https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*/.exec(js);
    if (direct) return direct[0];
    const ticket = /loadStreamUrl\s*\(\s*["']([^"']+)["']/.exec(js);
    if (!ticket) throw new Error('timstreams: no ticket');
    // Ticket body: byte0 = seed; out[i] = b[i] ^ token[(i-1)%len] ^ ((seed+i-1)&255), token = last path segment.
    const res = await fetch(ticket[1], {
      headers: { 'User-Agent': UA, Referer: embedUrl },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) throw new Error(`timstreams ticket HTTP ${res.status}`);
    const b = Buffer.from(await res.arrayBuffer());
    const tk = ticket[1].slice(ticket[1].lastIndexOf('/') + 1);
    let out = '';
    for (let i = 1; i < b.length; i++) out += String.fromCharCode(b[i] ^ tk.charCodeAt((i - 1) % tk.length) ^ ((b[0] + i - 1) & 255));
    const m = /https?:\/\/[^"'<>\s]+\.m3u8[^"'<>\s]*/.exec(out);
    if (!m) throw new Error('timstreams: ticket decode failed');
    return m[0];
  });
}

async function resolve(ref) {
  const ev = (await events()).find((e) => e.key === ref.key);
  if (!ev) return [];
  const out = [];
  await Promise.all(ev.streams.slice(0, 4).map(async (s) => {
    try {
      const url = await embedToM3u8(s.url);
      // Playlist 404s without a browser User-Agent; no Referer/IP binding observed.
      out.push({ url, title: `TimStreams ${s.name || ''}`.trim(), headers: { 'User-Agent': UA }, quality: 'HD' });
    } catch { /* dead embed */ }
  }));
  return out;
}

module.exports = { id: 'timstreams', name: 'TimStreams', events, resolve };
