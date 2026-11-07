'use strict';
// Nuvio Live Sports (nuviosports.xyz): Stremio addon with /catalog/tv/... + /stream/tv/... JSON.
// CFB/UFC *event* rows only ever resolve to embed pages (DaddyLive / PPV.st "watch?url=" pages),
// so they are skipped. Its 24/7 "networks" catalog does hand out direct HLS playlists
// (cdnlivetv signed m3u8, scorezone worker, or its own /api/manifest.m3u8 relay), which is what
// we expose as channels() for network-locked college games.

const { fetchJson, TtlCache, UA } = require('../util');

const BASE = 'https://nuviosports.xyz';
const HEADERS = { Origin: BASE, Referer: `${BASE}/`, 'User-Agent': UA };

const cache = new TtlCache(120);

function catalog(id) {
  return cache.get(`cat:${id}`, 3 * 60_000, async () => {
    const j = await fetchJson(`${BASE}/catalog/tv/${id}.json`, { headers: HEADERS, timeout: 15000 });
    return Array.isArray(j.metas) ? j.metas : [];
  });
}

// "🔴 LIVE: Utah vs BYU | 🏆 League: NCAAF 📅 Category: COLLEGE ⏰ ..." -> "Utah vs BYU"
function cleanTitle(name) {
  return String(name || '')
    .replace(/^[^\p{L}\p{N}(]+/u, '') // status emoji (🔴 / ⏱️ / 📺)
    .replace(/^(LIVE|UPCOMING)\s*:\s*/i, '')
    .split('|')[0]
    .replace(/\s+/g, ' ')
    .trim();
}

function teamsFrom(title) {
  const parts = title.split(/\s+(?:vs|v|at|@)\s+/i);
  return parts.length === 2 ? { home: parts[0].trim(), away: parts[1].trim() } : {};
}

async function events() {
  const [college, mma, live] = await Promise.all([
    catalog('nuvio_sports_college').catch(() => []),
    catalog('nuvio_sports_mma').catch(() => []),
    catalog('nuvio_sports_live').catch(() => []),
  ]);
  const out = [];
  for (const m of college) {
    const title = cleanTitle(m.name);
    const league = String(m.description || m.name);
    // COLLEGE catalog also holds basketball etc. — keep football rows only.
    if (!/NCAAF|american[_ ]football|college football/i.test(league)) continue;
    if (/Basketball/i.test(league)) continue;
    if (!/\bvs\b|\bat\b|\bv\b/i.test(title)) continue;
    out.push({ key: m.id, title, ...teamsFrom(title), sport: 'cfb' });
  }
  // UFC rows live in the MMA catalog, and the live catalog adds prelims/other UFC cards.
  const seen = new Set();
  for (const m of [...mma, ...live]) {
    const title = cleanTitle(m.name);
    if (!/UFC/i.test(title) || seen.has(m.id)) continue; // MMA catalog also holds ONE / BKFC / boxing
    seen.add(m.id);
    out.push({ key: m.id, title, ...teamsFrom(title), sport: 'ufc' });
  }
  return out;
}

// Only direct playable links (m3u8 / media.ts). Embeds ("watch?url=", /donate) are dropped.
// ScoreZone links are short-lived signed tokens (401 within seconds), so only CDNLiveTV and the
// addon's own /api/manifest.m3u8 relay are worth returning.
const DIRECT = /(\.m3u8|\.ts)(\?|$)|cdnlivetv\.tv\/secure\/api\/|nuviosports\.xyz\/api\/manifest\.m3u8/i;

async function resolve(ref) {
  const j = await cache.get(`stream:${ref.key}`, 60_000, async () => {
    const r = await fetchJson(`${BASE}/stream/tv/${encodeURIComponent(ref.key)}.json`, { headers: HEADERS, timeout: 12000 });
    return Array.isArray(r.streams) ? r.streams : [];
  });
  return j
    .filter((s) => typeof s.url === 'string' && DIRECT.test(s.url) && !/\/donate|\/watch\?/.test(s.url))
    .slice(0, 6)
    .map((s) => ({
      url: s.url,
      title: `${String(s.title || s.name || '').split('\n')[0].replace(/^📡\s*/, '').trim()}`.slice(0, 90),
      headers: s.behaviorHints?.proxyHeaders?.request || undefined,
      quality: s.resolution && s.resolution !== 'null' ? s.resolution : undefined,
    }));
}

// 24/7 US sports networks from the networks catalog, named so match.js maps them onto ESPN broadcasts.
const WANTED = {
  espn: 'ESPN', espn2: 'ESPN 2', espnu: 'ESPNU', espnews: 'ESPNEWS',
  abc: 'ABC', cbs: 'CBS', 'cbs-sports-network': 'CBS Sports Network',
  fox: 'FOX', 'fox-sports-1': 'FS1', 'fox-sports-2': 'FS2',
  'acc-network': 'ACC Network', 'big-ten-network': 'Big Ten Network',
  'nfl-network': 'NFL Network', 'golf-channel': 'Golf Channel',
};

async function channels() {
  const metas = await catalog('nuvio_sports_networks').catch(() => []);
  const out = [];
  for (const m of metas) {
    const slug = String(m.id).replace(/^.*ts_ch_/, '');
    const name = WANTED[slug];
    if (!name || !/ts_ch_/.test(m.id)) continue;
    out.push({ key: m.id, name: `${name} US`, country: 'us' });
  }
  // The addon scrapes its upstreams per request (~8-16 s). Warm the cache in the background so a
  // later resolve() of a network ref usually answers from our cache instead of timing out.
  for (const c of out.slice(0, 8)) warm(c.key);
  return out;
}

const warming = new Set();
function warm(key) {
  if (warming.has(key) || cache.peek(`stream:${key}`)) return;
  warming.add(key);
  resolve({ key }).catch(() => {}).finally(() => warming.delete(key));
}

// Its stream endpoint scrapes upstream per request (8-16s), so only ask when nothing better exists.
module.exports = { id: 'nuviosports', name: 'Nuvio Live Sports', slow: true, events, channels, resolve };
