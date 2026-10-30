#!/usr/bin/env bash
# Move Deckard to a new version, on a new Arthur Engine release or on the same one.
#
#   scripts/bump.sh --engine 2.1.1060                    # that release, as the next patch version
#   scripts/bump.sh --deckard 0.2.0                      # a new version on the same engine
#   scripts/bump.sh --engine 2.1.1060 --deckard 0.2.0
#
# Moving the engine pins its image digest and the collector scan-local.sh runs to that
# release, together. Merging the change to main releases the new version
# (.github/workflows/release.yaml). Needs gh, docker with buildx, jq and curl.

set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
chart="$root/charts/deckard/Chart.yaml"
compose="$root/docker-compose/docker-compose.yaml"
scan="$root/docker-compose/scan-local.sh"
scan_windows="$root/docker-compose/scan-local.ps1"

fail() { echo "bump: $*" >&2; exit 1; }
usage() { sed -n '4,6s/^#  *//p' "$0" >&2; exit 2; }

engine="" deckard=""
while [ $# -gt 0 ]; do
  case "$1" in
    --engine) [ $# -ge 2 ] || usage; engine="$2"; shift 2 ;;
    --deckard) [ $# -ge 2 ] || usage; deckard="$2"; shift 2 ;;
    *) usage ;;
  esac
done
[ -n "$engine$deckard" ] || usage

eval "$("$root/scripts/versions.sh")"

if [ -z "$deckard" ]; then
  IFS=. read -r major minor patch <<<"$DECKARD_VERSION"
  deckard="$major.$minor.$((patch + 1))"
fi
[[ "$deckard" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "'$deckard' is not X.Y.Z"
# Never back: the release tags each new version as latest.
[ "$(printf '%s\n' "$DECKARD_VERSION" "$deckard" | sort -V | tail -1)" = "$deckard" ] \
  || fail "$deckard is older than $DECKARD_VERSION"
# A released version is never changed, and the release skips a version that is tagged.
if git -C "$root" ls-remote --exit-code --tags origin "refs/tags/v$deckard" >/dev/null; then
  fail "v$deckard is already released"
fi

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -d' ' -f1; else shasum -a 256 | cut -d' ' -f1; fi
}

# Replace what follows the literal prefix $1, at the start of a line in $3, with $2.
set_after() { PREFIX="$1" VALUE="$2" perl -pi -e 's/^(\Q$ENV{PREFIX}\E).*/$1$ENV{VALUE}/' "$3"; }

if [ -n "$engine" ]; then
  # Releases only: a dev build has no GitHub release, and Deckard ships what the engine has.
  released="$(gh release view "$engine" -R arthur-ai/arthur-engine --json isDraft,isPrerelease \
    --jq 'if .isDraft or .isPrerelease then "no" else "yes" end' 2>/dev/null || true)"
  [ "$released" = yes ] || fail "arthur-engine $engine is not a published release"

  digest="$(docker buildx imagetools inspect "arthurplatform/ml-engine:$engine" --format '{{json .Manifest}}' \
    | jq -r .digest)"
  commit="$(gh api "repos/arthur-ai/arthur-engine/commits/$engine" --jq .sha)"
  tree="https://raw.githubusercontent.com/arthur-ai/arthur-engine/$commit/integrations/endpoint-ai-discovery"
  mac_sha256="$(curl -fsSL "$tree/dist/collect.sh" | sha256)"
  linux_sha256="$(curl -fsSL "$tree/dist/collect-linux.sh" | sha256)"
  # Windows has no collector; scan-local.ps1 runs the vendored query itself.
  windows_sha256="$(curl -fsSL "$tree/vendor/ai-detection-spec/dist/discovery-windows.sql" | sha256)"

  set_after '  arthur.ai/engine-version: ' "\"$engine\"" "$chart"
  set_after '  arthur.ai/engine-digest: ' "$digest" "$chart"
  set_after 'COLLECTOR_REF=' "$commit" "$scan"
  set_after 'COLLECT_SH_SHA256=' "$mac_sha256" "$scan"
  set_after 'COLLECT_LINUX_SH_SHA256=' "$linux_sha256" "$scan"
  set_after '$CollectorRef = ' "'$commit'" "$scan_windows"
  set_after '$DiscoveryWindowsSqlSha256 = ' "'$windows_sha256'" "$scan_windows"
fi

set_after 'version: ' "$deckard" "$chart"
set_after 'appVersion: ' "\"$deckard\"" "$chart"
VALUE="$deckard" perl -pi -e 's/(arthurplatform\/deckard:\$\{DECKARD_VERSION-)[^}]*/$1$ENV{VALUE}/' "$compose"

"$root/scripts/versions.sh"
