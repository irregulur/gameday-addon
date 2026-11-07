'use strict';
// DaddyLive (thedaddy.li): HTML schedule + 24/7 channel list, resolved through the
// /cast/ player folder -> tossequip.net embed whose `_econfig` blob decodes to a direct m3u8.
// Ported from live-sport-plugin src/providers/DaddyLiveProvider.js.
// Other folders were checked live (2026-11): /player/ -> wideiptv (404) / ksohls (dead),
// /stream/ -> dembed.st (token-gated), /plus/ & /casting/ -> heavily obfuscated JS.

const { UA, fetchText, TtlCache, mapLimit } = require('../util');

const BASES = ['https://thedaddy.li']; // other old mirrors (dlhd.sx, daddylive.dad...) are dead
const cache = new TtlCache(20);
const decoded = new TtlCache(500);

const decodeEntities = (s) => String(s || '')
  .replace(/&#0*39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>');
// Strip emojis / flag glyphs ("Utah Utes 🇺🇸").
const clean = (s) => decodeEntities(s)
  .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}\u{200D}]/gu, '')
  .replace(/\s+/g, ' ').trim();

async function fetchSite(path, timeout = 12000) {
  let last;
  for (const base of BASES) {
    try {
      return { base, html: await fetchText(base + path, { timeout, headers: { Referer: `${base}/` } }) };
    } catch (e) { last = e; }
  }
  throw last;
}

// "Saturday 07th Nov 2026 - Schedule Time UK GMT" + "17:00" -> UTC ms.
// Times before 06:00 belong to the following night (e.g. UFC main card 01:00).
function parseStart(dayTitle, time) {
  const d = /(\d{1,2})\s*[a-z]{0,3}\s+([A-Za-z]{3})[a-z]*\s+(\d{4})/i.exec(dayTitle);
  if (!d || !/^\d{2}:\d{2}$/.test(time)) return 0;
  const t = Date.parse(`${d[1]} ${d[2]} ${d[3]} ${time}:00 UTC`);
  if (!t) return 0;
  return time < '06:00' ? t + 86400000 : t;
}

function classify(cat, title) {
  const s = `${cat} ${title}`;
  if (/college football|ncaaf/i.test(s)) return 'cfb';
  if (/\bufc\b/i.test(s)) return 'ufc';
  return '';
}

