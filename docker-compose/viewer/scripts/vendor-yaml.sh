#!/bin/sh
# Rebuilds vendor/yaml.mjs: the `yaml` package (eemeli/yaml, ISC, no dependencies) as one
# ES module, so the viewer stays plain Node with nothing to install. The viewer uses it to
# find each source in discovery.yaml, and edits only that source's text.
#
#   ./scripts/vendor-yaml.sh         (in docker-compose/viewer/, with npm on PATH)
set -eu

YAML_VERSION=2.9.1
YAML_INTEGRITY=sha512-3NxN8+78OdzbT7C/WjGsyfPAtJaN3FNDsWxv7Y7mcDsT/oOmgW8BpyQQFFBnvZE3j9Y2Sdz1ULFLezL7Eb2yFw==
ESBUILD_VERSION=0.25.10

here="$(cd "$(dirname "$0")/.." && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

cd "$work"
npm init -y >/dev/null
npm install --silent --ignore-scripts --no-audit --no-fund "yaml@$YAML_VERSION" "esbuild@$ESBUILD_VERSION"
got="$(node -p "require('./package-lock.json').packages['node_modules/yaml'].integrity")"
[ "$got" = "$YAML_INTEGRITY" ] || { echo "yaml@$YAML_VERSION has integrity $got, not $YAML_INTEGRITY" >&2; exit 1; }

{
  printf '// yaml@%s (https://github.com/eemeli/yaml), bundled by scripts/vendor-yaml.sh. Do not edit.\n' "$YAML_VERSION"
  printf '//\n'
  sed 's|^|// |; s| $||' node_modules/yaml/LICENSE
  printf '\n'
  ./node_modules/.bin/esbuild node_modules/yaml/browser/index.js --bundle --format=esm \
    --platform=neutral --target=es2022 --legal-comments=none --log-level=warning
} > "$here/vendor/yaml.mjs"
echo "Wrote vendor/yaml.mjs from yaml@$YAML_VERSION"
