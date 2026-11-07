#!/usr/bin/env bash
# GameDay on Proxmox — run on the PVE host shell (not inside a VM).
# Creates a Debian 12 LXC container and installs GameDay inside it.
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/irregulur/gameday-addon/main/proxmox.sh)"
#
# Shows the same kind of menus as the Proxmox helper scripts: pick the storage pool,
# disk size, resources, network and install mode.
#
# Without the menus, set any of these in front of the command (or add UNATTENDED=1):
#   STORAGE=local-zfs            pool for the container disk (default: roomiest one)
#   DISK=12 CORES=4 RAM=4096     disk size and resources
#   CTID=201 CT_HOSTNAME=gameday container id and hostname
#   BRIDGE=vmbr1 PORT=8080       bridge and port
#   NET="ip=192.168.1.50/24,gw=192.168.1.1"   static address instead of DHCP
#   MODE=native                  Node 22 + systemd inside the container instead of Docker
#   TMSTORE=local                storage that holds the Debian template
set -euo pipefail

REPO="https://github.com/irregulur/gameday-addon.git"
CT_HOSTNAME="${CT_HOSTNAME:-gameday}"   # not $HOSTNAME: bash already sets that to this machine
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
UNATTENDED="${UNATTENDED:-0}"

BT="GameDay · College Football & UFC"
GUI=0
c_g() { printf '\n\033[1;32m  ✔ %s\033[0m\n' "$*"; }
c_r() { printf '\n\033[1;31m  ✖ Error: %s\033[0m\n' "$*" >&2; exit 1; }
cx()  { pct exec "$CTID" -- bash -c "$*"; }

# ---------------------------------------------------------------- preflight
[ -d /etc/pve ] && command -v pct >/dev/null || c_r "run this on the Proxmox VE host shell"
[ "$(id -u)" -eq 0 ] || c_r "run as root"
if [ "$UNATTENDED" != "1" ] && [ -t 0 ] && [ -t 1 ] && command -v whiptail >/dev/null; then GUI=1; fi

menu()   { whiptail --backtitle "$BT" --title "$1" --menu "$2" 22 78 12 "${@:3}" 3>&1 1>&2 2>&3; }
radio()  { whiptail --backtitle "$BT" --title "$1" --radiolist "$2" 20 78 8 "${@:3}" 3>&1 1>&2 2>&3; }
input()  { whiptail --backtitle "$BT" --title "$1" --inputbox "$2" 10 70 "$3" 3>&1 1>&2 2>&3; }
confirm() { whiptail --backtitle "$BT" --title "$1" --yesno "$2" 22 78; }

is_num() { case "$1" in ''|*[!0-9]*) return 1 ;; *) return 0 ;; esac; }

storages_for() { # content type -> "name type freegb" lines
  pvesm status --content "$1" 2>/dev/null | awk 'NR>1 && $3=="active" {printf "%s %s %d\n", $1, $2, $6/1073741824}'
}
free_gb() { storages_for rootdir | awk -v s="$1" '$1==s{print $3}'; }

next_ctid() { pvesh get /cluster/nextid 2>/dev/null || echo 100; }

bridges() { ls /sys/class/net 2>/dev/null | grep -E '^(vmbr|bond)[0-9]+$' || echo vmbr0; }

# ---------------------------------------------------------------- settings
if [ "$GUI" = "1" ]; then
  printf '\033[1;36m
   GameDay · College Football & UFC
   ESPN schedule and cards, streams from your Xtream IPTV + free HTTP sources
