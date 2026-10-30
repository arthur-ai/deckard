#!/usr/bin/env bash
# Print what this checkout pins, as KEY=value lines, after checking that every file naming
# Deckard's version agrees. CI runs it on every change; the release and the engine bump
# read its output.
#
#   DECKARD_VERSION  Deckard's version: the chart's version and appVersion, and the
#                    arthurplatform/deckard image tag the chart and Compose run
#   ENGINE_VERSION   the Arthur Engine release this version of Deckard is
#   ENGINE_DIGEST    that release's arthurplatform/ml-engine image, which releasing Deckard
#                    publishes unchanged as arthurplatform/deckard:<DECKARD_VERSION>
#   COLLECTOR_REF    the arthur-engine commit scan-local.sh runs the collector from, and
#                    scan-local.ps1 the Windows query from: the engine release's own
#                    commit, so the scan is what that release reads

set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
chart="$root/charts/deckard/Chart.yaml"
compose="$root/docker-compose/docker-compose.yaml"
scan="$root/docker-compose/scan-local.sh"
scan_windows="$root/docker-compose/scan-local.ps1"

fail() { echo "versions: $*" >&2; exit 1; }

# The value of the first line starting with $1, unquoted.
value() { sed -n "s|^$1 *\"\{0,1\}\([^\"]*\)\"\{0,1\} *$|\1|p" "$2" | head -1; }

deckard="$(value 'version:' "$chart")"
app="$(value 'appVersion:' "$chart")"
engine="$(value '  arthur.ai/engine-version:' "$chart")"
digest="$(value '  arthur.ai/engine-digest:' "$chart")"
# shellcheck disable=SC2016 # matching the literal ${DECKARD_VERSION-...} in the file
compose_default="$(sed -n 's|.*arthurplatform/deckard:${DECKARD_VERSION-\([^}]*\)}.*|\1|p' "$compose")"
collector="$(value 'COLLECTOR_REF=' "$scan")"
collector_windows="$(sed -n "s|^\$CollectorRef = '\([^']*\)' *$|\1|p" "$scan_windows" | head -1)"

[[ "$deckard" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "Chart.yaml version '$deckard' is not X.Y.Z"
[ "$app" = "$deckard" ] || fail "Chart.yaml appVersion '$app' is not its version '$deckard'"
[ "$compose_default" = "$deckard" ] \
  || fail "docker-compose.yaml runs arthurplatform/deckard:'$compose_default', not '$deckard'"
[ -n "$engine" ] || fail "Chart.yaml has no arthur.ai/engine-version annotation"
[[ "$digest" =~ ^sha256:[0-9a-f]{64}$ ]] || fail "Chart.yaml arthur.ai/engine-digest '$digest' is not a digest"
[[ "$collector" =~ ^[0-9a-f]{40}$ ]] || fail "scan-local.sh COLLECTOR_REF '$collector' is not a commit"
[ "$collector_windows" = "$collector" ] \
  || fail "scan-local.ps1 runs the query from '$collector_windows', not scan-local.sh's '$collector'"

echo "DECKARD_VERSION=$deckard"
echo "ENGINE_VERSION=$engine"
echo "ENGINE_DIGEST=$digest"
echo "COLLECTOR_REF=$collector"
