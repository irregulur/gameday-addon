'use strict';
// GameDay: Nuvio / Stremio addon for College Football + UFC.
// IPTV (Xtream Codes) streams are listed first, HTTP-scraped streams second.

const path = require('path');
const express = require('express');
const pkg = require('../package.json');
const config = require('./config');
const espn = require('./espn');
const cards = require('./cards');
const xtream = require('./xtream');
const providers = require('./providers');
const hls = require('./hls');
const { withTimeout } = require('./util');

const PORT = Number(process.env.PORT) || 7000;
const PREFIX = 'gd:';
const PAGE = 50;

const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------------------------------------------------------------- helpers

const CONF_GENRES = Object.values(espn.CONFERENCES);
const CFB_GENRES = ['Live', 'Today', 'Top 25', 'Power 4', ...CONF_GENRES];
const UFC_GENRES = ['Live', 'Upcoming'];

function fmtTime(ms, tz, opts) {
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, ...opts }).format(new Date(ms));
}
const dayTime = (ms, tz) => fmtTime(ms, tz, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });

function releaseInfo(ev, tz) {
  if (ev.status.state === 'in') return `🔴 LIVE${ev.status.detail ? ` · ${ev.status.detail}` : ''}`;
  if (ev.status.state === 'post') return 'Final';
  return dayTime(ev.start, tz);
}

function cfbTitle(ev) {
  const t = (x) => `${x.rank ? `#${x.rank} ` : ''}${x.location || x.short}`;
  return `${t(ev.away)} ${ev.neutral ? 'vs' : '@'} ${t(ev.home)}`;
}

function cardUrl(base, kind, ev, cfg, bout) {
  if (kind === 'cfb') {
    return `${base}/card/cfb/${ev.espnId}.jpg?tz=${encodeURIComponent(cfg.tz)}&v=${cards.version(cards.cfbKey(ev, cfg.tz))}`;
  }
  return `${base}/card/ufc/${ev.espnId}/${bout.id}.jpg?tz=${encodeURIComponent(cfg.tz)}&v=${cards.version(cards.ufcKey(ev, bout, cfg.tz))}`;
}

const order = (ev) => (ev.status.state === 'in' ? 0 : ev.status.state === 'pre' ? 1 : 2);
const byOrder = (a, b) => order(a) - order(b) || (order(a) === 2 ? b.start - a.start : a.start - b.start);

function visible(ev, cfg) {
  if (ev.status.state !== 'post') return true;
  // Finished games stay a couple of hours (replays on IPTV) or always if asked.
  return cfg.showFinished || Date.now() - ev.start < 5 * 3600_000;
}

function cfbMetaPreview(ev, cfg, base) {
  const poster = cardUrl(base, 'cfb', ev, cfg);
  return {
    id: `${PREFIX}${ev.id}`,
    type: 'tv',
    name: cfbTitle(ev),
    poster,
    posterShape: 'landscape',
    background: poster,
    logo: ev.home.logo,
    releaseInfo: releaseInfo(ev, cfg.tz),
    released: new Date(ev.start).toISOString(),
    description: [
      `${ev.away.name} ${ev.neutral ? 'vs' : 'at'} ${ev.home.name}`,
      ev.status.state === 'pre' ? dayTime(ev.start, cfg.tz) : `${ev.away.abbr} ${ev.away.score ?? ''} – ${ev.home.abbr} ${ev.home.score ?? ''} (${ev.status.detail})`,
      ev.broadcasts.length ? `TV: ${ev.broadcasts.join(', ')}` : '',
      ev.venue || '',
    ].filter(Boolean).join('\n'),
    genres: ['College Football', ev.conference].filter(Boolean),
    behaviorHints: { defaultVideoId: `${PREFIX}${ev.id}` },
  };
}

function boutLine(b) {
  const w = (f) => (f.winner ? `${f.name} ✓` : f.name);
  return `${w(b.red)} vs ${w(b.blue)}${b.weightClass ? ` (${b.weightClass})` : ''}`;
}

