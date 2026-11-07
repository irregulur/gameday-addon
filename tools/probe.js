'use strict';
// Live-test one HTTP provider against current ESPN events.
//   node tools/probe.js <providerId> [--all] [--sport cfb|ufc]
// Prints scraped events, which ESPN events they match, resolves streams for up to 3
// matched ESPN events and checks the first playlist actually answers.

const espn = require('../src/espn');
const { providers, eventMatches } = require('../src/providers');
const reg = require('../src/providers');
const { UA } = require('../src/util');

const id = process.argv[2];
const sportArg = process.argv.includes('--sport') ? process.argv[process.argv.indexOf('--sport') + 1] : null;
const p = providers.find((x) => x.id === id);
if (!p) {
  console.error(`unknown provider "${id}". loaded: ${providers.map((x) => x.id).join(', ')}`);
  process.exit(1);
}

async function check(s) {
  if (s.external) return 'external page';
  try {
    const r = await fetch(s.url, { headers: { 'User-Agent': UA, ...(s.headers || {}) }, signal: AbortSignal.timeout(10000) });
    const body = Buffer.from(await r.arrayBuffer());
    const head = body.subarray(0, 7).toString();
    return `${r.status} ${r.headers.get('content-type') || ''} ${head === '#EXTM3U' ? 'M3U8 OK' : body[0] === 0x47 ? 'TS OK' : `?? ${JSON.stringify(head)}`}`;
  } catch (e) {
    return `ERR ${e.message}`;
  }
}

(async () => {
  const t0 = Date.now();
  const scraped = await p.events();
  console.log(`[${p.id}] events(): ${scraped.length} in ${Date.now() - t0}ms`);
  for (const e of scraped.slice(0, process.argv.includes('--all') ? 1e9 : 15)) {
    console.log(`  - [${e.sport}] ${e.title} ${e.start ? new Date(e.start).toISOString() : ''}`);
  }
  if (typeof p.channels === 'function') {
    const ch = await p.channels();
    console.log(`[${p.id}] channels(): ${ch.length} e.g. ${ch.slice(0, 8).map((c) => c.name).join(' | ')}`);
  }

  const all = [...await espn.getCfbEvents(), ...await espn.getUfcEvents()]
    .filter((e) => e.status.state !== 'post' && (!sportArg || e.sport === sportArg));
  const matched = all.filter((ev) => scraped.some((pe) => eventMatches(pe, ev)));
  console.log(`\nESPN events matched by scraped events: ${matched.length}/${all.length}`);
  for (const ev of matched.slice(0, 20)) {
    console.log(`  ${ev.status.state.padEnd(3)} ${ev.name}  <=  ${scraped.filter((pe) => eventMatches(pe, ev)).map((pe) => pe.title).join(' / ')}`);
  }

  const live = all.filter((e) => e.status.state === 'in');
  const targets = [...new Set([...matched.filter((e) => e.status.state === 'in'), ...matched, ...live])].slice(0, 3);
  for (const ev of targets) {
    const t = Date.now();
    const streams = await reg.streamsForEvent(ev, { sources: [p.id] }, { budgetMs: 25000 });
    console.log(`\n== ${ev.name} [${ev.status.state}] tv=${ev.broadcasts.join(',')} -> ${streams.length} streams in ${Date.now() - t}ms`);
    for (const s of streams.slice(0, 6)) {
      console.log(`   ${s.ref.type}:${s.ref.name} | ${s.title || ''} | proxy=${!!s.proxy} | ${s.url.slice(0, 100)}`);
      console.log(`      -> ${await check(s)}`);
    }
  }
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
