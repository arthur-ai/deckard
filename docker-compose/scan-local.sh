#!/usr/bin/env bash
# Scan this machine for AI agents, for Deckard's `local` source.
#
# Runs Arthur's endpoint collector, which uses osquery to list what is installed and changes
# nothing on the machine, and writes the folder Deckard reads:
#
#   inventory.json   the collector's scan
#   machine.json     which machine it was, since Deckard's container cannot see the host
#
# Usage: ./scan-local.sh [folder]     (default: ./local-scan beside this script)
#
# No root needed. Run as yourself, it sees what you can read, which on a laptop is where
# these tools install. Run it again to refresh what Deckard reports.

set -euo pipefail

# The collector, pinned to the commit of the engine release Deckard runs, so it writes the
# scan that release reads, and checked against these hashes. scripts/bump.sh moves all three.
COLLECTOR_REF=d52abc675a8758d30c3fa530eaf06556900cb529
COLLECT_SH_SHA256=c1fa89e55f0b41249b2393b1dcb9903cf31f6c1fd77e3554b76624922afc6b5e
COLLECT_LINUX_SH_SHA256=e08f1967fa8e370c98f07be737327d3b5e7f459ca98bfeadb62b64b21d2caa1b
COLLECTOR_URL="https://raw.githubusercontent.com/arthur-ai/arthur-engine/${COLLECTOR_REF}/integrations/endpoint-ai-discovery/dist"

here="$(cd "$(dirname "$0")" && pwd)"
out="${1:-$here/local-scan}"

fail() { echo "scan-local: $*" >&2; exit 1; }

case "$(uname -s)" in
  Darwin)
    platform=darwin
    collector=collect.sh
    collector_sha256=$COLLECT_SH_SHA256
    ;;
  Linux)
    platform=linux
    collector=collect-linux.sh
    collector_sha256=$COLLECT_LINUX_SH_SHA256
    ;;
  *) fail "$(uname -s) is not supported; this script runs on macOS and Linux, and scan-local.ps1 on Windows" ;;
esac

# The places the collector looks for osquery, in its order.
have_osquery() {
  local c
  for c in "${OSQI:-}" /usr/local/bin/osqueryi \
           /opt/osquery/lib/osquery.app/Contents/MacOS/osqueryi /usr/bin/osqueryi; do
    [ -n "$c" ] && [ -x "$c" ] && return 0
  done
  command -v osqueryi >/dev/null 2>&1
}

if ! have_osquery; then
  {
    echo "scan-local: osquery is not installed. Install it, then run this again:"
    [ "$platform" = darwin ] && echo "  brew install --cask osquery"
    echo "  or download it from https://osquery.io/downloads"
  } >&2
  exit 1
fi

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | cut -d' ' -f1
  else
    shasum -a 256 "$1" | cut -d' ' -f1
  fi
}

# The stable id of this machine: the left half of every agent's external_id, so never the
# hostname, which changes.
device_id() {
  if [ "$platform" = darwin ]; then
    ioreg -rd1 -c IOPlatformExpertDevice | awk -F'"' '/IOPlatformUUID/ {print $4}'
  else
    cat /etc/machine-id 2>/dev/null || cat /var/lib/dbus/machine-id 2>/dev/null || true
  fi
}

os_version() {
  if [ "$platform" = darwin ]; then
    echo "macOS $(sw_vers -productVersion)"
  else
    sed -n 's/^PRETTY_NAME="\{0,1\}\([^"]*\)"\{0,1\}$/\1/p' /etc/os-release 2>/dev/null || true
  fi
}

json_string() { printf '"%s"' "$(printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g')"; }

id="$(device_id)"
[ -n "$id" ] || fail "could not read this machine's id"

work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

echo "Downloading the endpoint collector..."
curl -fsSL "$COLLECTOR_URL/$collector" -o "$work/$collector" \
  || fail "could not download the collector from $COLLECTOR_URL/$collector"
[ "$(sha256_of "$work/$collector")" = "$collector_sha256" ] \
  || fail "the downloaded collector does not match its pinned hash; not running it"

mkdir -p "$out"
echo "Scanning this machine (about 10 seconds)..."
ARTHUR_OUT_DIR="$out" bash "$work/$collector" >"$work/collector.log" 2>&1 || {
  cat "$work/collector.log" >&2
  fail "the collector failed; the folder still holds the previous scan, if any"
}

{
  printf '{"device_id": %s, "hostname": %s, "platform": %s, "os_version": %s}\n' \
    "$(json_string "$id")" "$(json_string "$(hostname)")" \
    "$(json_string "$platform")" "$(json_string "$(os_version)")"
} >"$work/machine.json"
mv "$work/machine.json" "$out/machine.json"

# Deckard's container runs as UID 65532, which must be able to read both files.
chmod 755 "$out"
chmod 644 "$out/inventory.json" "$out/machine.json"

echo "Done: $(cut -d' ' -f1,3 "$out/status.txt" 2>/dev/null) -> $out"
echo "Deckard reads it on its next scan. To start Deckard and see what it finds:"
echo "  docker compose up -d --wait"
echo "  then open http://localhost:5601/app/discover#/view/deckard-findings (user elastic, password changeme)"
echo "If Deckard is already running, publish this scan now: docker compose restart deckard"
