#!/usr/bin/env bash
# Fly Overhead feeder installer.
#
# Usage:
#   curl -fsSL https://flyoverhead.com/install.sh | sudo bash
#
# FEEDER_INSTALL_MODE=anonymous|pair|skip|interactive
#   (default: interactive when a terminal is attached, else anonymous)
#
# Idempotent. Two receiver modes, chosen automatically:
#   - Client mode: an existing decoder (PiAware / dump1090-fa / readsb / tar1090)
#     is already on the box — we attach as a client, no conflict.
#   - Standalone mode: no decoder but an RTL-SDR dongle is plugged in — we
#     install readsb to drive the SDR and emit BEAST on localhost:30005, then
#     attach to it exactly like client mode. The box becomes a self-contained
#     receiver with no other ADS-B software required.
set -euo pipefail

FEEDER_API_URL="${FEEDER_API_URL:-https://flyoverhead.com}"
# Prebuilt dist tarballs on the R2 feeder bucket (see feeder-dist-publish.yml).
FEEDER_CDN_URL="${FEEDER_CDN_URL:-https://feeder.flyoverhead.com}"
INSTALL_DIR="${INSTALL_DIR:-/opt/fly-overhead-feeder}"
SERVICE_NAME="fly-overhead-feeder"
SERVICE_USER="${SERVICE_USER:-flyoverhead}"
# Pin config to one absolute path for both the pairing write and the service
# read. configPath() otherwise derives from uid/$HOME, which diverge between
# `sudo -u flyoverhead` (writes under the invoking shell's $HOME) and the
# systemd unit ($HOME=/var/lib + ProtectHome), silently splitting the two.
CONFIG_PATH="/var/lib/fly-overhead-feeder/config.json"
# Set FEEDER_SKIP_DECODER_INSTALL=1 to never auto-install readsb (abort instead).
SKIP_DECODER_INSTALL="${FEEDER_SKIP_DECODER_INSTALL:-0}"
READSB_INSTALL_URL="${READSB_INSTALL_URL:-https://github.com/wiedehopf/adsb-scripts/raw/master/readsb-install.sh}"
# interactive: prompt the user to feed anonymously or pair to their account.
# anonymous: register and start feeding without an account.
# pair: block until the user approves a code at /feeders/pair.
# skip: keep existing config on re-install (fails if not yet registered).
# Default to the prompt when a controlling terminal exists — `curl ... | sudo
# bash` still exposes /dev/tty, so the choice isn't a separate manual step.
# Headless/automated installs (no tty) fall back to anonymous so they never block.
FEEDER_INSTALL_MODE="${FEEDER_INSTALL_MODE:-}"
if [[ -z "$FEEDER_INSTALL_MODE" ]]; then
  if [[ -r /dev/tty ]]; then
    FEEDER_INSTALL_MODE="interactive"
  else
    FEEDER_INSTALL_MODE="anonymous"
  fi
fi
# Set FEEDER_FORCE_SOURCE_BUILD=1 to skip prebuilt CDN tarballs.
FEEDER_FORCE_SOURCE_BUILD="${FEEDER_FORCE_SOURCE_BUILD:-0}"
FEEDER_UUID_FILE="/var/lib/fly-overhead-feeder/feeder.uuid"
FEEDER_BOOT_UUID="/boot/fly-overhead-feeder-uuid"

require_root() {
  if [[ $EUID -ne 0 ]]; then
    echo "install.sh must run as root (use sudo)." >&2
    exit 1
  fi
}

read_tty() {
  local prompt="$1"; local _var="$2"; local default="${3:-}"
  if [[ -r /dev/tty ]]; then
    # shellcheck disable=SC2229
    read -r -p "$prompt" "$_var" </dev/tty
  else
    # shellcheck disable=SC2229
    read -r -p "$prompt" "$_var"
  fi
  if [[ -z "${!_var}" && -n "$default" ]]; then
    printf -v "$_var" '%s' "$default"
  fi
}

step() { printf '\n==> %s\n' "$*"; }

detect_existing_source() {
  if (echo > /dev/tcp/127.0.0.1/30005) 2>/dev/null; then
    echo "beast:127.0.0.1:30005"
    return
  fi
  for url in \
    http://127.0.0.1:8080/data/aircraft.json \
    http://127.0.0.1:8080/tar1090/data/aircraft.json \
    http://127.0.0.1:8080/skyaware/data/aircraft.json \
  ; do
    if curl -fsS --max-time 2 "$url" >/dev/null 2>&1; then
      echo "json:$url"
      return
    fi
  done
  echo ""
}

