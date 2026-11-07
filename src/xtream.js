'use strict';
// Xtream Codes IPTV: channel list, short EPG and event -> channel matching.

const { fetchJson, TtlCache, mapLimit, withTimeout } = require('./util');
const m = require('./match');

const listCache = new TtlCache(50);
const epgCache = new TtlCache(20000);

const api = (x, params) => {
  const q = new URLSearchParams({ username: x.username, password: x.password, ...params });
  return `${x.server}/player_api.php?${q}`;
};

async function accountInfo(x) {
  const data = await fetchJson(api(x, {}), { timeout: 15000 });
  if (!data || !data.user_info || Number(data.user_info.auth) !== 1) throw new Error('Xtream login rejected');
  return data;
}

function countryOfCategory(name) {
  const { country } = m.parseChannelName(name);
  if (country) return country;
  if (/\b(us|usa|united states|america|american)\b/i.test(name)) return 'us';
  return '';
}

// Fetch and index every live channel once per 30 minutes.
async function getChannels(x) {
  const key = `${x.server}|${x.username}`;
  return listCache.get(key, 30 * 60_000, async () => {
    const [cats, streams] = await Promise.all([
      fetchJson(api(x, { action: 'get_live_categories' }), { timeout: 30000 }),
      fetchJson(api(x, { action: 'get_live_streams' }), { timeout: 60000 }),
    ]);
    const catMap = new Map((Array.isArray(cats) ? cats : []).map((c) => [String(c.category_id), String(c.category_name || '')]));
    const list = (Array.isArray(streams) ? streams : []).map((s) => {
      const name = String(s.name || '').trim();
      const catName = catMap.get(String(s.category_id)) || '';
      const parsed = m.parseChannelName(name);
      return {
        id: String(s.stream_id),
        name,
        folded: m.fold(name),
        base: parsed.base,
        country: parsed.country || countryOfCategory(catName),
        catName,
        catFolded: m.fold(catName),
        icon: s.stream_icon || '',
        hasEpg: !!s.epg_channel_id,
      };
    });
    console.log(`[xtream] ${new URL(x.server).host}: ${list.length} channels, ${catMap.size} categories`);
    return list;
  });
}

const b64 = (s) => {
  try { return Buffer.from(String(s || ''), 'base64').toString('utf8'); } catch { return ''; }
};

async function shortEpg(x, id) {
  return epgCache.get(`${x.server}|${id}`, 10 * 60_000, async () => {
    const data = await fetchJson(api(x, { action: 'get_short_epg', stream_id: id, limit: 4 }), { timeout: 8000 });
    return (data.epg_listings || []).map((p) => ({
      title: b64(p.title),
      desc: b64(p.description),
      start: Number(p.start_timestamp) * 1000 || Date.parse(p.start),
      stop: Number(p.stop_timestamp) * 1000 || Date.parse(p.end),
    }));
  });
}

function streamUrl(x, id, ext = 'm3u8') {
  return `${x.server}/live/${encodeURIComponent(x.username)}/${encodeURIComponent(x.password)}/${id}.${ext}`;
}

// Channels that carry rotating events (ESPN+ 01, PPV 3, NCAAF 12...) and need EPG to identify.
const EVENT_SLOT_RE = /\b(espn\s*\+|espn plus|ncaa ?f?|cfb|college football|ppv|ufc|paramount|peacock|flo ?sports?|b1g ?\+|secn ?\+|sec network ?\+|accnx|acc extra|event|events|live event|fight|mma|big 12 now|fubo sports)\b/;

const isUsOrUnknown = (c) => !c.country || c.country === 'us';

function mentions(ev, text) {
  if (ev.sport === 'ufc') return m.ufcMentionScore(text, ev) >= 3;
  return m.mentionsBothTeams(text, ev);
}

function epgHit(ev, listings) {
  const center = ev.sport === 'ufc' ? ev.mainStart || ev.start : ev.start;
  for (const p of listings || []) {
    const text = `${p.title} ${p.desc}`;
    if (!mentions(ev, text)) continue;
    // Programme should overlap the event window (generous: providers pad blocks).
    if (p.start && p.stop && (p.stop < center - 3 * 3600_000 || p.start > center + 6 * 3600_000)) continue;
    return p;
  }
  return null;
}

/**
 * Returns ranked IPTV matches for an ESPN event:
 * [{ channel, why, rank, programme? }]
 */
async function findForEvent(x, ev, { epgBudgetMs = 6000 } = {}) {
  const channels = await getChannels(x);
  const out = new Map();
  const add = (c, why, rank, programme) => {
    const prev = out.get(c.id);
    const q = m.qualityOf(c.name).score;
    const r = rank + q;
    if (!prev || prev.rank < r) out.set(c.id, { channel: c, why, rank: r, programme });
  };

  // 1) Event channels whose own name mentions the game / card.
  for (const c of channels) {
    if (mentions(ev, c.name)) add(c, 'event channel', 100);
  }

  // 2) National TV networks from ESPN's broadcast list.
  const perNet = new Map();
  for (const net of ev.broadcasts || []) {
    if (!m.knownNetwork(net)) continue;
    const hits = [];
    for (const c of channels) {
      if (!isUsOrUnknown(c)) continue;
      const r = m.networkRank(c.base, net);
      if (r) hits.push({ c, r: r + (c.country === 'us' ? 2 : 0) + m.qualityOf(c.name).score });
    }
    hits.sort((a, b) => b.r - a.r);
    const top = hits.filter((h) => h.r >= 8).slice(0, 6);
    const affiliates = hits.filter((h) => h.r < 8).slice(0, top.length ? 2 : 4);
    for (const h of [...top, ...affiliates]) add(h.c, net, 40 + h.r);
    perNet.set(net, top.length + affiliates.length);
  }

  // 3) Rotating event slots: check their EPG for the matchup (time-boxed; cached for next call).
  const slots = channels.filter((c) => !out.has(c.id) && (EVENT_SLOT_RE.test(c.folded) || EVENT_SLOT_RE.test(c.catFolded)) && isUsOrUnknown(c));
  const capped = slots.slice(0, 400);
  const scan = mapLimit(capped, 24, async (c) => {
    const listings = await shortEpg(x, c.id);
    const p = epgHit(ev, listings);
    if (p) add(c, 'guide', 90, p);
  });
  await withTimeout(scan, epgBudgetMs);

  return [...out.values()].sort((a, b) => b.rank - a.rank).slice(0, 25);
}

module.exports = { accountInfo, getChannels, findForEvent, streamUrl, shortEpg };
