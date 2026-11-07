'use strict';
// Minimal HLS relay for scraped streams whose tokens are IP-bound or need headers the
// player cannot send. Playlists are rewritten so every URI goes back through /hls/.

const { Readable } = require('stream');
const { seal, unseal } = require('./config');
const { UA } = require('./util');

function proxyUrl(base, url, headers = {}) {
  const name = (new URL(url).pathname.split('/').pop() || 'index.m3u8').replace(/[^A-Za-z0-9._-]/g, '') || 'x';
  return `${base}/hls/${seal({ u: url, h: headers })}/${name}`;
}

function rewritePlaylist(text, upstreamUrl, base, headers) {
  const abs = (u) => new URL(u, upstreamUrl).toString();
  return text.split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${proxyUrl(base, abs(u), headers)}"`);
    }
    return proxyUrl(base, abs(t), headers);
  }).join('\n');
}

function baseUrl(req) {
  if (process.env.PUBLIC_URL) return process.env.PUBLIC_URL.replace(/\/+$/, '');
  const proto = req.get('x-forwarded-proto') || req.protocol;
  return `${proto}://${req.get('x-forwarded-host') || req.get('host')}`;
}

async function handle(req, res) {
  let target;
  try {
    target = unseal(req.params.token);
  } catch {
    return res.status(400).end();
  }
  try {
    const upstream = await fetch(target.u, {
      headers: { 'User-Agent': UA, ...target.h },
      signal: AbortSignal.timeout(20000),
      redirect: 'follow',
    });
    if (!upstream.ok) return res.status(upstream.status).end();
    const type = upstream.headers.get('content-type') || '';
    const isPlaylist = /mpegurl|m3u8/i.test(type) || /\.m3u8(\?|$)/i.test(target.u);
    if (isPlaylist) {
      const text = await upstream.text();
      if (text.trimStart().startsWith('#EXTM3U')) {
        res.set('Content-Type', 'application/vnd.apple.mpegurl');
        res.set('Cache-Control', 'no-cache');
        return res.send(rewritePlaylist(text, upstream.url || target.u, baseUrl(req), target.h));
      }
      res.set('Content-Type', type || 'application/octet-stream');
      return res.send(text);
    }
    // Some CDNs disguise TS segments as images (fake PNG/WebP header in front). Strip it.
    if (/^image\//i.test(type)) {
      const buf = Buffer.from(await upstream.arrayBuffer());
      let i = 0;
      while (i < 1024 && !(buf[i] === 0x47 && buf[i + 188] === 0x47)) i++;
      res.set('Content-Type', 'video/mp2t');
      return res.send(i < 1024 ? buf.subarray(i) : buf);
    }
    res.set('Content-Type', type || 'video/mp2t');
    const len = upstream.headers.get('content-length');
    if (len) res.set('Content-Length', len);
    Readable.fromWeb(upstream.body).on('error', () => res.destroy()).pipe(res);
  } catch (e) {
    if (!res.headersSent) res.status(502).end();
  }
}

module.exports = { handle, proxyUrl, baseUrl };