# Poll for a local decoder coming online (readsb takes a few seconds to bind
# 30005 after install). Echoes the detected source or "" after the timeout.
wait_for_source() {
  local deadline=$(( $(date +%s) + ${1:-20} ))
  local found=""
  while [[ $(date +%s) -lt $deadline ]]; do
    found=$(detect_existing_source)
    [[ -n "$found" ]] && { echo "$found"; return; }
    sleep 2
  done
  echo ""
}

# RTL2832U-based dongles (RTL-SDR v3/v4, FlightAware Pro Stick, Nooelec, etc.)
# all enumerate under Realtek vendor 0bda. Scan sysfs so we don't depend on
# lsusb/usbutils being present pre-install.
detect_rtlsdr() {
  local vendor product dev
  for dev in /sys/bus/usb/devices/*; do
    [[ -r "$dev/idVendor" && -r "$dev/idProduct" ]] || continue
    vendor=$(cat "$dev/idVendor")
    product=$(cat "$dev/idProduct")
    if [[ "$vendor" == "0bda" && ( "$product" == "2832" || "$product" == "2838" || "$product" == "2837" ) ]]; then
      return 0
    fi
  done
  return 1
}

# Standalone mode: install readsb (wiedehopf's ecosystem-standard installer,
# which also handles RTL-SDR drivers and the dvb_usb_rtl28xxu kernel blacklist)
# to drive the SDR. readsb's default config serves BEAST on localhost:30005,
# which our forwarder then consumes — no extra wiring.
install_readsb() {
  step "no decoder found, but an RTL-SDR is present — installing readsb (standalone receiver)"
  if command -v readsb >/dev/null 2>&1 || [[ -x /usr/bin/readsb ]]; then
    echo "    readsb already installed; (re)starting it"
    systemctl restart readsb 2>/dev/null || true
    return
  fi
  bash -c "$(curl -fsSL "$READSB_INSTALL_URL")"
}

ensure_node() {
  if command -v node >/dev/null 2>&1; then
    local major
    # An arch-mismatched node (e.g. an ARMv7 build on an ARMv6 core) SIGILLs on
    # `node --version`, printing nothing; treat that as "needs (re)install".
    major=$(node --version 2>/dev/null | sed 's/^v\([0-9]*\).*/\1/')
    if [[ "${major:-0}" -ge 20 ]]; then return; fi
  fi
  step "installing Node.js 20"
  # NodeSource dropped armhf packaging for Node 20+; install from a nodejs.org
  # tarball instead. Raspberry Pi OS 32-bit reports armhf via
  # `dpkg --print-architecture` for BOTH ARMv6 (Pi Zero/Zero W/1) and ARMv7+
  # boards, but their Node builds are NOT interchangeable — an ARMv7 binary is
  # an illegal instruction on an ARMv6 core. Disambiguate on the real CPU.
  local arch cpu node_ver="v20.18.3"
  arch=$(dpkg --print-architecture 2>/dev/null || uname -m)
  cpu=$(uname -m)
  if [[ "$cpu" == "armv6l" ]]; then
    # Official Node dropped ARMv6; the community unofficial-builds tarball is
    # the standard way to run modern Node on a Pi Zero/Zero W/1.
    curl -fsSL "https://unofficial-builds.nodejs.org/download/release/${node_ver}/node-${node_ver}-linux-armv6l.tar.xz" \
      -o /tmp/node-arm.tar.xz
    tar -xJf /tmp/node-arm.tar.xz -C /opt
    ln -sf "/opt/node-${node_ver}-linux-armv6l/bin/node" /usr/local/bin/node
    ln -sf "/opt/node-${node_ver}-linux-armv6l/bin/npm" /usr/local/bin/npm
    rm -f /tmp/node-arm.tar.xz
  elif [[ "$arch" == "armhf" || "$arch" == "armv7l" ]]; then
    curl -fsSL "https://nodejs.org/dist/${node_ver}/node-${node_ver}-linux-armv7l.tar.xz" \
      -o /tmp/node-arm.tar.xz
    tar -xJf /tmp/node-arm.tar.xz -C /opt
    ln -sf "/opt/node-${node_ver}-linux-armv7l/bin/node" /usr/local/bin/node
    ln -sf "/opt/node-${node_ver}-linux-armv7l/bin/npm" /usr/local/bin/npm
    rm -f /tmp/node-arm.tar.xz
  elif [[ -f /etc/debian_version ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  elif [[ -f /etc/redhat-release ]]; then
    curl -fsSL https://rpm.nodesource.com/setup_20.x | bash -
    yum install -y nodejs
  else
    echo "unsupported distro — install Node.js 20+ manually then re-run." >&2
    exit 1
  fi
}

ensure_user() {
  if ! id -u "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --home-dir /var/lib/fly-overhead-feeder --shell /usr/sbin/nologin "$SERVICE_USER"
  fi
  mkdir -p /var/lib/fly-overhead-feeder
  chown -R "$SERVICE_USER:$SERVICE_USER" /var/lib/fly-overhead-feeder
}

detect_feeder_arch() {
  local arch
  arch=$(dpkg --print-architecture 2>/dev/null || uname -m)
  case "$arch" in
    amd64|x86_64) echo "linux-amd64" ;;
    arm64|aarch64) echo "linux-arm64" ;;
    armhf|armv7l|armv6l) echo "linux-armv7l" ;;
    *) echo "linux-${arch}" ;;
  esac
}

