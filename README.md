# GameDay · College Football & UFC

A Nuvio / Stremio addon for **US college football (FBS)** and **UFC**.
ESPN supplies the schedule, live scores and artwork; streams come from **your own Xtream Codes
IPTV** first, then from a set of free HTTP providers.

Every game/fight becomes a card with team logos (or fighter headshots), records, kick-off time
and TV network. Cards are generated server-side as 1280×720 JPEGs and update while the game is live.

## Install

### One command on the Proxmox host

Run this in the Proxmox VE **shell** (host root, not inside a VM). It creates a Debian 12 LXC
container and installs GameDay inside it:

```bash
bash -c "$(curl -fsSL https://raw.githubusercontent.com/irregulur/gameday-addon/main/proxmox.sh)"
```

It shows the usual helper-script menus (whiptail):

- **Default settings** — asks only where to put it: every pool that accepts container disks, with
  its free space (the roomiest one is preselected). Then a summary to confirm.
- **Advanced settings** — storage, disk size, CPU/RAM, container id, hostname, port, bridge,
  DHCP or a static address, and Docker vs Node+systemd inside the container.

The pool is always asked: if `whiptail` is missing the script installs it, and if there is no
terminal at all you get a numbered list instead (`TEXT=1` forces the plain prompts). Nothing is
created before you confirm.

Defaults are 2 vCPU / 2 GB RAM / 6 GB disk, DHCP on `vmbr0`, Docker inside the container. Nothing
is created until you confirm. Everything can also be set from the command line (skips the menus
when combined with `UNATTENDED=1`):

```bash
STORAGE=local-zfs DISK=12 RAM=4096 CTID=205 PORT=8080 \
  bash -c "$(curl -fsSL https://raw.githubusercontent.com/irregulur/gameday-addon/main/proxmox.sh)"
```

Other knobs: `CORES`, `BRIDGE`, `CT_HOSTNAME`, `TMSTORE` (template storage),
`NET="ip=192.168.1.50/24,gw=192.168.1.1"`, `MODE=native`. The script prints the container IP and
the log/update/remove commands.

### Inside an existing container, VM or server

`install.sh` works on Debian/Ubuntu — a Proxmox **LXC container**, a VM, or bare metal.
It installs Docker (or Node 22 + a systemd service with `--native`), generates a secret, builds
and starts everything, and is safe to re-run for updates.

**Proxmox LXC:** create a Debian 12 container with 1 GB RAM / 4 GB disk. For Docker, enable
*Options → Features → nesting=1* in the container (or use `--native`, which needs no nesting).
`proxmox.sh` does all of that for you.

```bash
git clone <this repo> gameday && cd gameday
sudo ./install.sh                                              # http://<ip>:7000
sudo ./install.sh --port 8080 --url https://gd.example.com     # behind a reverse proxy
sudo ./install.sh --native                                     # no Docker, systemd service
```

Then open the URL, fill in the form and copy the install link into **Nuvio → Settings → Addons**
(or Stremio → Addons → Install from URL).

Reverse proxy (Caddy, one line, gets you HTTPS):

```
gd.example.com {
    reverse_proxy 127.0.0.1:7000
}
```

`--url` must be the address the **client** reaches the addon at: cards and relay links are built
from it.

Manual alternative:

```bash
npm install
PUBLIC_URL=https://gameday.example.com GAMEDAY_SECRET=$(openssl rand -hex 32) \
  docker compose up -d --build
```

| Variable | Purpose |
| --- | --- |
| `PUBLIC_URL` | Public URL used in poster and relay links. Defaults to the request's `X-Forwarded-*` headers. |
| `GAMEDAY_SECRET` | Key for the encrypted config token. Set it (any long string) so links survive restarts; otherwise a key is generated in `data/secret.key`. |
| `DATA_DIR` | Cache directory (cards, key). Default `./data`. |
| `PORT` | Default `7000`. |
| `ESPN_HOST` | Override the ESPN mirror (default `https://site.web.api.espn.com`). |

The install link carries the whole configuration (including your IPTV credentials) as an
AES-256-GCM token, so nothing is stored on the server. Reopen `/<token>/configure` to edit it.

## What the user sees

Three catalogs: **College Football** (filters: Live, Today, Top 25, Power 4, per-conference),
**UFC Events**, and **UFC Fight Card** (every bout of the next/live event, one card per bout).

