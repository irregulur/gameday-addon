'use strict';
// Name matching shared by the IPTV (Xtream) and HTTP provider pipelines.
//  - team / fighter mentions in free text (channel names, EPG titles, scraper titles)
//  - TV network names (ESPN "broadcasts") -> channel names

function fold(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, '')            // a&m -> am
    .replace(/\bst\.(?=\s|$)/g, 'state')
    .replace(/[^a-z0-9+]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Words that turn "Texas" into a different school when they follow / precede it.
const AFTER_QUALIFIERS = new Set(['state', 'st', 'tech', 'am', 'christian', 'international', 'atlantic', 'southern', 'oh', 'ohio', 'eastern', 'western', 'northern', 'central', 'san', 'el', 'pacific', 'baptist', 'mississippi', 'monroe', 'lafayette']);
const BEFORE_QUALIFIERS = new Set(['north', 'south', 'east', 'west', 'central', 'northern', 'southern', 'eastern', 'western', 'middle', 'new', 'old', 'coastal', 'ul', 'ut']);
const GENERIC_ALIASES = new Set(['state', 'tech', 'university', 'college', 'football', 'ncaa', 'the']);

// Precompiled matcher for one alias: word-boundary match that rejects qualifier clashes.
function aliasMatcher(alias) {
  const a = fold(alias);
  if (!a || a.length < 3 || GENERIC_ALIASES.has(a)) return null;
  const re = new RegExp(`(?:^|\\s)${escapeRe(a)}(?=\\s|$)`, 'g');
  return (text) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const start = m.index + (m[0].startsWith(' ') ? 1 : 0);
      const before = text.slice(0, start).trim().split(' ').pop();
      const after = text.slice(start + a.length).trim().split(' ')[0];
      const clashAfter = after && AFTER_QUALIFIERS.has(after) && !a.split(' ').includes(after);
      const clashBefore = before && BEFORE_QUALIFIERS.has(before);
      if (!clashAfter && !clashBefore) return true;
    }
    return false;
  };
}

const teamCache = new WeakMap();
function teamMatchers(team) {
  if (teamCache.has(team)) return teamCache.get(team);
  const aliases = new Set([team.location, team.short, team.name, `${team.location} ${team.nickname}`]);
  // Common short forms ESPN does not provide.
  const extra = TEAM_EXTRA_ALIASES[fold(team.location)];
  if (extra) extra.forEach((x) => aliases.add(x));
  const ms = [...aliases].map(aliasMatcher).filter(Boolean);
  // Abbreviations only when 3+ letters (LSU, BYU, UCF, SMU), matched case-sensitively on raw text.
  const abbr = team.abbr && team.abbr.length >= 3 && /^[A-Z&]+$/.test(team.abbr) ? new RegExp(`\\b${escapeRe(team.abbr)}\\b`) : null;
  const fn = (folded, raw) => ms.some((m) => m(folded)) || (abbr ? abbr.test(raw) : false);
  teamCache.set(team, fn);
  return fn;
}

const TEAM_EXTRA_ALIASES = {
  'ole miss': ['mississippi'],
  'miami': ['miami fl', 'miami hurricanes'],
  'miami oh': ['miami ohio', 'miami redhawks', 'miami (oh)'],
  'pittsburgh': ['pitt'],
  'connecticut': ['uconn'],
  'massachusetts': ['umass'],
  'southern methodist': ['smu'],
  'brigham young': ['byu'],
  'louisiana state': ['lsu'],
  'central florida': ['ucf'],
  'texas el paso': ['utep'],
  'texas san antonio': ['utsa'],
  'nevada las vegas': ['unlv'],
  'hawaii': ["hawai'i", 'hawaii rainbow warriors'],
  'app state': ['appalachian state'],
  'appalachian state': ['app state'],
  'southern miss': ['southern mississippi'],
  'nc state': ['north carolina state', 'n c state'],
  'florida international': ['fiu'],
  'florida atlantic': ['fau'],
  'usc': ['southern california'],
  'tcu': ['texas christian'],
  'umass': ['massachusetts'],
  'uconn': ['connecticut'],
};

function mentionsTeam(text, team) {
  return teamMatchers(team)(fold(text), String(text || ''));
}

function mentionsBothTeams(text, ev) {
  const f = fold(text);
  const raw = String(text || '');
  return teamMatchers(ev.home)(f, raw) && teamMatchers(ev.away)(f, raw);
}

// UFC: event number ("UFC 334"), or both main-event surnames, or "fight night" + one surname.
function ufcMentionScore(text, ev) {
  const f = fold(text);
  if (!f) return 0;
  const has = (s) => {
    const m = aliasMatcher(s);
    return m ? m(f) : false;
  };
  let score = 0;
  if (ev.number && new RegExp(`\\bufc\\s*${ev.number}\\b`).test(f)) score += 3;
  const red = ev.main.red.last, blue = ev.main.blue.last;
  const r = has(red), b = has(blue);
  if (r && b) score += 3;
  else if (r || b) score += 1;
  if (/\bufc\b/.test(f)) score += 1;
  if (/\bfight night\b/.test(f) && !ev.number) score += 1;
  return score;
}

// ---------- TV networks ----------