has_dist() {
  [[ -f "${INSTALL_DIR}/dist/index.js" ]]
}

install_dist_layout() {
  local tarball="$1"
  mkdir -p "$INSTALL_DIR"
  chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
  rm -rf "${INSTALL_DIR}/.pkg"
  mkdir -p "${INSTALL_DIR}/.pkg"
  tar -xzf "$tarball" -C "${INSTALL_DIR}/.pkg"
  chown -R "$SERVICE_USER:$SERVICE_USER" "${INSTALL_DIR}/.pkg"
  ln -sfn "${INSTALL_DIR}/.pkg/dist" "${INSTALL_DIR}/dist"
  ln -sfn "${INSTALL_DIR}/.pkg/node_modules" "${INSTALL_DIR}/node_modules"
  [[ -f "${INSTALL_DIR}/dist/index.js" ]] \
    || { echo "extracted package has no ${INSTALL_DIR}/dist/index.js" >&2; exit 1; }
}

fetch_prebuilt_dist() {
  local arch="$1"
  local url="${FEEDER_CDN_URL%/}/dist/${arch}.tar.gz"
  local tmp="/tmp/feeder-prebuilt-${arch}.tar.gz"
  curl -fsSL "$url" -o "$tmp"
  install_dist_layout "$tmp"
  rm -f "$tmp"
  echo "    dist:    prebuilt ${arch} from ${FEEDER_CDN_URL}"
}

fetch_source_dist() {
  mkdir -p "$INSTALL_DIR"
  chown "$SERVICE_USER:$SERVICE_USER" "$INSTALL_DIR"
  local src_dir="$INSTALL_DIR/.src"
  local tarball_url
  for tarball_url in \
    "${FEEDER_CDN_URL%/}/dist/feeder-source.tar.gz" \
    "${FEEDER_API_URL%/}/feeder-source.tar.gz"
  do
    if curl -fsSL "$tarball_url" -o /tmp/feeder-source.tar.gz 2>/dev/null; then
      echo "    source:  ${tarball_url}"
      break
    fi
  done
  [[ -f /tmp/feeder-source.tar.gz ]] \
    || { echo "could not download feeder source tarball" >&2; exit 1; }
  rm -rf "$src_dir"
  mkdir -p "$src_dir"
  tar -xzf /tmp/feeder-source.tar.gz -C "$src_dir" --strip-components=1
  rm -f /tmp/feeder-source.tar.gz
  chown -R "$SERVICE_USER:$SERVICE_USER" "$src_dir"
  step "installing feeder dependencies (~1 minute on a Pi)"
  sudo -u "$SERVICE_USER" bash -lc "cd '$src_dir' && npm install --no-audit --no-fund"
  step "compiling TypeScript"
  sudo -u "$SERVICE_USER" bash -lc "cd '$src_dir' && npm run build"
  ln -sfn "$src_dir/dist" "$INSTALL_DIR/dist"
  ln -sfn "$src_dir/node_modules" "$INSTALL_DIR/node_modules"
  [[ -f "$INSTALL_DIR/dist/index.js" ]] \
    || { echo "build produced no $INSTALL_DIR/dist/index.js" >&2; exit 1; }
  echo "    dist:    built from source on this machine"
}

