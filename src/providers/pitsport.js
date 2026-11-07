'use strict';
// PitSport (pitsport.st): JSON schedule + play API. The play endpoint hands out an
// embdlol.st embed id; POSTing that id to api.embdlol.st/watch returns a direct
// m3u8 on a signed CDN path (hmk-token). Ported from live-sport-plugin
// src/providers/PitSportProvider.js, trimmed to CFB + UFC.

const { UA, fetchJson, TtlCache } = require('../util');

const BASE = 'https://pitsport.st';
const WATCH_API = 'https://api.embdlol.st/watch';
const HEAD = { 'User-Agent': UA, Referer: `${BASE}/`, Origin: BASE, Accept: 'application/json' };
const STREAM_HEADERS = { Referer: 'https://embdlol.st/', Origin: 'https://embdlol.st', 'User-Agent': UA };

const cache = new TtlCache(50);

const isUfc = (s) => /\bufc\b/i.test(s);
const isCfb = (s) => /(?:ncaa|college)[^|]*football|ncaaf|cfb\b/i.test(s);

async function events() {
  return cache.get('events', 3 * 60_000, async () => {
    const j = await fetchJson(`${BASE}/api/v1/home`, { headers: HEAD, timeout: 12000 });
    const d = (j && j.data) || {};
    const items = [...(d.live || []), ...(d.upcoming || []), ...(d.carousel || [])];
    const seen = new Set();
    const out = [];
    for (const it of items) {
      if (!it || it.programId == null || seen.has(String(it.programId))) continue;
      const title = String(it.titleText || (Array.isArray(it.title) && it.title[0] && it.title[0].text) || '').trim();
      if (!title) continue;
      const ctx = `${it.competitionSlug || ''} ${it.footer || ''} ${title}`;
      const sport = isUfc(ctx) ? 'ufc' : isCfb(ctx) ? 'cfb' : null;
      if (!sport) continue;
      seen.add(String(it.programId));
      const start = Number(it.sessionStart) > 0 ? Number(it.sessionStart) * 1000 : 0;
      out.push({ key: String(it.programId), title, sport, start: start || undefined });
    }
    return out;
  });
}

// embedUrl .../embed/<watchId>  ->  POST api.embdlol.st/watch {watchId} -> { url }
async function resolve(ref) {
  const play = await fetchJson(`${BASE}/api/v1/programs/${encodeURIComponent(ref.key)}/play`, {
    headers: HEAD, timeout: 9000,
  });
  const vids = [].concat((play.data && play.data.videos) || [], (play.data && play.data.video) || []);
  const out = [];
  for (const v of vids.slice(0, 4)) {
    const embed = String((v && v.embedUrl) || '').trim();
    const id = (embed.match(/\/(?:embed|watch)\/([A-Za-z0-9_-]+)/) || [])[1];
    if (!id) continue;
    try {
      const w = await fetchJson(WATCH_API, {
        method: 'POST',
        headers: { ...STREAM_HEADERS, 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ watchId: id }),
        timeout: 9000,
      });
      if (w && typeof w.url === 'string' && /^https?:\/\//.test(w.url)) {
        out.push({ url: w.url, title: v.label || ref.name || 'PitSport', quality: 'HD', headers: STREAM_HEADERS });
      }
    } catch { /* dead feed */ }
  }
  return out;
}

module.exports = { id: 'pitsport', name: 'PitSport', events, resolve };
