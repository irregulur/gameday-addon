'use strict';
// ESPN is the canonical schedule: College Football (FBS) and UFC.
// site.web.api.espn.com is the mirror that also answers from datacenter IPs.

const { fetchJson, TtlCache } = require('./util');

const HOST = process.env.ESPN_HOST || 'https://site.web.api.espn.com';
const CFB_URL = `${HOST}/apis/site/v2/sports/football/college-football/scoreboard`;
const UFC_URL = `${HOST}/apis/site/v2/sports/mma/ufc/scoreboard`;

const cache = new TtlCache(200);

// ESPN conference ids used for filtering.
const CONFERENCES = { 1: 'ACC', 4: 'Big 12', 5: 'Big Ten', 8: 'SEC', 9: 'Pac-12', 151: 'American', 17: 'Mountain West', 37: 'Sun Belt', 15: 'MAC', 12: 'C-USA', 18: 'FBS Indep.' };
const POWER4 = new Set([1, 4, 5, 8]);
const NOTRE_DAME = '87';

function ymd(date, tz = 'America/New_York') {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  return p.replace(/-/g, '');
}

function mapStatus(s = {}) {
  const t = s.type || {};
  return {
    state: t.state || 'pre', // pre | in | post
    detail: t.shortDetail || t.detail || '',
    completed: !!t.completed,
    clock: s.displayClock || '',
    period: s.period || 0,
  };
}

function mapTeam(c) {
  const t = c.team || {};
  const rank = c.curatedRank && c.curatedRank.current;
  return {
    id: String(t.id || ''),
    name: t.displayName || '', // "Utah Utes"
    short: t.shortDisplayName || t.location || '', // "Utah"
    location: t.location || '',
    nickname: t.name || '', // "Utes"
    abbr: t.abbreviation || '',
    logo: t.logo || (t.id ? `https://a.espncdn.com/i/teamlogos/ncaa/500/${t.id}.png` : ''),
    color: t.color ? `#${t.color}` : '#333333',
    altColor: t.alternateColor ? `#${t.alternateColor}` : '#ffffff',
    rank: rank && rank < 99 ? rank : null,
    score: c.score != null ? String(c.score) : '',
    conferenceId: t.conferenceId ? Number(t.conferenceId) : null,
    record: (c.records && c.records[0] && c.records[0].summary) || '',
  };
}

function broadcastsOf(comp) {
  const names = new Set();
  for (const b of comp.broadcasts || []) for (const n of b.names || []) names.add(n);
  for (const g of comp.geoBroadcasts || []) if (g.media && g.media.shortName) names.add(g.media.shortName);
  return [...names];
}

function mapCfbEvent(e) {
  const comp = (e.competitions || [])[0] || {};
  const cs = comp.competitors || [];
  const home = cs.find((c) => c.homeAway === 'home') || cs[0];
  const away = cs.find((c) => c.homeAway === 'away') || cs[1];
  if (!home || !away) return null;
  return {
    id: `cfb:${e.id}`,
    espnId: String(e.id),
    sport: 'cfb',
    name: e.name || '',
    start: Date.parse(e.date),
    status: mapStatus(e.status || comp.status),
    home: mapTeam(home),
    away: mapTeam(away),
    neutral: !!comp.neutralSite,
    venue: comp.venue ? [comp.venue.fullName, comp.venue.address && comp.venue.address.city].filter(Boolean).join(', ') : '',
    broadcasts: broadcastsOf(comp),
    conference: comp.groups && comp.groups.isConference ? comp.groups.shortName : '',
  };
}

async function cfbDay(day, ttl) {
  return cache.get(`cfb:${day}`, ttl, async () => {
    const data = await fetchJson(`${CFB_URL}?dates=${day}&groups=80&limit=500`, { timeout: 15000 });
    return (data.events || []).map(mapCfbEvent).filter(Boolean);
  });
}

// Yesterday (late games) through +7 days. Near days refresh every minute for live scores.
async function getCfbEvents() {
  const now = Date.now();
  const days = [];
  for (let d = -1; d <= 7; d++) days.push(ymd(new Date(now + d * 86400000)));
  const results = await Promise.allSettled(days.map((day, i) => cfbDay(day, i <= 2 ? 60_000 : 30 * 60_000)));
  const byId = new Map();
  for (const r of results) if (r.status === 'fulfilled') for (const ev of r.value) byId.set(ev.id, ev);
  return [...byId.values()].sort((a, b) => a.start - b.start);
}

