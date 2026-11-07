'use strict';
// Landscape 1280x720 match cards rendered SVG -> JPEG with sharp (librsvg).
// Logos / headshots are fetched, resized and inlined as data URIs (librsvg won't fetch remote images).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { DATA_DIR } = require('./config');

// Make bundled fonts visible to librsvg/pango before sharp loads.
const FONT_DIR = path.join(__dirname, '..', 'assets', 'fonts');
const fontsConf = path.join(DATA_DIR, 'fonts.conf');
fs.writeFileSync(fontsConf, `<?xml version="1.0"?><!DOCTYPE fontconfig SYSTEM "fonts.dtd"><fontconfig><dir>${FONT_DIR}</dir><include ignore_missing="yes">/etc/fonts/fonts.conf</include><cachedir>${path.join(DATA_DIR, 'fontcache')}</cachedir></fontconfig>`);
process.env.FONTCONFIG_FILE = fontsConf;
const sharp = require('sharp');
sharp.cache(false);
sharp.concurrency(2);

const { UA, TtlCache } = require('./util');

const W = 1280;
const H = 720;
const FONT = "'Barlow Condensed', 'Arial Narrow', 'DejaVu Sans Condensed', sans-serif";
const CARD_DIR = path.join(DATA_DIR, 'cards');
fs.mkdirSync(CARD_DIR, { recursive: true });

const imgCache = new TtlCache(600);
const memCards = new TtlCache(300);

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Condensed bold ~0.48em per glyph; shrink font to fit a width.
const fit = (text, max, width, k = 0.5) => Math.max(14, Math.min(max, Math.floor(width / (Math.max(1, String(text).length) * k))));

async function imgData(url, w, h) {
  if (!url) return null;
  return imgCache.get(`${url}|${w}x${h}`, 6 * 3600_000, async () => {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA, Referer: 'https://www.espn.com/' }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      const png = await sharp(buf).resize(w, h, { fit: 'inside', withoutEnlargement: false }).png().toBuffer();
      return `data:image/png;base64,${png.toString('base64')}`;
    } catch {
      return null;
    }
  });
}

const image = (href, x, y, w, h, extra = '') =>
  href ? `<image x="${x}" y="${y}" width="${w}" height="${h}" href="${href}" xlink:href="${href}" preserveAspectRatio="xMidYMid meet" ${extra}/>` : '';

function timeParts(ms, tz) {
  const d = new Date(ms);
  const day = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric' }).format(d);
  const time = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit', timeZoneName: 'short' }).format(d);
  return { day: day.toUpperCase().replace(',', ''), time: time.toUpperCase() };
}

function pill(x, y, text, { fill = 'rgba(0,0,0,0.55)', color = '#fff', dot = false, anchor = 'start' } = {}) {
  const size = 30;
  const w = Math.round(String(text).length * size * 0.52 + (dot ? 64 : 40));
  const x0 = anchor === 'end' ? x - w : x;
  return `<g>
    <rect x="${x0}" y="${y}" width="${w}" height="52" rx="26" fill="${fill}"/>
    ${dot ? `<circle cx="${x0 + 30}" cy="${y + 26}" r="9" fill="#fff"/>` : ''}
    <text x="${x0 + (dot ? 48 : 20)}" y="${y + 37}" font-family="${FONT}" font-weight="700" font-size="${size}" letter-spacing="2" fill="${color}">${esc(text)}</text>
  </g>`;
}

function statusPill(ev, tz) {
  if (ev.status.state === 'in') return pill(W - 40, 36, 'LIVE', { fill: '#e11d2a', dot: true, anchor: 'end' });
  if (ev.status.state === 'post') return pill(W - 40, 36, 'FINAL', { fill: 'rgba(0,0,0,0.65)', anchor: 'end' });
  const { day } = timeParts(ev.start, tz);
  return pill(W - 40, 36, day, { anchor: 'end' });
}

