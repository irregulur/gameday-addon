'use strict';
// IPTV pipeline against a fake Xtream server, so channel ranking is covered without credentials.
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const xtream = require('../src/xtream');

const b64 = (s) => Buffer.from(s).toString('base64');
const now = Math.floor(Date.now() / 1000);
const KICKOFF = now - 20 * 60; // kicked off 20 minutes ago

const CATEGORIES = [
  { category_id: '1', category_name: 'US| SPORTS' },
  { category_id: '2', category_name: 'NL| SPORTS' },
];
const STREAMS = [
  { stream_id: 101, name: 'US: ABC 7 New York', category_id: '1', epg_channel_id: 'abc7' },
  { stream_id: 102, name: 'US: ABC HD', category_id: '1', epg_channel_id: 'abc' },
  { stream_id: 103, name: 'US: ESPN 2', category_id: '1', epg_channel_id: 'espn2' },
  { stream_id: 104, name: 'NL: ESPN 2', category_id: '2', epg_channel_id: 'nl.espn2' },
  { stream_id: 105, name: 'US: NCAAF 01', category_id: '1', epg_channel_id: 'ncaaf1' },
  { stream_id: 106, name: 'US: BYU vs Utah', category_id: '1', epg_channel_id: '' },
];
const EPG = {
  abc7: 'Local News',
  abc: 'Other Game',
  espn2: 'SportsCenter',
  'nl.espn2': 'Eredivisie',
  ncaaf1: '', // served below
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  const action = url.searchParams.get('action');
  const send = (body) => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(body)); };
  if (!action) return send({ user_info: { auth: 1, status: 'Active', exp_date: '1900000000', max_connections: '2' } });
  if (action === 'get_live_categories') return send(CATEGORIES);
  if (action === 'get_live_streams') return send(STREAMS);
  if (action === 'get_short_epg') {
    const id = String(url.searchParams.get('stream_id'));
    // EPG for the event slot: our game is on "NCAAF 01".
    const title = id === '105' ? 'Florida at Georgia' : EPG[id]; // static listing: EPG is cached
    if (!title) return send({ epg_listings: [] });
    return send({
      epg_listings: [{ title: b64(title), description: b64('NCAA Football'), start_timestamp: String(KICKOFF - 1800), stop_timestamp: String(KICKOFF + 12600) }],
    });
  }
  send({});
});

let account;

test.before(async () => {
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  account = { server: `http://127.0.0.1:${server.address().port}`, username: 'u', password: 'p' };
});

test.after(() => server.close());

test('account info and channel list are read', async () => {
  const info = await xtream.accountInfo(account);
  assert.strictEqual(String(info.user_info.auth), '1');
  const channels = await xtream.getChannels(account);
  assert.strictEqual(channels.length, STREAMS.length);
  assert.strictEqual(channels.find((c) => c.id === '102').country, 'us');
  assert.strictEqual(channels.find((c) => c.id === '104').country, 'nl', 'non-US feeds are tagged');
});

test('stream urls keep the Xtream layout', () => {
  assert.match(xtream.streamUrl(account, 102), /\/live\/u\/p\/102\.m3u8$/);
  assert.match(xtream.streamUrl(account, 102, 'ts'), /\/live\/u\/p\/102\.ts$/);
});

test('channel ranking: named channel > national network > local affiliate', async () => {
  const ev = {
    sport: 'cfb',
    start: KICKOFF * 1000,
    home: { location: 'Utah', nickname: 'Utes', abbr: 'UTAH', name: 'Utah Utes' },
    away: { location: 'BYU', nickname: 'Cougars', abbr: 'BYU', name: 'BYU Cougars' },
    neutral: false,
    broadcasts: ['ABC'],
  };
  const hits = await xtream.findForEvent(account, ev);
  const ids = hits.map((h) => h.channel.id);
  assert.strictEqual(ids[0], '106', 'channel named after the game wins');
  assert.ok(ids.includes('102'), 'national ABC feed is offered');
  assert.ok(ids.includes('101'), 'local ABC affiliate is still offered, just ranked lower');
  assert.ok(!ids.includes('103') && !ids.includes('104'), 'unrelated networks are not offered');
  const rank = (id) => hits.find((h) => h.channel.id === id).rank;
  assert.ok(rank('102') > rank('101'));
});

test('event slots are identified through the guide', async () => {
  const ev = {
    sport: 'cfb',
    start: KICKOFF * 1000,
    home: { location: 'Florida', nickname: 'Gators', abbr: 'FLA', name: 'Florida Gators' },
    away: { location: 'Georgia', nickname: 'Bulldogs', abbr: 'UGA', name: 'Georgia Bulldogs' },
    neutral: true,
    broadcasts: ['PPV'],
  };
  const hits = await xtream.findForEvent(account, ev);
  const hit = hits.find((h) => h.channel.id === '105');
  assert.ok(hit, 'NCAAF 01 is found via its EPG listing');
  assert.strictEqual(hit.why, 'guide');
  assert.strictEqual(hit.programme.title, 'Florida at Georgia');
});