const NETWORK_ALIASES = {
  abc: ['abc'],
  espn: ['espn'],
  espn2: ['espn2', 'espn 2'],
  espnu: ['espnu', 'espn u'],
  espnews: ['espnews', 'espn news'],
  'espn+': ['espn+', 'espn plus'],
  'sec network': ['sec network', 'secn', 'sec', 'espn sec network'],
  'sec network+': ['sec network+', 'secn+'],
  'acc network': ['acc network', 'accn', 'acc'],
  accnx: ['accnx', 'acc network extra'],
  btn: ['big ten network', 'btn', 'b1g network', 'big 10 network'],
  cbs: ['cbs'],
  cbssn: ['cbs sports network', 'cbssn', 'cbs sports'],
  fox: ['fox'],
  fs1: ['fs1', 'fox sports 1'],
  fs2: ['fs2', 'fox sports 2'],
  nbc: ['nbc'],
  peacock: ['peacock'],
  tnt: ['tnt', 'tnt usa'],
  trutv: ['trutv', 'tru tv'],
  cw: ['cw', 'the cw'],
  'usa net': ['usa network', 'usa'],
  'paramount+': ['paramount+', 'paramount plus', 'paramount'],
  'disney+': [],
  'mw+': [],
  'big 12 now': [],
};

// Networks whose numbered variants are local affiliates (e.g. "ABC 7 New York").
const AFFILIATE_NETWORKS = new Set(['abc', 'cbs', 'fox', 'nbc', 'cw']);

const COUNTRY_TAGS = /^(?:\[|\()?\s*(us|usa|uk|gb|ca|can|au|aus|mx|br|ar|es|fr|de|it|pt|nl|in|ie|nz|za|latam|lat|ar|co|cl|pe|pl|tr|ae|ar|ex[- ]?yu)\s*(?:\]|\))?\s*(?:[:|\-»▎┃•]+|\s)\s*/i;
const QUALITY_WORDS = /\b(hd|fhd|uhd|sd|4k|8k|hevc|h265|h264|1080p?|720p?|2160p?|50fps|60fps|fps|raw|backup|vip|plus\s*hd|\u1d34\u1d30|ᴴᴰ|ʰᵈ|east|feed|multi|audio|eng|english|\d+fps)\b/gi;

function parseChannelName(rawName) {
  let s = String(rawName || '').trim();
  let country = '';
  // Strip one or two leading country tags: "US: ", "|US| ", "USA ▎", "(US) ".
  for (let i = 0; i < 2; i++) {
    s = s.replace(/^[|┃▎#★*\s]+/, '');
    const m = COUNTRY_TAGS.exec(s);
    if (!m) break;
    country = country || m[1].toLowerCase();
    s = s.slice(m[0].length);
  }
  // Trailing tags: "ESPN HD US", "Sky Sports (UK)"
  const tail = /\s+[([]?(US|USA|UK|GB|CA|AU|MX|BR|ES|FR|DE|IT|PT|NL|IE|NZ|ZA|IN|DK|SE|NO|PL|TR|AR)[)\]]?\s*$/.exec(s);
  if (tail) {
    country = country || tail[1].toLowerCase();
    s = s.slice(0, tail.index);
  }
  if (country === 'usa') country = 'us';
  if (country === 'gb') country = 'uk';
  const base = fold(s.replace(QUALITY_WORDS, ' '));
  return { country, base };
}

// Returns rank (higher better) if the channel carries the network, else 0.
function networkRank(rawBase, network) {
  const channelBase = fold(rawBase);
  const key = fold(network).replace(/ /g, ' ');
  const aliases = NETWORK_ALIASES[key] || NETWORK_ALIASES[String(network).toLowerCase()] || [fold(network)];
  for (const alias of aliases) {
    const a = fold(alias);
    if (!a) continue;
    if (channelBase === a) return 10;
    // "espn west", "fox 5 new york", "abc 7 kabc"
    if (channelBase.startsWith(a + ' ')) {
      const rest = channelBase.slice(a.length + 1);
      if (/^(west|pacific|national|network|channel|tv|the)\b/.test(rest)) return 8;
      if (AFFILIATE_NETWORKS.has(a) && /^\d{1,2}\b/.test(rest)) return 3;
      if (AFFILIATE_NETWORKS.has(a) && /^[kw][a-z]{2,3}\b/.test(rest)) return 3; // call signs
    }
  }
  return 0;
}

function knownNetwork(network) {
  const key = fold(network);
  return NETWORK_ALIASES[key] ? NETWORK_ALIASES[key].length > 0 : true;
}

// Quality hint from a raw channel name.
function qualityOf(name) {
  const s = String(name || '');
  if (/\b(4k|uhd|2160p?)\b/i.test(s)) return { label: '4K', score: 4 };
  if (/\b(fhd|1080p?)\b/i.test(s)) return { label: 'FHD', score: 3 };
  if (/\b(hd|720p?)\b|ᴴᴰ/i.test(s)) return { label: 'HD', score: 2 };
  if (/\bsd\b/i.test(s)) return { label: 'SD', score: 0 };
  return { label: '', score: 1 };
}

module.exports = {
  fold,
  mentionsTeam,
  mentionsBothTeams,
  ufcMentionScore,
  parseChannelName,
  networkRank,
  knownNetwork,
  qualityOf,
  NETWORK_ALIASES,
};