const defs = `<defs>
  <filter id="shadow" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="8" stdDeviation="12" flood-color="#000" flood-opacity="0.45"/></filter>
  <filter id="tshadow"><feDropShadow dx="0" dy="3" stdDeviation="3" flood-color="#000" flood-opacity="0.7"/></filter>
  <linearGradient id="shade" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#000" stop-opacity="0.55"/>
    <stop offset="0.35" stop-color="#000" stop-opacity="0.08"/>
    <stop offset="0.7" stop-color="#000" stop-opacity="0.25"/>
    <stop offset="1" stop-color="#000" stop-opacity="0.85"/>
  </linearGradient>
  <radialGradient id="redGlow" cx="0.2" cy="0.55" r="0.65"><stop offset="0" stop-color="#e11d2a" stop-opacity="0.85"/><stop offset="1" stop-color="#e11d2a" stop-opacity="0"/></radialGradient>
  <radialGradient id="blueGlow" cx="0.8" cy="0.55" r="0.65"><stop offset="0" stop-color="#1d5be1" stop-opacity="0.85"/><stop offset="1" stop-color="#1d5be1" stop-opacity="0"/></radialGradient>
  <linearGradient id="floor" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#000" stop-opacity="0"/><stop offset="1" stop-color="#000" stop-opacity="0.95"/></linearGradient>
</defs>`;

// Darken very light team colors so white text stays readable.
function safeColor(hex, fallback) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  const r = n >> 16, g = (n >> 8) & 255, b = n & 255;
  const lum = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  if (lum < 0.82) return `#${m[1]}`;
  const k = 0.55;
  return `rgb(${Math.round(r * k)},${Math.round(g * k)},${Math.round(b * k)})`;
}

function cfbTeamName(t) {
  return `${t.rank ? `#${t.rank} ` : ''}${t.short || t.location}`.toUpperCase();
}