function ufcMetaPreview(ev, cfg, base, bout = ev.main) {
  const isMain = bout.id === ev.main.id;
  const poster = cardUrl(base, 'ufc', ev, cfg, bout);
  const id = isMain ? `${PREFIX}${ev.id}` : `${PREFIX}ufcb:${ev.espnId}:${bout.id}`;
  return {
    id,
    type: 'tv',
    name: isMain ? ev.name : `${bout.red.name} vs ${bout.blue.name}`,
    poster,
    posterShape: 'landscape',
    background: poster,
    releaseInfo: releaseInfo(isMain ? ev : { ...ev, start: bout.start, status: bout.status.state === 'pre' && ev.status.state === 'in' ? ev.status : bout.status }, cfg.tz),
    released: new Date(isMain ? ev.start : bout.start).toISOString(),
    description: isMain
      ? [dayTime(ev.start, cfg.tz), ev.broadcasts.length ? `TV: ${ev.broadcasts.join(', ')}` : '', ev.venue, '', 'Fight card:', ...ev.bouts.map(boutLine)].filter((l) => l !== null && l !== undefined).join('\n').trim()
      : [ev.name, bout.weightClass, `${bout.red.name} (${bout.red.record}) vs ${bout.blue.name} (${bout.blue.record})`].filter(Boolean).join('\n'),
    genres: ['UFC', bout.weightClass].filter(Boolean),
    cast: [bout.red.name, bout.blue.name],
    behaviorHints: { defaultVideoId: id },
  };
}

async function cfbFiltered(cfg, genre) {
  let list = (await espn.getCfbEvents()).filter((e) => visible(e, cfg));
  if (cfg.cfbScope === 'power4') list = list.filter(espn.isPower4);
  if (cfg.cfbScope === 'top25') list = list.filter((e) => e.home.rank || e.away.rank);
  if (genre === 'Live') list = list.filter((e) => e.status.state === 'in');
  else if (genre === 'Today') {
    const today = espn.ymd(new Date(), cfg.tz);
    list = list.filter((e) => espn.ymd(new Date(e.start), cfg.tz) === today);
  } else if (genre === 'Top 25') list = list.filter((e) => e.home.rank || e.away.rank);
  else if (genre === 'Power 4') list = list.filter(espn.isPower4);
  else if (genre && CONF_GENRES.includes(genre)) list = list.filter((e) => e.conference === genre);
  return list.sort(byOrder);
}

async function ufcFiltered(cfg, genre) {
  let list = (await espn.getUfcEvents()).filter((e) => visible(e, cfg));
  if (genre === 'Live') list = list.filter((e) => e.status.state === 'in');
  if (genre === 'Upcoming') list = list.filter((e) => e.status.state === 'pre');
  return list.sort(byOrder);
}

// Event whose fights are shown in the "Fight Card" catalog: live one, else next upcoming.
async function featuredUfc(cfg) {
  const list = await ufcFiltered(cfg);
  return list.find((e) => e.status.state === 'in') || list.find((e) => e.status.state === 'pre') || list[0] || null;
}

async function resolveId(id) {
  if (!id.startsWith(PREFIX)) return null;
  const raw = id.slice(PREFIX.length);
  if (raw.startsWith('ufcb:')) {
    const [, evId, boutId] = raw.split(':');
    const ev = await espn.getEvent(`ufc:${evId}`);
    const bout = ev && ev.bouts.find((b) => b.id === boutId);
    return ev && bout ? { ev, bout } : null;
  }
  const ev = await espn.getEvent(raw);
  return ev ? { ev, bout: ev.main || null } : null;
}

function parseExtra(str) {
  const out = {};
  if (!str) return out;
  for (const part of String(str).split('&')) {
    const [k, ...v] = part.split('=');
    if (k) out[decodeURIComponent(k)] = decodeURIComponent(v.join('=') || '');
  }
  return out;
}

// ---------------------------------------------------------------- manifest

function manifest() {
  return {
    id: 'community.gameday.cfb-ufc',
    version: pkg.version,
    name: 'GameDay · CFB & UFC',
    description: 'College Football and UFC: game cards with live scores, your IPTV (Xtream Codes) channels first, then free HTTP sources.',
    resources: ['catalog', 'meta', 'stream'],
    types: ['tv'],
    idPrefixes: [PREFIX],
    catalogs: [
      { type: 'tv', id: 'gd_cfb', name: 'College Football', extra: [{ name: 'genre', options: CFB_GENRES, isRequired: false }, { name: 'skip' }] },
      { type: 'tv', id: 'gd_ufc', name: 'UFC Events', extra: [{ name: 'genre', options: UFC_GENRES, isRequired: false }] },
      { type: 'tv', id: 'gd_ufc_card', name: 'UFC Fight Card' },
    ],
    behaviorHints: { configurable: true, configurationRequired: false },
  };
}

