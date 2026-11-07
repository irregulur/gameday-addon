'use strict';
// HTTP scraper registry + matching of scraper events / 24-7 channels onto ESPN events.
//
// Provider module contract (src/providers/<id>.js):
//   id: string, name: string
//   events(): Promise<[{ key, title, home?, away?, sport: 'cfb'|'ufc'|'other', start?: ms }]>
//   channels?(): Promise<[{ key, name, country? }]>          // optional 24/7 networks (ESPN, ABC, FOX...)
//   resolve(ref): Promise<[{ url, title?, headers?, quality?, proxy?: bool, external?: bool }]>
//     ref = { type: 'event'|'channel', key, name }
//     proxy:true  -> playlist must be fetched by this server (IP-bound tokens / header-locked)
//     external:true -> url is a web page (opened in browser), not a playable stream

const fs = require('fs');
const path = require('path');
const m = require('../match');
const { UA, TtlCache, mapLimit, withTimeout } = require('../util');

const providers = fs.readdirSync(__dirname)
  .filter((f) => f.endsWith('.js') && f !== 'index.js' && !f.startsWith('_'))
  .map((f) => {
    try {
      const p = require(path.join(__dirname, f));
      return p && p.id && typeof p.events === 'function' && typeof p.resolve === 'function' ? p : null;
    } catch (e) {
      console.error(`[providers] failed to load ${f}: ${e.message}`);
      return null;
    }
  })
  .filter(Boolean);

function list() {
  return providers.map((p) => ({ id: p.id, name: p.name }));
}

function enabled(cfg) {
  return cfg.sources ? providers.filter((p) => cfg.sources.includes(p.id)) : providers;
}

function eventMatches(pe, ev) {
  const text = [pe.title, pe.home, pe.away].filter(Boolean).join(' ');
  if (ev.sport === 'cfb') {
    if (pe.sport === 'ufc') return false;
    if (pe.start && Math.abs(pe.start - ev.start) > 14 * 3600_000) return false;
    return m.mentionsBothTeams(text, ev);
  }
  if (pe.sport === 'cfb') return false;
  const score = m.ufcMentionScore(text, ev);
  const center = ev.mainStart || ev.start;
  const dt = pe.start ? Math.abs(pe.start - center) : 0;
  if (score >= 4 && dt < 48 * 3600_000) return true;
  if (score >= 3 && dt < 30 * 3600_000) return true;
  return false;
}

function channelMatches(ch, ev) {
  const { base, country } = m.parseChannelName(ch.name);
  if (country && country !== 'us') return 0;
  let best = 0;
  for (const net of ev.broadcasts || []) best = Math.max(best, m.networkRank(base, net));
  return best >= 8 ? best : 0; // skip local affiliates for scraped sources
}

// Collect refs from one provider for an event (events first, then matching networks).
async function refsFor(p, ev) {
  const refs = [];
  try {
    for (const pe of await p.events()) {
      if (eventMatches(pe, ev)) refs.push({ type: 'event', key: pe.key, name: pe.title, why: 'event' });
    }
  } catch (e) {
    console.warn(`[${p.id}] events: ${e.message}`);
  }
  if (typeof p.channels === 'function') {
    try {
      const hits = (await p.channels())
        .map((c) => ({ c, r: channelMatches(c, ev) }))
        .filter((h) => h.r)
        .sort((a, b) => b.r - a.r)
        .slice(0, 3);
      for (const { c } of hits) refs.push({ type: 'channel', key: c.key, name: c.name, why: 'network' });
    } catch (e) {
      console.warn(`[${p.id}] channels: ${e.message}`);
    }
  }
  return refs.slice(0, 6);
}

/** Resolve HTTP streams for an ESPN event across all enabled providers.
 *  Returns whatever has arrived once `budgetMs` elapses; slow providers keep going in the
 *  background and populate their caches for the next request (a stale result beats a slow one). */
async function streamsForEvent(ev, cfg, { budgetMs = 6500 } = {}) {
  const out = [];
  const tasks = enabled(cfg).map((p) => (async () => {
    const refs = await refsFor(p, ev);
    await Promise.all(refs.map(async (ref) => {
      try {
        const streams = await withTimeout(p.resolve(ref), budgetMs, []);
        for (const s of streams || []) if (s && s.url) out.push({ ...s, provider: p.name, providerId: p.id, ref });
      } catch (e) {
        console.warn(`[${p.id}] resolve ${ref.type}: ${e.message}`);
      }
    }));
  })()); // not awaited yet: see the two tiers below
  const slow = enabled(cfg).map((p) => p.slow);
  const fastTasks = tasks.filter((_, i) => !slow[i]);
  let timer;
  await Promise.race([
    Promise.all(fastTasks),
    new Promise((res) => { timer = setTimeout(res, budgetMs); }),
  ]);
  clearTimeout(timer);
  // Aggregators that take 10s+ only run when the fast providers found almost nothing.
  if (out.length < 2) {
    await Promise.race([Promise.all(tasks), new Promise((res) => setTimeout(res, budgetMs))]);
  }
  // De-duplicate identical URLs.
  const seen = new Set();
  return out.filter((s) => (seen.has(s.url) ? false : seen.add(s.url)));
}

// Providers often hand out links that already answer 404/403/502. Check what can be checked
// server-side (skipped when the link is IP-bound to the client) so dead entries never reach the player.
const alive = new TtlCache(400);

async function isAlive(s) {
  if (s.external) return true;
  return alive.get(s.url, 3 * 60_000, async () => {
    try {
      const res = await fetch(s.url, {
        headers: { 'User-Agent': UA, ...(s.headers || {}) },
        signal: AbortSignal.timeout(7000),
        redirect: 'follow',
      });
      if (!res.ok) return false;
      const type = res.headers.get('content-type') || '';
      // Read only the first chunk: a segment can be many MB and we only need its first bytes.
      const reader = res.body.getReader();
      const { value } = await reader.read();
      reader.cancel().catch(() => {});
      const head = Buffer.from(value || []);
      if (head.subarray(0, 7).toString() === '#EXTM3U') return true;
      if (head[0] === 0x47) return true; // MPEG-TS sync byte
      return /^image\//i.test(type) || /mpegurl|video\//i.test(type);
    } catch {
      return false;
    }
  });
}

/** streamsForEvent + liveness filtering (external pages are kept as-is). */
async function liveStreamsForEvent(ev, cfg, opts) {
  const streams = await streamsForEvent(ev, cfg, opts);
  const flags = await mapLimit(streams.filter((s) => !s.external).slice(0, 24), 12, async (s) => [s, await isAlive(s)]);
  const ok = new Set(flags.filter(([, good]) => good).map(([s]) => s.url));
  return streams.filter((s) => s.external || ok.has(s.url));
}

// Keep provider caches warm so a stream request does not pay the first scrape (some take 8-16s).
function warm() {
  for (const p of providers) {
    Promise.resolve().then(() => p.events()).catch(() => {});
    if (typeof p.channels === 'function') Promise.resolve().then(() => p.channels()).catch(() => {});
  }
}

module.exports = { list, streamsForEvent, liveStreamsForEvent, eventMatches, providers, warm };
