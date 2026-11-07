'use strict';
// CDNLiveTV: JSON event + channel API, player page decodes to a direct signed m3u8.
// Ported from live-sport-plugin src/providers/CdnLiveProvider.js.

const { UA, fetchJson, fetchText, TtlCache } = require('../util');

const EVENT_URLS = [
  'https://api.cdnlivetv.tv/api/v1/events/sports/?user=cdnlivetv&plan=free',
  'https://api.cdnlivetv.is/api/v1/events/sports/?user=streamsports99&plan=vip',
];
const CHANNEL_URLS = [
  'https://api.cdnlivetv.tv/api/v1/channels/?user=cdnlivetv&plan=free',
  'https://api.cdnlivetv.is/api/v1/channels/?user=cdnlivetv&plan=free',
];
const HEADERS = { Origin: 'https://cdnlivetv.tv', Referer: 'https://cdnlivetv.tv/', 'User-Agent': UA };

const cache = new TtlCache(50);
const decoded = new TtlCache(500);

async function firstOk(urls) {
  let last;
  for (const u of urls) {
    try { return await fetchJson(u, { timeout: 20000 }); } catch (e) { last = e; }
  }
  throw last;
}

// "2026-11-07 16:00" is UTC.
const parseStart = (s) => (s ? Date.parse(String(s).replace(' ', 'T') + ':00Z') || 0 : 0);

async function events() {
  return cache.get('events', 3 * 60_000, async () => {
    const data = await firstOk(EVENT_URLS);
    const root = data['cdn-live-tv'] || {};
    const out = [];
    const push = (sport, e) => {
      if (!Array.isArray(e.channels) || !e.channels.length) return;
      out.push({
        key: String(e.gameID || `${e.homeTeam}-${e.awayTeam}`),
        title: e.event || `${e.homeTeam} vs ${e.awayTeam}`,
        home: e.homeTeam || '',
        away: e.awayTeam || '',
        sport,
        start: parseStart(e.start),
        channels: e.channels.map((c) => ({ name: c.channel_name, url: c.url })),
      });
    };
    for (const e of root.NCAA || []) if (/football/i.test(e.tournament || '')) push('cfb', e);
    for (const e of root.UFC || []) push('ufc', e);
    for (const e of root.MMA || []) if (/ufc/i.test(`${e.event} ${e.tournament}`)) push('ufc', e);
    return out;
  });
}

async function channels() {
  return cache.get('channels', 30 * 60_000, async () => {
    const data = await firstOk(CHANNEL_URLS);
    return (data.channels || [])
      .filter((c) => c.status === 'online' && /^https?:\/\//.test(c.url || ''))
      .map((c) => ({ key: c.url, name: c.name, country: c.code || '' }));
  });
}

function b64(s) {
  let t = s.replace(/-/g, '+').replace(/_/g, '/');
  while (t.length % 4) t += '=';
  try { return Buffer.from(t, 'base64').toString('utf8'); } catch { return ''; }
}

function extractM3u8(html) {
  let url = '';
  // 1) var x = atob("..") + atob("..")
  const concat = /var\s+[A-Za-z0-9_]+\s*=\s*(atob\([^;]+;)/.exec(html);
  if (concat) {
    for (const p of concat[1].matchAll(/atob\s*\(\s*["']([^"']+)["']\s*\)/g)) url += b64(p[1]);
  }
  // 2) custom decoder fn(varA) + fn(varB)
  if (!url) {
    const dec = /function\s+([A-Za-z0-9_]+)\s*\([A-Za-z0-9_]+\)\s*\{[\s\S]*?atob/.exec(html);
    if (dec) {
      const call = new RegExp(`var\\s+[A-Za-z0-9_]+\\s*=\\s*${dec[1]}\\([^;]+;`).exec(html);
      if (call) {
        for (const v of call[0].matchAll(new RegExp(`${dec[1]}\\(([A-Za-z0-9_]+)\\)`, 'g'))) {
          const val = new RegExp(`var\\s+${v[1]}\\s*=\\s*['"]([^'"]+)['"]`).exec(html);
          if (val) url += b64(val[1]);
        }
      }
    }
  }
  // 3) plain URL
  if (!url) {
    const plain = /(https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*)/i.exec(html);
    if (plain) url = plain[1];
  }
  return url.includes('.m3u8') ? url : '';
}

async function decodePlayer(playerUrl) {
  return decoded.get(playerUrl, 20 * 60_000, async () => {
    const tries = [playerUrl];
    if (playerUrl.includes('cdnlivetv.tv')) tries.push(playerUrl.replace('cdnlivetv.tv', 'cdnlivetv.is'));
    for (const u of tries) {
      try {
        const html = await fetchText(u, { timeout: 9000, headers: { Referer: `${new URL(u).origin}/` } });
        const m3u8 = extractM3u8(html);
        if (m3u8) return m3u8;
      } catch { /* try mirror */ }
    }
    throw new Error('cdnlive: no m3u8');
  });
}

async function resolve(ref) {
  const targets = ref.type === 'channel'
    ? [{ name: ref.name || 'Channel', url: ref.key }]
    : ((await events()).find((e) => e.key === ref.key) || { channels: [] }).channels;
  const out = [];
  await Promise.all(targets.slice(0, 4).map(async (t) => {
    try {
      const url = await decodePlayer(t.url);
      out.push({ url, title: t.name, headers: HEADERS });
    } catch { /* skip dead channel */ }
  }));
  return out;
}

module.exports = { id: 'cdnlive', name: 'CDNLiveTV', events, channels, resolve };