// ---------------------------------------------------------------- streams

async function iptvStreams(cfg, ev) {
  if (!cfg.xtream) return [];
  try {
    const hits = await xtream.findForEvent(cfg.xtream, ev);
    return hits.map((h) => ({
      name: '📺 IPTV',
      title: [h.channel.name, [h.why, h.programme && h.programme.title].filter(Boolean).join(' · ')].filter(Boolean).join('\n'),
      url: xtream.streamUrl(cfg.xtream, h.channel.id, cfg.iptvExt),
      behaviorHints: { notWebReady: true, bingeGroup: `gameday-iptv-${h.channel.id}` },
    }));
  } catch (e) {
    console.warn(`[iptv] ${e.message}`);
    return [];
  }
}

async function httpStreams(cfg, ev, base) {
  const list = await providers.liveStreamsForEvent(ev, cfg);
  // Event-specific links first, then 24/7 network channels; within that keep provider order.
  list.sort((a, b) => (a.ref.why === 'event' ? 0 : 1) - (b.ref.why === 'event' ? 0 : 1) || (b.quality ? 1 : 0) - (a.quality ? 1 : 0));
  return list.map((s) => {
    const title = [`${s.provider} · ${s.title || s.ref.name}`, s.quality].filter(Boolean).join('\n');
    if (s.external) return { name: '🌐 HTTP', title, externalUrl: s.url };
    const headers = s.headers || {};
    if (s.proxy || cfg.httpProxy) {
      return { name: '🌐 HTTP', title, url: hls.proxyUrl(base, s.url, headers), behaviorHints: { notWebReady: false, bingeGroup: `gameday-${s.providerId}` } };
    }
    const hasHeaders = Object.keys(headers).length > 0;
    return {
      name: '🌐 HTTP',
      title,
      url: s.url,
      behaviorHints: {
        notWebReady: hasHeaders,
        bingeGroup: `gameday-${s.providerId}`,
        ...(hasHeaders ? { proxyHeaders: { request: headers } } : {}),
      },
    };
  });
}

// ---------------------------------------------------------------- addon routes

const send = (res, body, maxAge = 60) => {
  res.set('Cache-Control', `public, max-age=${maxAge}, stale-while-revalidate=${maxAge * 2}`);
  res.json(body);
};

async function handleAddon(req, res) {
  const seg = req.params[0];
  const rest = req.params[1];
  const cfg = config.parseConfigSegment(seg);
  const base = hls.baseUrl(req);
  try {
    if (rest === 'manifest.json') return send(res, manifest(), 300);

    const parts = rest.replace(/\.json$/, '').split('/');
    const [resource, type, id, extraStr] = parts.map((p) => decodeURIComponent(p));
    if (type !== 'tv') return send(res, resource === 'catalog' ? { metas: [] } : resource === 'meta' ? { meta: null } : { streams: [] });
    const extra = { ...parseExtra(extraStr), ...req.query };

    if (resource === 'catalog') {
      const skip = Number(extra.skip) || 0;
      let metas = [];
      if (id === 'gd_cfb') {
        metas = (await cfbFiltered(cfg, extra.genre)).slice(skip, skip + PAGE).map((e) => cfbMetaPreview(e, cfg, base));
      } else if (id === 'gd_ufc') {
        metas = skip ? [] : (await ufcFiltered(cfg, extra.genre)).map((e) => ufcMetaPreview(e, cfg, base));
      } else if (id === 'gd_ufc_card') {
        const ev = skip ? null : await featuredUfc(cfg);
        metas = ev ? ev.bouts.map((b) => ufcMetaPreview(ev, cfg, base, b)) : [];
      }
      return send(res, { metas }, 60);
    }

    if (resource === 'meta') {
      const hit = await resolveId(id);
      if (!hit) return send(res, { meta: null }, 30);
      const meta = hit.ev.sport === 'cfb' ? cfbMetaPreview(hit.ev, cfg, base) : ufcMetaPreview(hit.ev, cfg, base, hit.bout);
      return send(res, { meta }, 60);
    }

    if (resource === 'stream') {
      const hit = await resolveId(id);
      if (!hit) return send(res, { streams: [] }, 30);
      const [iptv, http] = await Promise.all([
        withTimeout(iptvStreams(cfg, hit.ev), 12000, []),
        withTimeout(httpStreams(cfg, hit.ev, base), 14000, []),
      ]);
      const streams = [...iptv, ...http];
      return send(res, { streams }, streams.length ? 120 : 20);
    }
    return res.status(404).json({ err: 'not found' });
  } catch (e) {
    console.error(`[addon] ${req.path}: ${e.stack || e.message}`);
    return res.status(500).json({ err: 'internal error' });
  }
}

