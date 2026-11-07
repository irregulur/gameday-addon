#!/usr/bin/env bash
# GameDay on Proxmox — run on the PVE host shell (not inside a VM).
# Creates a Debian 12 LXC container, installs GameDay in it and starts it.
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/irregulur/gameday-addon/main/proxmox.sh)"
#
# Optional overrides (prefix the command):
#   RAM=4096 DISK=8 CORES=4      resources
#   CTID=201                     container id (default: next free)
#   STORAGE=local-zfs            rootfs storage (default: local-lvm, local-zfs, else first)
#   BRIDGE=vmbr1                 network bridge
#   HOSTNAME=gameday PORT=7000
#   NET="ip=192.168.1.50/24,gw=192.168.1.1"   static address instead of DHCP
#   MODE=native                  install with Node + systemd inside the container (no Docker)
set -euo pipefail

REPO="https://github.com/irregulur/gameday-addon.git"
HOSTNAME="${HOSTNAME:-gameday}"
CTID="${CTID:-}"
CORES="${CORES:-2}"
RAM="${RAM:-2048}"
DISK="${DISK:-6}"
BRIDGE="${BRIDGE:-vmbr0}"
STORAGE="${STORAGE:-}"
TMSTORE="${TMSTORE:-local}"
PORT="${PORT:-7000}"
NET="${NET:-ip=dhcp}"
MODE="${MODE:-docker}"

c_g() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
c_r() { printf '\n\033[1;31mError: %s\033[0m\n' "$*" >&2; exit 1; }
cx()  { pct exec "$CTID" -- bash -c "$*"; }

[ -d /etc/pve ] && command -v pct >/dev/null || c_r "this must run on the Proxmox VE host shell"
[ "$(id -u)" -eq 0 ] || c_r "run as root"

# --- storage ---------------------------------------------------------------
if [ -z "$STORAGE" ]; then
  for s in local-lvm local-zfs; do
    if pvesm status -storage "$s" >/dev/null 2>&1; then STORAGE="$s"; break; fi
  done
fi
[ -n "$STORAGE" ] || STORAGE="$(pvesm status | awk 'NR>1 && $3=="active"{print $1; exit}')"
[ -n "$STORAGE" ] || c_r "no usable storage found — set STORAGE=..."

# --- template --------------------------------------------------------------
TNAME="$(pveam available --section system 2>/dev/null | awk '/debian-12-standard/ {print $2}' | sort -V | tail -1 || true)"
[ -n "$TNAME" ] || { pveam update; TNAME="$(pveam available --section system 2>/dev/null | awk '/debian-12-standard/ {print $2}' | sort -V | tail -1 || true)"; }
[ -n "$TNAME" ] || c_r "no debian-12-standard template available from pveam"
if ! pveam list "$TMSTORE" 2>/dev/null | grep -q "$TNAME"; then
  c_g "Downloading $TNAME"
  pveam download "$TMSTORE" "$TNAME" >/dev/null
fi
TPATH="$TMSTORE:vztmpl/$TNAME"

# --- container -------------------------------------------------------------
[ -n "$CTID" ] || CTID="$(pvesh get /cluster/nextid)"
if pct status "$CTID" >/dev/null 2>&1; then
  c_r "container $CTID already exists (set CTID=<empty id> to use another)"
fi

c_g "Creating container $CTID ($CORES vCPU, ${RAM}MB RAM, ${DISK}GB on $STORAGE)"
pct create "$CTID" "$TPATH" \
  --hostname "$HOSTNAME" \
  --cores "$CORES" --memory "$RAM" --swap 512 \
  --rootfs "$STORAGE:$DISK" \
  --net0 "name=eth0,bridge=$BRIDGE,$NET" \
  --features nesting=1,keyctl=1 \
  --unprivileged 1 --onboot 1 --start 1 >/dev/null

c_g "Waiting for the container network"
for i in $(seq 1 60); do
  if cx "getent hosts deb.debian.org" >/dev/null 2>&1; then break; fi
  sleep 2
  if [ "$i" -eq 60 ]; then c_r "container has no network — check bridge $BRIDGE / DHCP"; fi
done

c_g "Installing GameDay inside container $CTID"
cx "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git ca-certificates curl" >/dev/null
cx "rm -rf /opt/gameday && git clone --depth 1 '$REPO' /opt/gameday" >/dev/null
if [ "$MODE" = "native" ]; then
  cx "cd /opt/gameday && ./install.sh --native --port $PORT" | tail -20
else
  cx "cd /opt/gameday && ./install.sh --docker --port $PORT" | tail -20
fi

c_g "Waiting for GameDay"
for i in $(seq 1 150); do
  if cx "curl -fs -m 3 http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
  sleep 2
  if [ "$i" -eq 150 ]; then c_r "GameDay did not answer on port $PORT — run: pct exec $CTID -- docker logs -f gameday"; fi
done

IP="$(cx "ip -4 addr show eth0" | awk '/inet /{sub(/\/.*/,"",$2); print $2; exit}')"
c_g "Ready"
cat <<EOF
  Container $CTID ($HOSTNAME) at $IP
  Open:      http://${IP:-<container-ip>}:$PORT/
  Shell:     pct enter $CTID
  Logs:      pct exec $CTID -- docker logs -f gameday
  Update:    pct exec $CTID -- bash -c 'cd /opt/gameday && git pull && ./install.sh --docker --port $PORT'
  Remove:    pct stop $CTID && pct destroy $CTID

Put it behind HTTPS, then re-run the installer inside with the public address so cards and
relay links use it:  pct exec $CTID -- /opt/gameday/install.sh --docker --port $PORT --url https://gd.example.com
EOF
