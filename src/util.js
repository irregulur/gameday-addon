'use strict';
// Small shared helpers: fetch with timeout, TTL cache with in-flight dedupe, concurrency map.

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

async function fetchText(url, { headers = {}, timeout = 15000, method = 'GET', body } = {}) {
  const res = await fetch(url, {
    method,
    body,
    headers: { 'User-Agent': UA, ...headers },
    signal: AbortSignal.timeout(timeout),
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${new URL(url).host}`);
  return res.text();
}

async function fetchJson(url, opts) {
  const text = await fetchText(url, opts);
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`Invalid JSON from ${new URL(url).host}`);
  }
}

// Map-based TTL cache. get(key, ttlMs, loader) returns cached value or loads it once.
// Failed loads are not cached; a stale value is served if the reload fails.
class TtlCache {
  constructor(max = 500) {
    this.max = max;
    this.map = new Map();
    this.inflight = new Map();
  }
  peek(key) {
    const hit = this.map.get(key);
    return hit && hit.exp > Date.now() ? hit.value : undefined;
  }
  set(key, value, ttlMs) {
    if (this.map.size >= this.max) this.map.delete(this.map.keys().next().value);
    this.map.set(key, { value, exp: Date.now() + ttlMs });
  }
  async get(key, ttlMs, loader) {
    const hit = this.map.get(key);
    if (hit && hit.exp > Date.now()) return hit.value;
    if (this.inflight.has(key)) return this.inflight.get(key);
    const p = (async () => {
      try {
        const value = await loader();
        this.set(key, value, ttlMs);
        return value;
      } catch (err) {
        if (hit) return hit.value; // serve stale on failure
        throw err;
      } finally {
        this.inflight.delete(key);
      }
    })();
    this.inflight.set(key, p);
    return p;
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch {
        out[idx] = undefined;
      }
    }
  });
  await Promise.all(workers);
  return out;
}

function withTimeout(promise, ms, fallback) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((resolve) => { t = setTimeout(() => resolve(fallback), ms); }),
  ]);
}

module.exports = { UA, fetchText, fetchJson, TtlCache, mapLimit, withTimeout };