\033[0m\n'

  choice=$(menu "Install mode" "How do you want to run GameDay?\n\n  Default settings  → only asks for the storage pool\n  Advanced settings → storage, size, CPU/RAM, network, CT id, port, mode" \
    default "Default settings" advanced "Advanced settings") || exit 0
  [ "$choice" = "advanced" ] && advanced=1 || advanced=0
else
  advanced=0
fi

# storage pool (always asked in the GUI: it must be a pool that supports containers)
if [ "$GUI" = "1" ] && [ -z "$STORAGE" ]; then
  mapfile -t rows < <(storages_for rootdir | sort -k3 -nr)
  [ "${#rows[@]}" -gt 0 ] || c_r "no storage pool accepts container disks (check Datacenter → Storage)"
  # default = the pool with the most free space
  default_store=$(printf '%s\n' "${rows[@]}" | sort -k3 -n | tail -1 | awk '{print $1}')
  items=()
  for row in "${rows[@]}"; do
    set -- $row
    tag="$1"; desc="$2 · $3 GB free"
    [ "$1" = "$default_store" ] && desc="$desc  ← recommended"
    items+=("$tag" "$desc")
  done
  STORAGE=$(menu "Storage pool" "Where should the container disk be created?\n(name · type · free space)" "${items[@]}") || exit 0
fi

if [ "$GUI" = "1" ] && [ "$advanced" = "1" ]; then
  DISK=$(input "Disk size" "Container disk size in GB (pool: $STORAGE, $(free_gb "$STORAGE") GB free)" "$DISK") || exit 0
  is_num "$DISK" || c_r "disk size must be a number"
  CORES=$(input "CPU cores" "CPU cores for the container" "$CORES") || exit 0
  is_num "$CORES" || c_r "cores must be a number"
  RAM=$(input "Memory" "RAM in MB (2048 is plenty; 1024 works)" "$RAM") || exit 0
  is_num "$RAM" || c_r "memory must be a number"
  CTID=$(input "Container ID" "Leave as is for the next free id" "$(next_ctid)") || exit 0
  is_num "$CTID" || c_r "container id must be a number"
  CT_HOSTNAME=$(input "Hostname" "Container hostname" "$CT_HOSTNAME") || exit 0
  PORT=$(input "Port" "Port GameDay listens on inside the container" "$PORT") || exit 0
  is_num "$PORT" || c_r "port must be a number"

  mapfile -t bs < <(bridges)
  if [ "${#bs[@]}" -gt 1 ]; then
    items=()
    for b in "${bs[@]}"; do
      [ "$b" = "$BRIDGE" ] && st=ON || st=OFF
      items+=("$b" "network bridge" "$st")
    done
    BRIDGE=$(radio "Bridge" "Which bridge should the container use?" "${items[@]}") || exit 0
  fi

  kind=$(radio "Network" "How should the container get its address?" \
    dhcp "DHCP from your router" "$([ "$NET" = "ip=dhcp" ] && echo ON || echo OFF)" \
    static "Static address" "$([ "$NET" = "ip=dhcp" ] && echo OFF || echo ON)") || exit 0
  if [ "$kind" = "static" ]; then
    addr=$(input "Static address" "IPv4 with prefix, e.g. 192.168.1.50/24" "192.168.1.50/24") || exit 0
    gw=$(input "Gateway" "IPv4 gateway, e.g. 192.168.1.1" "192.168.1.1") || exit 0
    NET="ip=$addr,gw=$gw"
  else
    NET="ip=dhcp"
  fi

  MODE=$(radio "Install inside the container" "How should GameDay run in the container?" \
    docker "Docker + compose (recommended, easy updates)" "$([ "$MODE" = "docker" ] && echo ON || echo OFF)" \
    native "Node 22 + systemd, no Docker" "$([ "$MODE" = "native" ] && echo ON || echo OFF)") || exit 0
fi

STORAGE="${STORAGE:-$(storages_for rootdir | sort -k3 -n | tail -1 | awk '{print $1}')}"
[ -n "$STORAGE" ] || c_r "no container storage found — set STORAGE=<pool>"
[ -n "$CTID" ] || CTID="$(next_ctid)"
is_num "$DISK" && is_num "$RAM" && is_num "$CORES" && is_num "$PORT" || c_r "settings must be numbers"
case "$MODE" in docker|native) ;; *) c_r "MODE must be docker or native" ;; esac
case "$BRIDGE" in vmbr[0-9]*|bond[0-9]*) ;; *) c_r "BRIDGE must be a bridge name such as vmbr0" ;; esac
case "$NET" in ip=dhcp|ip=?*) ;; *) c_r 'NET must be ip=dhcp or "ip=192.168.1.50/24,gw=192.168.1.1"' ;; esac
case "$CT_HOSTNAME" in ''|*[!a-zA-Z0-9-]*) c_r "hostname may only contain letters, digits and dashes" ;; esac

AVAIL="$(free_gb "$STORAGE")"
if [ -n "$AVAIL" ] && [ "$DISK" -gt "$AVAIL" ]; then
  c_r "$DISK GB requested but only $AVAIL GB free on $STORAGE"
fi

if [ "$GUI" = "1" ]; then
  confirm "Confirm" "GameDay will be installed with these settings:

  Container ID   $CTID  ($CT_HOSTNAME)
  Storage pool   $STORAGE  ($DISK GB, $AVAIL GB free)
  Resources      $CORES vCPU, ${RAM} MB RAM
  Network        $BRIDGE, $NET
  Address        http://<container ip>:$PORT/
  Runtime        $MODE inside the container
  Template       Debian 12

The container disk is created on $STORAGE. Continue?" || exit 0
fi