fetch_dist() {
  local arch
  arch=$(detect_feeder_arch)
  if [[ "$FEEDER_FORCE_SOURCE_BUILD" != "1" ]]; then
    if fetch_prebuilt_dist "$arch" 2>/dev/null; then
      return
    fi
    echo "    note:    no prebuilt ${arch} on CDN yet, compiling from source"
  fi
  fetch_source_dist
}

json_get() {
  JSON_FIELD="$1" python3 -c 'import json,sys,os
field=os.environ["JSON_FIELD"]
data=json.load(sys.stdin)
for part in field.split("."):
  if not isinstance(data, dict):
    data=None
    break
  data=data.get(part)
print("" if data is None else data)' 2>/dev/null
}

ensure_feeder_uuid() {
  if [[ -n "${FLY_OVERHEAD_FEEDER_UUID:-}" ]]; then
    printf '%s\n' "${FLY_OVERHEAD_FEEDER_UUID}"
    return
  fi
  local uuid=""
  if [[ -s "$FEEDER_UUID_FILE" ]]; then
    uuid=$(tr -d '[:space:]' <"$FEEDER_UUID_FILE")
  elif [[ -s "$FEEDER_BOOT_UUID" ]]; then
    uuid=$(tr -d '[:space:]' <"$FEEDER_BOOT_UUID")
  fi
  if [[ -z "$uuid" ]]; then
    if command -v uuidgen >/dev/null 2>&1; then
      uuid=$(uuidgen)
    else
      uuid=$(cat /proc/sys/kernel/random/uuid)
    fi
  fi
  uuid=$(printf '%s' "$uuid" | tr '[:upper:]' '[:lower:]')
  mkdir -p "$(dirname "$FEEDER_UUID_FILE")"
  printf '%s\n' "$uuid" >"$FEEDER_UUID_FILE"
  chmod 600 "$FEEDER_UUID_FILE"
  chown "$SERVICE_USER:$SERVICE_USER" "$FEEDER_UUID_FILE"
  if [[ -w /boot ]] 2>/dev/null; then
    printf '%s\n' "$uuid" >"$FEEDER_BOOT_UUID" 2>/dev/null || true
  fi
  printf '%s\n' "$uuid"
}

bootstrap_write_config() {
  local api_key="$1" feeder_id="$2" feeder_name="$3"
  mkdir -p "$(dirname "$CONFIG_PATH")"
  FEEDER_API_URL="$FEEDER_API_URL" \
  FEEDER_CFG_API_KEY="$api_key" \
  FEEDER_CFG_ID="$feeder_id" \
  FEEDER_CFG_NAME="$feeder_name" \
  FEEDER_CFG_PATH="$CONFIG_PATH" \
  python3 <<'PY'
import json, os
path = os.environ["FEEDER_CFG_PATH"]
cfg = {
    "apiUrl": os.environ["FEEDER_API_URL"],
    "apiKey": os.environ["FEEDER_CFG_API_KEY"],
    "feederId": os.environ["FEEDER_CFG_ID"],
    "feederName": os.environ["FEEDER_CFG_NAME"],
}
with open(path, "w", encoding="utf-8") as fh:
    json.dump(cfg, fh, indent=2)
    fh.write("\n")
os.chmod(path, 0o600)
PY
  chown "$SERVICE_USER:$SERVICE_USER" "$CONFIG_PATH"
}

bootstrap_register_anonymous() {
  local uuid feeder_name resp api_key
  uuid=$(ensure_feeder_uuid)
  feeder_name="feeder-$(hostname -s 2>/dev/null || hostname)"
  step "registering feeder (anonymous — no account required)"
  resp=$(curl -fsSL -X POST "${FEEDER_API_URL%/}/api/feeder/register" \
    -H 'content-type: application/json' \
    -d "$(printf '{"feeder_id":"%s","name":"%s"}' "$uuid" "$feeder_name")")
  JSON_FIELD=api_key api_key=$(printf '%s' "$resp" | json_get api_key)
  [[ -n "$api_key" ]] || { echo "register failed: $resp" >&2; exit 1; }
  bootstrap_write_config "$api_key" "$uuid" "$feeder_name"
  echo ""
  echo "  Feeding anonymously. Aircraft should appear on the map within ~30s."
  print_link_account_help
}