function isPower4(ev) {
  const p4 = (t) => POWER4.has(t.conferenceId) || t.id === NOTRE_DAME;
  return p4(ev.home) || p4(ev.away);
}

function lastName(full) {
  const parts = String(full || '').trim().split(/\s+/);
  return parts.length > 1 ? parts.slice(1).join(' ') : parts[0] || '';
}

function mapFighter(c) {
  const a = c.athlete || {};
  return {
    id: String(c.id || ''),
    name: a.displayName || a.fullName || 'TBA',
    short: a.shortName || '',
    last: lastName(a.displayName || a.fullName),
    flag: (a.flag && a.flag.href) || '',
    country: (a.flag && a.flag.alt) || '',
    record: (c.records && c.records[0] && c.records[0].summary) || '',
    headshot: c.id ? `https://a.espncdn.com/i/headshots/mma/players/full/${c.id}.png` : '',
    winner: !!c.winner,
  };
}

function mapUfcEvent(e) {
  const comps = e.competitions || [];
  const bouts = comps.map((c, i) => {
    const [a, b] = c.competitors || [];
    return {
      id: String(c.id),
      order: i,
      weightClass: (c.type && c.type.abbreviation) || '',
      start: Date.parse(c.date || e.date),
      status: mapStatus(c.status),
      red: a ? mapFighter(a) : null,
      blue: b ? mapFighter(b) : null,
      broadcasts: broadcastsOf(c),
    };
  }).filter((b) => b.red && b.blue);
  if (!bouts.length) return null;
  // Main event: the bout whose fighters are named in the event title, else the last bout listed.
  const title = String(e.name || '').toLowerCase();
  const main = bouts.find((b) => title.includes(b.red.last.toLowerCase()) && title.includes(b.blue.last.toLowerCase()))
    || bouts[bouts.length - 1];
  // Put the fighter named first in the title on the left.
  if (title.indexOf(main.blue.last.toLowerCase()) > -1 && title.indexOf(main.blue.last.toLowerCase()) < title.indexOf(main.red.last.toLowerCase())) {
    [main.red, main.blue] = [main.blue, main.red];
  }
  const states = bouts.map((b) => b.status.state);
  const state = states.includes('in') ? 'in' : states.every((s) => s === 'post') ? 'post' : states.includes('post') ? 'in' : 'pre';
  const numMatch = /UFC\s+(\d{2,4})/i.exec(e.name || '');
  return {
    id: `ufc:${e.id}`,
    espnId: String(e.id),
    sport: 'ufc',
    name: e.name || 'UFC',
    shortName: e.shortName || '',
    number: numMatch ? numMatch[1] : null,
    start: Date.parse(e.date), // prelims start
    mainStart: main.start,
    status: { ...mapStatus(e.status), state },
    bouts: [...bouts].reverse(), // main event first
    main,
    venue: comps[0] && comps[0].venue ? [comps[0].venue.fullName, comps[0].venue.address && comps[0].venue.address.city].filter(Boolean).join(', ') : '',
    broadcasts: [...new Set(bouts.flatMap((b) => b.broadcasts))],
  };
}

async function getUfcEvents() {
  const now = Date.now();
  const range = `${ymd(new Date(now - 2 * 86400000))}-${ymd(new Date(now + 75 * 86400000))}`;
  return cache.get(`ufc:${range}`, 90_000, async () => {
    const data = await fetchJson(`${UFC_URL}?dates=${range}`, { timeout: 15000 });
    return (data.events || []).map(mapUfcEvent).filter(Boolean).sort((a, b) => a.start - b.start);
  });
}

async function getEvent(id) {
  const [sport] = String(id).split(':');
  const list = sport === 'ufc' ? await getUfcEvents() : await getCfbEvents();
  return list.find((e) => e.id === id) || null;
}

// Rough "is it on now" window used for ordering / live badge fallbacks.
function isLiveish(ev, now = Date.now()) {
  if (ev.status.state === 'in') return true;
  if (ev.status.state === 'post') return false;
  return ev.start - now < 15 * 60_000 && now - ev.start < 5 * 3600_000;
}

module.exports = { getCfbEvents, getUfcEvents, getEvent, isPower4, isLiveish, CONFERENCES, ymd };