# ---------------------------------------------------------------- template
if ! storages_for vztmpl | awk '{print $1}' | grep -qx "$TMSTORE"; then
  TMSTORE="$(storages_for vztmpl | awk '{print $1; exit}')"
fi
[ -n "$TMSTORE" ] || c_r "no storage accepts container templates (check Datacenter → Storage)"

TNAME="$(pveam available --section system 2>/dev/null | awk '/debian-12-standard/ {print $2}' | sort -V | tail -1 || true)"
if [ -z "$TNAME" ]; then
  pveam update >/dev/null 2>&1 || true
  TNAME="$(pveam available --section system 2>/dev/null | awk '/debian-12-standard/ {print $2}' | sort -V | tail -1 || true)"
fi
[ -n "$TNAME" ] || c_r "no debian-12-standard template available from pveam"
if ! pveam list "$TMSTORE" 2>/dev/null | grep -q "$TNAME"; then
  printf '\n  Downloading %s to %s…\n' "$TNAME" "$TMSTORE"
  pveam download "$TMSTORE" "$TNAME" >/dev/null || c_r "template download failed (storage $TMSTORE)"
fi

# ---------------------------------------------------------------- container
if pct status "$CTID" >/dev/null 2>&1; then
  c_r "container $CTID already exists — pick another id (CTID=...)"
fi

printf '\n  Creating container %s on %s…\n' "$CTID" "$STORAGE"
pct create "$CTID" "$TMSTORE:vztmpl/$TNAME" \
  --hostname "$CT_HOSTNAME" \
  --cores "$CORES" --memory "$RAM" --swap 512 \
  --rootfs "$STORAGE:$DISK" \
  --net0 "name=eth0,bridge=$BRIDGE,$NET" \
  --features nesting=1,keyctl=1 \
  --unprivileged 1 --onboot 1 --start 1 >/dev/null
c_g "container $CTID created on $STORAGE"

printf '  Waiting for the container network…\n'
for i in $(seq 1 60); do
  if cx "getent hosts deb.debian.org" >/dev/null 2>&1; then break; fi
  sleep 2
  if [ "$i" -eq 60 ]; then c_r "container has no network — check bridge $BRIDGE / DHCP"; fi
done
c_g "network up"

printf '  Installing GameDay inside the container…\n'
cx "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git ca-certificates curl" >/dev/null
cx "rm -rf /opt/gameday && git clone --depth 1 '$REPO' /opt/gameday" >/dev/null
if [ "$MODE" = "native" ]; then
  cx "cd /opt/gameday && ./install.sh --native --port $PORT" | tail -20
  RUNLOG="journalctl -u gameday -f"
else
  cx "cd /opt/gameday && ./install.sh --docker --port $PORT" | tail -20
  RUNLOG="docker logs -f gameday"
fi

printf '  Waiting for GameDay to answer…\n'
for i in $(seq 1 150); do
  if cx "curl -fs -m 3 http://127.0.0.1:$PORT/health" >/dev/null 2>&1; then break; fi
  sleep 2
  if [ "$i" -eq 150 ]; then c_r "GameDay did not start — check: pct exec $CTID -- $RUNLOG"; fi
done

IP="$(cx "ip -4 addr show eth0" | awk '/inet /{sub(/\/.*/,"",$2); print $2; exit}')"

echo
if command -v whiptail >/dev/null && [ "$GUI" = "1" ]; then
  whiptail --backtitle "$BT" --title "Done" --msgbox "GameDay is running.

  Container   $CTID ($CT_HOSTNAME) on $STORAGE
  Open        http://${IP}:$PORT/

  Addon link  Open it, enter your Xtream IPTV login,
              then copy the install link into Nuvio → Settings → Addons.

  Shell       pct enter $CTID
  Logs        pct exec $CTID -- $RUNLOG
  Update      pct exec $CTID -- bash -c 'cd /opt/gameday && git pull && ./install.sh --$MODE --port $PORT'
  Remove      pct stop $CTID && pct destroy $CTID

  For HTTPS, put it behind a reverse proxy and re-run the installer
  inside with --url https://your.domain" 26 78
else
  cat <<EOF
  GameDay is running on container $CTID ($CT_HOSTNAME, storage $STORAGE)

  Open:      http://${IP}:$PORT/
  Shell:     pct enter $CTID
  Logs:      pct exec $CTID -- $RUNLOG
  Update:    pct exec $CTID -- bash -c 'cd /opt/gameday && git pull && ./install.sh --$MODE --port $PORT'
  Remove:    pct stop $CTID && pct destroy $CTID

  For HTTPS, put it behind a reverse proxy and re-run the installer inside with
  --url https://your.domain so cards and relay links use the public address.
EOF
fi