Streams are grouped: `📺 IPTV` entries first, then `🌐 HTTP` entries. Each entry is titled with the
provider, the channel and the quality.

IPTV matching for a game tries, in order:

1. channels whose own name contains the teams (`BYU vs Utah`),
2. the national network from ESPN's broadcast list (ABC, ESPN2, FS1, SEC Network, …) with US/unknown
   country, ranked exact-match → west/national feed → local affiliate,
3. a time-boxed EPG scan of obvious event slots (`ESPN+`, `PPV`, `UFC`, `NCAAF`, `Peacock`, …) for the
   matchup, which catches providers that name the channel generically.

## HTTP providers

Each provider is one file in `src/providers/` and is auto-loaded; enable/disable them on the
configure page.

| Provider | College football | UFC | 24/7 US networks |
| --- | --- | --- | --- |
| CDNLiveTV | event channels + networks | events | ABC, ESPN 1/2, SEC, ACC, BTN, CBS, FOX, FS1, ESPNU… |
| DaddyLive | event schedule | events | 23 channels (ABC, CBS, FOX, NBC, ESPN 1/2, FS1/2, TNT, USA…) |
| TimStreams | event channels | UFC numbered cards | – |
| PitSport | – | events | – |
| NuvioSports | 44/123 games matched | events | 13 nets (ABC, CBS, FOX, ESPN 1/2, FS1/2, ACC, BTN…) |

Provider contract (`src/providers/<id>.js`):

```js
module.exports = {
  id, name,
  events: async () => [{ key, title, home?, away?, sport: 'cfb'|'ufc'|'other', start? }],
  channels: async () => [{ key, name, country? }],          // optional 24/7 networks
  resolve: async ({ type, key, name }) => [{ url, title?, headers?, quality?, proxy?, external? }],
};
```

`proxy: true` asks the server's HLS relay (`/hls/:token/...`) to fetch the playlist and segments,
which is what makes header-locked or IP-bound links playable in players that ignore
`proxyHeaders`. The relay also strips the fake image header some CDNs put in front of TS segments.
Before streams are returned they are probed once (first bytes only, 3-minute cache) so dead links
never reach the player.

Every HTTP stream goes through the relay by default (**Configure → "Relay all HTTP streams through
this server"**): scraped CDNs check `Referer`/`Origin` and many players ignore those hints, which
shows up as a spinner that never ends. Untick it to send clients the raw CDN links instead — that
saves bandwidth but only works in players that honour `proxyHeaders`.

## Layout

```
src/server.js          addon routes, catalogs, stream assembly, configure API
src/espn.js            ESPN schedule: CFB scoreboard + UFC cards/bouts
src/match.js           team/fighter name matching, channel-name parsing, network ranking
src/xtream.js          Xtream Codes client + ranked channel matching
src/cards.js           SVG → JPEG cards (sharp), disk + memory cache
src/hls.js             HLS relay
src/providers/         HTTP stream providers (auto-loaded)
public/configure.html  configuration page
tools/probe.js         live-test a provider: node tools/probe.js <id>
```

`node tools/probe.js cdnlive --sport ufc` prints the provider's events, which current ESPN games
they match, and whether the resolved playlists actually answer.

## Notes

Scraped sources are third-party free streams: they go down, change domains and drop events
without notice, and availability differs by server IP/region. The addon never proxies video unless
it must, and it never falls back to a stream it could not verify. Xtream credentials are only ever
sent to your own provider's API, and the install link holds them encrypted in the token — keep it
to yourself and use `https`.

Nothing in this repository is affiliated with ESPN, the NCAA, the UFC or any broadcaster, and no
video content is hosted — the addon only links to streams you already have access to. You are
responsible for what you watch.

Licensed under the [MIT License](LICENSE).

## Development

```bash
npm test                      # matching + config token tests
npm run probe cdnlive         # live-test one provider against ESPN's current schedule
npm run probe daddylive --sport ufc
```

The config page and API live at `/`, `/configure`, `/api/*`; the addon itself answers at
`/<token>/manifest.json`, `/<token>/catalog/tv/<id>.json`, `/<token>/meta/tv/<id>.json`,
`/<token>/stream/tv/<id>.json`. Without a token the addon runs with defaults and no IPTV.