bootstrap_pair_flow() {
  local uuid hostname resp code verification_url status api_key
  uuid=$(ensure_feeder_uuid)
  hostname=$(hostname)
  step "linking feeder to your account"
  resp=$(curl -fsSL -X POST "${FEEDER_API_URL%/}/api/feeder/pair/start" \
    -H 'content-type: application/json' \
    -d "$(printf '{"uuid":"%s","hostname":"%s"}' "$uuid" "$hostname")")
  JSON_FIELD=code code=$(printf '%s' "$resp" | json_get code)
  JSON_FIELD=verification_url verification_url=$(printf '%s' "$resp" | json_get verification_url)
  [[ -n "$code" ]] || { echo "pair/start failed: $resp" >&2; exit 1; }
  echo ""
  echo "  To link this feeder to your Fly Overhead account:"
  echo "    1. Visit ${verification_url:-${FEEDER_API_URL%/}/feeders/pair}"
  echo "    2. Enter code: ${code}"
  echo ""
  echo "  (Waiting — install continues downloading software in the background.)"
  echo ""
  local deadline=$(( $(date +%s) + 900 ))
  while [[ $(date +%s) -lt $deadline ]]; do
    sleep 3
    resp=$(curl -fsSL -G "${FEEDER_API_URL%/}/api/feeder/pair/check" --data-urlencode "uuid=${uuid}")
    JSON_FIELD=status status=$(printf '%s' "$resp" | json_get status)
    if [[ "$status" == "pending" ]]; then
      continue
    fi
    if [[ "$status" == "expired" ]]; then
      echo "pairing code expired — re-run with FEEDER_INSTALL_MODE=pair" >&2
      exit 1
    fi
    if [[ "$status" == "approved" ]]; then
      JSON_FIELD=api_key api_key=$(printf '%s' "$resp" | json_get api_key)
      JSON_FIELD=name feeder_name=$(printf '%s' "$resp" | json_get name)
      [[ -n "$api_key" ]] || { echo "pair approved but no api_key in response" >&2; exit 1; }
      bootstrap_write_config "$api_key" "$uuid" "${feeder_name:-$hostname}"
      echo "  Paired successfully."
      return
    fi
  done
  echo "pairing timed out — re-run with FEEDER_INSTALL_MODE=pair" >&2
  exit 1
}

is_feeder_configured() {
  [[ -s "$CONFIG_PATH" ]] \
    && grep -q '"apiKey"[[:space:]]*:[[:space:]]*"fd_' "$CONFIG_PATH" 2>/dev/null
}

feeder_node() {
  sudo -u "$SERVICE_USER" \
    FEEDER_API_URL="$FEEDER_API_URL" \
    FLY_OVERHEAD_FEEDER_CONFIG="$CONFIG_PATH" \
    node "$INSTALL_DIR/dist/index.js" "$@"
}

print_link_account_help() {
  echo ""
  echo "  Link to your Fly Overhead account (optional):"
  echo "    1. Sign in at ${FEEDER_API_URL%/}/feeders/pair"
  echo "    2. On this machine, run:"
  echo "       sudo FLY_OVERHEAD_FEEDER_CONFIG=${CONFIG_PATH} \\"
  echo "         FEEDER_API_URL=${FEEDER_API_URL} \\"
  echo "         node ${INSTALL_DIR}/dist/index.js pair"
  echo "    3. Enter the code shown in the terminal"
}

configure_feeder_bootstrap() {
  if is_feeder_configured; then
    if [[ "$FEEDER_INSTALL_MODE" == "skip" ]] || [[ "$FEEDER_INSTALL_MODE" != "pair" ]]; then
      step "feeder already registered"
      echo "    config:  ${CONFIG_PATH}"
    fi
    return
  fi

  if [[ "$FEEDER_INSTALL_MODE" == "skip" ]]; then
    echo "FEEDER_INSTALL_MODE=skip but no API key in ${CONFIG_PATH}." >&2
    echo "Run without skip, or set FEEDER_INSTALL_MODE=anonymous|pair." >&2
    exit 1
  fi

  if ! command -v python3 >/dev/null 2>&1; then
    echo "python3 is required for feeder registration (apt install python3)." >&2
    exit 1
  fi

  local mode="$FEEDER_INSTALL_MODE"
  if [[ "$mode" == "interactive" ]]; then
    step "register feeder"
    echo "  1) Feed anonymously and start right away (default)"
    echo "  2) Link to a Fly Overhead account now (blocks until you enter the code online)"
    local choice=""
    read_tty "Choice [1]: " choice "1"
    if [[ "$choice" == "2" ]]; then
      mode="pair"
    else
      mode="anonymous"
    fi
  fi

  if [[ "$mode" == "pair" ]]; then
    bootstrap_pair_flow
    return
  fi

  if [[ "$mode" != "anonymous" ]]; then
    echo "Unknown FEEDER_INSTALL_MODE=${mode} (use anonymous, pair, skip, or interactive)." >&2
    exit 1
  fi

  bootstrap_register_anonymous
}

