'use strict';
// node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const m = require('../src/match');
const config = require('../src/config');

const cfb = {
  sport: 'cfb',
  home: { location: 'Texas', nickname: 'Longhorns', abbr: 'TEX', name: 'Texas Longhorns' },
  away: { location: 'Missouri', nickname: 'Tigers', abbr: 'MIZ', name: 'Missouri Tigers' },
  neutral: false,
};

test('college football team matching', () => {
  assert.ok(m.mentionsBothTeams('Texas Longhorns vs Missouri Tigers', cfb));
  assert.ok(m.mentionsBothTeams('Missouri vs Texas', cfb));
  assert.ok(m.mentionsBothTeams('NCAAF : TEX @ MIZ', cfb));
  assert.ok(!m.mentionsBothTeams('Texas vs Oklahoma', cfb));
  assert.ok(!m.mentionsBothTeams('Texas Tech vs Missouri', cfb), 'Texas Tech must not match Texas');
  assert.ok(!m.mentionsBothTeams('Texas A&M vs Missouri', cfb), 'Texas A&M must not match Texas');
});

test('UFC fight matching', () => {
  const ufc = { sport: 'ufc', number: '309', main: { red: { last: 'Cortes Acosta' }, blue: { last: 'Walker' } } };
  assert.ok(m.ufcMentionScore('UFC 309: Jones vs Miocic', ufc) >= 1);
  assert.ok(m.ufcMentionScore('UFC Fight Night: Cortes Acosta vs Walker', ufc) >= 3);
  assert.ok(m.ufcMentionScore('Cortes Acosta vs. Walker', ufc) >= 3);
  assert.ok(m.ufcMentionScore('PFL: Smith vs Jones', ufc) === 0);
});

test('channel names: country and quality are stripped', () => {
  assert.deepStrictEqual(m.parseChannelName('ESPN HD US').country, 'us');
  assert.strictEqual(m.parseChannelName('ESPN 2 FHD US').base.toUpperCase(), 'ESPN 2');
  assert.strictEqual(m.parseChannelName('USA: ABC').country, 'us');
  assert.strictEqual(m.qualityOf('FOX 4K').score > m.qualityOf('FOX SD').score, true);
});

test('network ranking prefers exact national feeds over affiliates', () => {
  assert.strictEqual(m.networkRank('ESPN', 'ESPN'), 10);
  assert.ok(m.networkRank('ABC', 'ABC') >= 8);
  assert.ok(m.networkRank('ESPN 2', 'ESPN2') >= 8);
  assert.strictEqual(m.networkRank('ABC 7 Chicago', 'ABC'), 3, 'local affiliate ranks below national');
  assert.ok(m.networkRank('ABC 7 Chicago', 'ABC') < m.networkRank('ABC', 'ABC'));
  assert.ok(m.networkRank('ESPN', 'ESPN2') === 0, 'ESPN is not ESPN2');
});

test('config token round-trip and sanitation', () => {
  const cfg = config.sanitize({ tz: 'Europe/Berlin', xtream: { server: 'example.com:8080/', username: ' u ', password: 'p' }, cfbScope: 'top25' });
  assert.strictEqual(cfg.xtream.server, 'http://example.com:8080');
  assert.strictEqual(cfg.xtream.username, 'u');
  assert.strictEqual(cfg.cfbScope, 'top25');
  const back = config.parseConfigSegment(config.seal(cfg));
  assert.deepStrictEqual(back, cfg);
  assert.strictEqual(config.parseConfigSegment('garbage').tz, config.DEFAULTS.tz, 'bad token falls back to defaults');
  assert.strictEqual(config.sanitize({ tz: 'Not/AZone' }).tz, config.DEFAULTS.tz);
  assert.strictEqual(config.sanitize({ xtream: { server: 'x', username: 'u' } }).xtream, null, 'incomplete login is dropped');
});
