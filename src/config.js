'use strict';
// User config travels inside the addon URL as an AES-256-GCM encrypted token,
// so Xtream credentials are never visible in plain text in the install link.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

function loadKey() {
  if (process.env.GAMEDAY_SECRET) {
    return crypto.createHash('sha256').update(process.env.GAMEDAY_SECRET).digest();
  }
  const file = path.join(DATA_DIR, 'secret.key');
  if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
}
const KEY = loadKey();

const DEFAULTS = {
  tz: 'America/New_York',
  xtream: null, // { server, username, password }
  iptvExt: 'm3u8', // 'm3u8' | 'ts'
  sources: null, // null = all HTTP providers; else array of provider ids
  cfbScope: 'fbs', // 'fbs' | 'power4' | 'top25'
  showFinished: false,
  httpProxy: true, // route every HTTP-scraped stream through this server's HLS relay
};

function seal(obj) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(obj), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url');
}

function unseal(token) {
  const buf = Buffer.from(String(token), 'base64url');
  if (buf.length < 29) throw new Error('bad token');
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  const pt = Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]);
  return JSON.parse(pt.toString('utf8'));
}

function normalizeServer(url) {
  let s = String(url || '').trim().replace(/\/+$/, '');
  if (s && !/^https?:\/\//i.test(s)) s = 'http://' + s;
  return s.replace(/\/(player_api\.php|get\.php).*$/i, '');
}

function sanitize(input = {}) {
  const cfg = { ...DEFAULTS };
  try {
    if (input.tz) {
      new Intl.DateTimeFormat('en-US', { timeZone: input.tz });
      cfg.tz = input.tz;
    }
  } catch { /* invalid tz -> default */ }
  const x = input.xtream || {};
  if (x.server && x.username && x.password) {
    cfg.xtream = { server: normalizeServer(x.server), username: String(x.username).trim(), password: String(x.password).trim() };
  }
  if (input.iptvExt === 'ts') cfg.iptvExt = 'ts';
  if (Array.isArray(input.sources)) cfg.sources = input.sources.map(String);
  if (['fbs', 'power4', 'top25'].includes(input.cfbScope)) cfg.cfbScope = input.cfbScope;
  cfg.showFinished = !!input.showFinished;
  cfg.httpProxy = input.httpProxy === undefined ? DEFAULTS.httpProxy : !!input.httpProxy;
  return cfg;
}

// Accepts the path segment from /:config/... ; returns sanitized config (defaults on failure).
function parseConfigSegment(seg) {
  if (!seg) return sanitize({});
  try {
    return sanitize(unseal(seg));
  } catch {
    return sanitize({});
  }
}

module.exports = { DATA_DIR, seal, unseal, sanitize, parseConfigSegment, normalizeServer, DEFAULTS };