maybe_relink_feeder() {
  if [[ "${WAS_CONFIGURED:-0}" == "1" ]] && [[ "$FEEDER_INSTALL_MODE" == "pair" ]]; then
    step "re-linking feeder to your account"
    feeder_node pair
  fi
}

# Registration/pairing must write an API key before systemd starts; otherwise
# the service crash-loops on "not configured".
require_configured() {
  if ! is_feeder_configured; then
    echo
    echo "Registration did not complete — no API key was written to ${CONFIG_PATH}." >&2
    echo "Re-run the installer or set FEEDER_INSTALL_MODE=pair|anonymous." >&2
    exit 1
  fi
}

write_systemd_unit() {
  step "installing systemd unit"
  cat >/etc/systemd/system/${SERVICE_NAME}.service <<EOF
[Unit]
Description=Fly Overhead ADS-B feeder
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
Environment=FEEDER_API_URL=${FEEDER_API_URL}
Environment=FLY_OVERHEAD_FEEDER_CONFIG=${CONFIG_PATH}
Environment=NODE_OPTIONS=--max-old-space-size=200
ExecStart=$(command -v node) ${INSTALL_DIR}/dist/index.js run
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/fly-overhead-feeder
MemoryMax=250M

[Install]
WantedBy=multi-user.target
EOF
  systemctl daemon-reload
  systemctl enable --now "${SERVICE_NAME}.service"
}

main() {
  require_root
  step "Fly Overhead feeder installer"
  echo "    api:     ${FEEDER_API_URL}"
  echo "    cdn:     ${FEEDER_CDN_URL%/}/dist/$(detect_feeder_arch).tar.gz"
  echo "    target:  ${INSTALL_DIR}"

  WAS_CONFIGURED=0
  is_feeder_configured && WAS_CONFIGURED=1

  local detected
  detected=$(detect_existing_source)
  if [[ -z "$detected" ]]; then
    if [[ "$SKIP_DECODER_INSTALL" != "1" ]] && detect_rtlsdr; then
      install_readsb
      detected=$(wait_for_source 30)
      if [[ -z "$detected" ]]; then
        echo
        echo "Installed readsb but no BEAST output appeared on localhost:30005 yet." >&2
        echo "Check 'systemctl status readsb' / 'journalctl -u readsb -f', then re-run." >&2
        exit 1
      fi
      echo "    source:  ${detected}  (standalone — readsb driving the local RTL-SDR)"
    else
      echo
      echo "Could not find an ADS-B source on this machine, and no RTL-SDR dongle is plugged in."
      echo "The feeder needs one of:"
      echo "  - an RTL-SDR dongle (we'll install readsb and decode it ourselves), or"
      echo "  - an existing decoder: BEAST on localhost:30005, or aircraft.json on localhost:8080"
      echo
      echo "Plug in an SDR, or install a decoder (https://github.com/wiedehopf/readsb), then re-run."
      exit 1
    fi
  else
    echo "    source:  ${detected}  (will connect as a client; no conflict with existing feeders)"
  fi

  if systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
    step "stopping existing ${SERVICE_NAME} for upgrade"
    systemctl stop "${SERVICE_NAME}" || true
  fi

  ensure_node
  ensure_user

  local fetch_pid=""
  if ! has_dist; then
    fetch_dist &
    fetch_pid=$!
  fi

  configure_feeder_bootstrap

  if [[ -n "$fetch_pid" ]]; then
    step "installing feeder software"
    wait "$fetch_pid" || exit 1
  elif ! has_dist; then
    fetch_dist
  fi

  maybe_relink_feeder
  require_configured
  write_systemd_unit

  step "done"
  echo "    status:  systemctl status ${SERVICE_NAME}"
  echo "    logs:    journalctl -u ${SERVICE_NAME} -f"
  if command -v systemctl >/dev/null 2>&1 && systemctl is-active --quiet "${SERVICE_NAME}" 2>/dev/null; then
    feeder_node doctor 2>/dev/null || true
  fi
}

main "$@"