async function events() {
  return cache.get('events', 3 * 60_000, async () => {
    const { html } = await fetchSite('/');
    const out = [];
    // Split by day, then by category, then by event (plain regex; markup is regular).
    for (const day of html.split('class="schedule__day"').slice(1)) {
      const dayTitle = (/schedule__dayTitle">([^<]+)/.exec(day) || [])[1] || '';
      for (const catBlock of day.split('class="schedule__category').slice(1)) {
        const cat = clean((/card__meta">([^<]+)/.exec(catBlock) || [])[1]);
        for (const evBlock of catBlock.split('class="schedule__event"').slice(1)) {
          const time = (/schedule__time"[^>]*>([^<]+)/.exec(evBlock) || [])[1] || '';
          const raw = clean((/schedule__eventTitle">([^<]+)/.exec(evBlock) || [])[1]);
          const sport = classify(cat, raw);
          if (!raw || !sport) continue;
          const chans = [...evBlock.matchAll(/href="\/?watch\.php\?id=(\d+)"[^>]*>([^<]*)</g)]
            .filter((m) => m[1] !== '00')
            .map((m) => ({ id: m[1], name: clean(m[2]) || `Channel ${m[1]}` }));
          if (!chans.length) continue;
          // US feeds first (ESPN/ABC/FOX "... USA"), then the rest.
          chans.sort((a, b) => /usa|\bus\b/i.test(b.name) - /usa|\bus\b/i.test(a.name));
          // "NCAAF : BYU Cougars vs Utah Utes" -> teams; keep the full title for UFC numbering.
          const body = raw.includes(' : ') ? raw.slice(raw.indexOf(' : ') + 3) : raw;
          const parts = body.split(/\s+(?:vs\.?|v|@)\s+/i);
          const start = parseStart(dayTitle, time.trim());
          out.push({
            key: `${sport}-${start}-${body.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)}`,
            title: sport === 'cfb' ? body : raw,
            home: parts.length === 2 ? parts[1] : '',
            away: parts.length === 2 ? parts[0] : '',
            sport,
            start,
            channels: chans,
          });
        }
      }
    }
    return out;
  });
}

// 24/7 US networks relevant to CFB/UFC.
const US_NET = /^(ESPN2? USA|ESPNU USA|ESPNews|ABC (NY )?USA|CBS(NY)? USA|CBS Sports Network|FOX(NY)? USA|Fox Sports [12] USA|NBC(NY)? USA|SEC Network|ACC Network|BIG TEN Network|Pac-12 Network|TNT USA|TBS USA|TruTV USA|USA Network)/i;

async function channels() {
  return cache.get('channels', 30 * 60_000, async () => {
    const { html } = await fetchSite('/24-7-channels.php');
    const seen = new Set();
    const out = [];
    for (const m of html.matchAll(/href=["']\/?watch\.php\?id=(\d+)["'][\s\S]*?<div class="card__title">([^<]+)<\/div>/gi)) {
      const name = clean(m[2]);
      if (seen.has(m[1]) || !US_NET.test(name)) continue;
      seen.add(m[1]);
      out.push({ key: m[1], name, country: 'us' });
    }
    return out;
  });
}

// _econfig: base64 -> 4 equal chunks, each with a decoy char at index 3, base64 each,
// reorder into slots [2,0,3,1], join, base64 -> JSON {stream_url, stream_url_nop2p, ...}.
function decodeEconfig(raw) {
  try {
    const order = [2, 0, 3, 1];
    const d = Buffer.from(raw, 'base64').toString('utf8');
    const len = Math.ceil(d.length / 4);
    const parts = [];
    for (let i = 0; i < 4; i++) {
      const s = d.substr(i * len, len);
      parts[order[i]] = Buffer.from(s.slice(0, 3) + s.slice(4), 'base64').toString('utf8');
    }
    return JSON.parse(Buffer.from(parts.join(''), 'base64').toString('utf8'));
  } catch { return null; }
}

// channel id -> { url, headers }. Segments 403 without the embed Referer; the playlist does not
// care, so client-side headers (proxyHeaders) are enough, no relay needed.
async function decodeChannel(id) {
  return decoded.get(id, 10 * 60_000, async () => {
    const { base, html } = await fetchSite(`/cast/stream-${id}.php`, 8000);
    const iframe = (/<iframe[^>]+src=["']?(https?:\/\/[^"'\s>]+)/i.exec(html) || [])[1];
    if (!iframe) throw new Error('daddylive: no iframe');
    const page = await fetchText(iframe, { timeout: 8000, headers: { Referer: `${base}/` } });
    const raw = (/_econfig\s*=\s*['"]([^'"]+)['"]/.exec(page) || [])[1];
    const conf = raw && decodeEconfig(raw);
    let url = conf && (conf.stream_url_nop2p || conf.stream_url);
    if (!url) url = (/(https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*)/i.exec(page) || [])[1];
    if (!url) throw new Error('daddylive: no m3u8');
    const origin = new URL(iframe).origin;
    const headers = { Referer: `${origin}/`, Origin: origin, 'User-Agent': UA };
    // Offline channels still decode but their playlist 404s; drop them (cheap, ~200ms).
    const pl = await fetchText(url, { timeout: 4000, headers });
    if (!pl.startsWith('#EXTM3U')) throw new Error('daddylive: offline');
    return { url, headers };
  });
}

async function resolve(ref) {
  const targets = ref.type === 'channel'
    ? [{ id: ref.key, name: ref.name || `Channel ${ref.key}` }]
    : ((await events()).find((e) => e.key === ref.key) || { channels: [] }).channels.slice(0, 4);
  const res = await mapLimit(targets, 4, async (t) => {
    const s = await decodeChannel(t.id);
    return { url: s.url, title: t.name, headers: s.headers, quality: 'HD' };
  });
  return res.filter(Boolean);
}

module.exports = { id: 'daddylive', name: 'DaddyLive', events, channels, resolve };