async function cfbSvg(ev, tz) {
  const [awayLogo, homeLogo] = await Promise.all([imgData(ev.away.logo, 300, 300), imgData(ev.home.logo, 300, 300)]);
  const ac = safeColor(ev.away.color, '#2b2b2b');
  const hc = safeColor(ev.home.color, '#3b3b3b');
  const live = ev.status.state === 'in';
  const post = ev.status.state === 'post';
  const { day, time } = timeParts(ev.start, tz);
  const net = (ev.broadcasts || []).slice(0, 2).join(' / ');

  const plate = (cx, logo, team) => `
    <circle cx="${cx}" cy="315" r="158" fill="#ffffff" fill-opacity="0.96" filter="url(#shadow)"/>
    <circle cx="${cx}" cy="315" r="158" fill="none" stroke="#ffffff" stroke-opacity="0.35" stroke-width="10"/>
    ${logo ? image(logo, cx - 118, 197, 236, 236) : `<text x="${cx}" y="355" text-anchor="middle" font-family="${FONT}" font-weight="800" font-size="120" fill="#222">${esc((team.abbr || team.short || '?').slice(0, 4))}</text>`}`;

  const nameBlock = (cx, team) => {
    const label = cfbTeamName(team);
    const size = fit(label, 60, 420);
    return `<text x="${cx}" y="548" text-anchor="middle" font-family="${FONT}" font-weight="800" font-size="${size}" letter-spacing="1" fill="#fff" filter="url(#tshadow)">${team.rank ? `<tspan fill="#ffd34d">#${team.rank} </tspan>${esc((team.short || team.location).toUpperCase())}` : esc(label)}</text>
      ${team.record ? `<text x="${cx}" y="590" text-anchor="middle" font-family="${FONT}" font-weight="600" font-size="30" fill="#ffffff" fill-opacity="0.8">${esc(team.record)}</text>` : ''}`;
  };

  let center;
  if (live || post) {
    const a = ev.away.score || '0';
    const h = ev.home.score || '0';
    const sub = post ? 'FINAL' : (ev.status.detail || '').toUpperCase();
    center = `<text x="${W / 2}" y="350" text-anchor="middle" font-family="${FONT}" font-weight="800" font-size="104" fill="#fff" filter="url(#tshadow)">${esc(a)}<tspan fill-opacity="0.6"> – </tspan>${esc(h)}</text>
      <text x="${W / 2}" y="400" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="${fit(sub, 32, 340)}" fill="#fff" fill-opacity="0.9">${esc(sub)}</text>`;
  } else {
    center = `<circle cx="${W / 2}" cy="315" r="56" fill="rgba(0,0,0,0.55)" stroke="#fff" stroke-opacity="0.85" stroke-width="4"/>
      <text x="${W / 2}" y="337" text-anchor="middle" font-family="${FONT}" font-weight="800" font-style="italic" font-size="60" fill="#fff">${ev.neutral ? 'VS' : '@'}</text>`;
  }

  const bottom = live ? `LIVE NOW${net ? ` · ${net}` : ''}` : post ? `FINAL${net ? ` · ${net}` : ''}` : `${time}${net ? ` · ${net}` : ''}`;
  const label = ['COLLEGE FOOTBALL', ev.conference].filter(Boolean).join(' · ').toUpperCase();

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xml:space="preserve" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  ${defs}
  <rect width="${W}" height="${H}" fill="#111"/>
  <polygon points="0,0 700,0 580,${H} 0,${H}" fill="${ac}"/>
  <polygon points="700,0 ${W},0 ${W},${H} 580,${H}" fill="${hc}"/>
  <polygon points="694,0 706,0 586,${H} 574,${H}" fill="#fff" fill-opacity="0.85"/>
  <rect width="${W}" height="${H}" fill="url(#shade)"/>
  <text x="44" y="74" font-family="${FONT}" font-weight="700" font-size="30" letter-spacing="4" fill="#fff" fill-opacity="0.92">${esc(label)}</text>
  ${statusPill(ev, tz)}
  ${plate(300, awayLogo, ev.away)}
  ${plate(980, homeLogo, ev.home)}
  ${center}
  ${nameBlock(300, ev.away)}
  ${nameBlock(980, ev.home)}
  <rect x="0" y="626" width="${W}" height="94" fill="#000" fill-opacity="0.55"/>
  <text x="${W / 2}" y="686" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="${fit(bottom, 44, 1100)}" letter-spacing="2" fill="#fff">${live ? `<tspan fill="#ff4d57">● </tspan>` : ''}${esc(bottom)}</text>
  ${!live && !post ? `<text x="44" y="686" font-family="${FONT}" font-weight="600" font-size="30" fill="#fff" fill-opacity="0.7">${esc(day)}</text>` : ''}
</svg>`;
}

const SILHOUETTE = (x, y, w, h, color) => `<g transform="translate(${x + w / 2 - 170},${y + h - 400})" fill="${color}" fill-opacity="0.55">
  <circle cx="170" cy="130" r="95"/>
  <path d="M0,400 C10,280 80,235 170,235 C260,235 330,280 340,400 Z"/>
</g>`;

function nameLines(f, x, anchor, maxW) {
  const parts = String(f.name || '').trim().split(/\s+/);
  const first = parts.length > 1 ? parts[0] : '';
  const last = (parts.length > 1 ? parts.slice(1).join(' ') : parts[0] || 'TBA').toUpperCase();
  const meta = [f.record, f.country].filter(Boolean).join(' · ');
  return `<text x="${x}" y="584" text-anchor="${anchor}" font-family="${FONT}" font-weight="600" font-size="34" fill="#fff" fill-opacity="0.85" filter="url(#tshadow)">${esc(first.toUpperCase())}</text>
    <text x="${x}" y="652" text-anchor="${anchor}" font-family="${FONT}" font-weight="800" font-size="${fit(last, 78, maxW, 0.52)}" fill="#fff" filter="url(#tshadow)">${esc(last)}</text>
    ${meta ? `<text x="${x}" y="696" text-anchor="${anchor}" font-family="${FONT}" font-weight="600" font-size="28" fill="#fff" fill-opacity="0.75">${esc(meta)}</text>` : ''}`;
}

async function ufcSvg(ev, bout, tz, { isMain = true } = {}) {
  const [redImg, blueImg] = await Promise.all([imgData(bout.red.headshot, 660, 480), imgData(bout.blue.headshot, 660, 480)]);
  const live = bout.status.state === 'in' || (isMain && ev.status.state === 'in');
  const post = bout.status.state === 'post';
  const { day, time } = timeParts(isMain ? ev.start : bout.start, tz);
  const title = (ev.number ? `UFC ${ev.number}` : /fight night/i.test(ev.name) ? 'UFC FIGHT NIGHT' : (ev.shortName || 'UFC')).toUpperCase();
  const sub = [isMain ? 'MAIN EVENT' : '', bout.weightClass].filter(Boolean).join(' · ').toUpperCase();
  const net = (ev.broadcasts || []).slice(0, 2).join(' / ');
  const status = live ? pill(40, 36, 'LIVE', { fill: '#e11d2a', dot: true }) : post ? pill(40, 36, 'FINAL', { fill: 'rgba(0,0,0,0.65)' }) : pill(40, 36, day);
  const right = `${live ? 'LIVE NOW' : time}${net ? ` · ${net}` : ''}`;

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xml:space="preserve" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  ${defs}
  <rect width="${W}" height="${H}" fill="#0b0b10"/>
  <rect width="${W}" height="${H}" fill="url(#redGlow)"/>
  <rect width="${W}" height="${H}" fill="url(#blueGlow)"/>
  <polygon points="610,0 670,0 690,${H} 590,${H}" fill="#000" fill-opacity="0.35"/>
  ${redImg ? image(redImg, -30, 150, 680, 495, 'preserveAspectRatio="xMidYMax meet"').replace('preserveAspectRatio="xMidYMid meet" ', '') : SILHOUETTE(-30, 150, 680, 495, '#ff9aa0')}
  ${blueImg ? image(blueImg, 630, 150, 680, 495, 'preserveAspectRatio="xMidYMax meet"').replace('preserveAspectRatio="xMidYMid meet" ', '') : SILHOUETTE(630, 150, 680, 495, '#9ab8ff')}
  <rect x="0" y="430" width="${W}" height="290" fill="url(#floor)"/>
  <text x="${W / 2}" y="92" text-anchor="middle" font-family="${FONT}" font-weight="800" font-size="${fit(title, 64, 520)}" letter-spacing="3" fill="#fff" filter="url(#tshadow)">${esc(title)}</text>
  ${sub ? `<text x="${W / 2}" y="134" text-anchor="middle" font-family="${FONT}" font-weight="700" font-size="28" letter-spacing="3" fill="#d6b45a">${esc(sub)}</text>` : ''}
  <text x="${W / 2}" y="400" text-anchor="middle" font-family="${FONT}" font-weight="800" font-style="italic" font-size="120" fill="#fff" stroke="#000" stroke-opacity="0.35" stroke-width="3" filter="url(#tshadow)">VS</text>
  ${status}
  ${nameLines(bout.red, 44, 'start', 520)}
  ${nameLines(bout.blue, W - 44, 'end', 520)}
  <text x="${W - 40}" y="72" text-anchor="end" font-family="${FONT}" font-weight="700" font-size="${fit(right, 32, 380)}" fill="#fff" fill-opacity="0.9">${esc(right)}</text>
</svg>`;
}

async function render(key, svgFactory) {
  const hash = crypto.createHash('sha1').update(key).digest('hex');
  return memCards.get(hash, 10 * 60_000, async () => {
    const file = path.join(CARD_DIR, `${hash}.jpg`);
    if (fs.existsSync(file)) return fs.readFileSync(file);
    const svg = await svgFactory();
    const jpg = await sharp(Buffer.from(svg)).jpeg({ quality: 84, mozjpeg: true }).toBuffer();
    fs.writeFile(file, jpg, () => {});
    return jpg;
  });
}

// Cache key changes with everything drawn on the card.
function cfbKey(ev, tz) {
  return ['cfb', ev.id, tz, ev.status.state, ev.status.detail, ev.away.score, ev.home.score, ev.away.rank, ev.home.rank, ev.start, (ev.broadcasts || []).join()].join('|');
}
function ufcKey(ev, bout, tz) {
  return ['ufc2', ev.id, bout.id, tz, ev.status.state, bout.status.state, bout.red.id, bout.blue.id, ev.start].join('|');
}

const cfbCard = (ev, tz) => render(cfbKey(ev, tz), () => cfbSvg(ev, tz));
const ufcCard = (ev, bout, tz) => render(ufcKey(ev, bout, tz), () => ufcSvg(ev, bout, tz, { isMain: bout.id === ev.main.id }));

// Short version token for poster URLs so clients refetch when the card changes.
const version = (s) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 10);

// Prune disk cache older than 3 days.
setInterval(() => {
  const cutoff = Date.now() - 3 * 86400_000;
  for (const f of fs.readdirSync(CARD_DIR)) {
    const p = path.join(CARD_DIR, f);
    try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch { /* ignore */ }
  }
}, 6 * 3600_000).unref();

module.exports = { cfbCard, ufcCard, cfbKey, ufcKey, version, cfbSvg, ufcSvg };