app.get(/^\/(?:([A-Za-z0-9_-]{20,})\/)?(manifest\.json|(?:catalog|meta|stream)\/.+\.json)$/, handleAddon);

// ---------------------------------------------------------------- cards

app.get('/card/cfb/:id.jpg', async (req, res) => {
  try {
    const cfg = config.sanitize({ tz: req.query.tz });
    const ev = await espn.getEvent(`cfb:${req.params.id}`);
    if (!ev) return res.sendStatus(404);
    const jpg = await cards.cfbCard(ev, cfg.tz);
    res.set('Content-Type', 'image/jpeg').set('Cache-Control', `public, max-age=${ev.status.state === 'in' ? 60 : 600}`).send(jpg);
  } catch (e) {
    console.error(`[card] ${e.message}`);
    res.sendStatus(500);
  }
});

app.get('/card/ufc/:id/:bout.jpg', async (req, res) => {
  try {
    const cfg = config.sanitize({ tz: req.query.tz });
    const ev = await espn.getEvent(`ufc:${req.params.id}`);
    const bout = ev && ev.bouts.find((b) => b.id === req.params.bout);
    if (!bout) return res.sendStatus(404);
    const jpg = await cards.ufcCard(ev, bout, cfg.tz);
    res.set('Content-Type', 'image/jpeg').set('Cache-Control', 'public, max-age=600').send(jpg);
  } catch (e) {
    console.error(`[card] ${e.message}`);
    res.sendStatus(500);
  }
});

// ---------------------------------------------------------------- HLS relay

app.get('/hls/:token/:name', hls.handle);

// ---------------------------------------------------------------- configure + api

const PUBLIC = path.join(__dirname, '..', 'public');
app.get('/', (req, res) => res.redirect('/configure'));
app.get(['/configure', '/:config/configure'], (req, res) => res.sendFile(path.join(PUBLIC, 'configure.html')));
app.use('/static', express.static(PUBLIC, { maxAge: '1h' }));

app.get('/api/providers', (req, res) => res.json(providers.list()));

// Config behind an install token, so /<token>/configure can prefill the form.
app.get('/api/config/:token', (req, res) => res.json(config.parseConfigSegment(req.params.token)));

app.post('/api/config', (req, res) => {
  const cfg = config.sanitize(req.body || {});
  const token = config.seal(cfg);
  const base = hls.baseUrl(req);
  res.json({ token, manifestUrl: `${base}/${token}/manifest.json` });
});

app.post('/api/test-xtream', async (req, res) => {
  const cfg = config.sanitize({ xtream: req.body || {} });
  if (!cfg.xtream) return res.status(400).json({ ok: false, error: 'server, username and password are required' });
  try {
    const info = await xtream.accountInfo(cfg.xtream);
    const ui = info.user_info || {};
    if (String(ui.auth) !== '1') return res.json({ ok: false, error: 'login rejected by provider' });
    const channels = await xtream.getChannels(cfg.xtream);
    res.json({
      ok: true,
      status: ui.status,
      expires: ui.exp_date ? new Date(Number(ui.exp_date) * 1000).toISOString().slice(0, 10) : 'never',
      maxConnections: ui.max_connections,
      channels: channels.length,
    });
  } catch (e) {
    res.json({ ok: false, error: e.message });
  }
});

app.get('/health', (req, res) => res.json({ ok: true, version: pkg.version, providers: providers.list().map((p) => p.id) }));

// Providers cache their scrapes; refresh them in the background so requests stay fast.
setTimeout(providers.warm, 3000).unref();
setInterval(providers.warm, 5 * 60_000).unref();

app.listen(PORT, () => {
  console.log(`GameDay ${pkg.version} on :${PORT}  providers: ${providers.list().map((p) => p.id).join(', ') || 'none'}`);
});
