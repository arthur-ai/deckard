#!/usr/bin/env bash
# Start Deckard on this machine and show the AI agents it finds.
#
# Usage: ./start.sh
#
# Checks this machine (docker-compose/preflight.sh), scans it (docker-compose/scan-local.sh),
# starts Deckard with Elasticsearch and its viewer beside it, waits for the scan to land, and
# prints what it found. It installs nothing and never runs sudo: if a check fails, it stops
# and prints the commands to run yourself. Run it again to rescan and refresh the results.
#
# Each step prints one line. What the step itself printed goes to a log, shown only when the
# step fails. Colour and the spinner appear only on a terminal, and NO_COLOR turns colour off.

set -euo pipefail

cd "$(dirname "$0")/docker-compose"

tty=0; [ -t 1 ] && tty=1
if [ "$tty" = 1 ] && [ -z "${NO_COLOR:-}" ]; then
  bold=$'\e[1m' purple=$'\e[35m' dim=$'\e[2m' green=$'\e[32m' red=$'\e[31m' yellow=$'\e[33m' reset=$'\e[0m'
else
  bold='' purple='' dim='' green='' red='' yellow='' reset=''
fi

log="$(mktemp)"
bg_pid=""
trap 'rm -f "$log"' EXIT
trap '[ -z "$bg_pid" ] || kill "$bg_pid" 2>/dev/null; printf "\n"; exit 130' INT TERM

ok()   { printf '%s✓%s %-18s %s\n' "$green" "$reset" "$1" "${dim}${2:-}${reset}"; }
bad()  { printf '%s✗%s %-18s %s\n' "$red" "$reset" "$1" "${2:-}" >&2; }
note() { printf '  %s\n' "$@" >&2; }

# Run "$@" in the background with its output in $log, showing label beside a spinner on a
# terminal. Sets status to its exit code and elapsed to the seconds it took.
run() {
  local label="$1" i=0 t0=$SECONDS
  local frames=(⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏)
  shift
  "$@" >"$log" 2>&1 &
  bg_pid=$!
  if [ "$tty" = 1 ]; then
    while kill -0 "$bg_pid" 2>/dev/null; do
      printf '\r%s%s%s %s' "$yellow" "${frames[i++ % 10]}" "$reset" "$label"
      sleep 0.1
    done
    printf '\r\e[K'
  fi
  if wait "$bg_pid"; then status=0; else status=$?; fi
  bg_pid=""
  elapsed=$((SECONDS - t0))
}

# The last lines of $log, indented, for a failed step.
show_log() { tail -n "${1:-20}" "$log" | sed 's/^/    /' >&2; }

# The detail preflight printed for its passing check $1.
passed() { awk -v c="$1" '$1 == "CHECK" && $2 == c && $3 == "PASS" { $1 = $2 = $3 = ""; sub(/^ +/, ""); print }' "$log"; }

# The owl from the Deckard logo, with the name and host beside its eyes.
p="$purple" w="$bold" y="$yellow" r="$reset"
cat <<EOF

${p}  |\\__         __/|${r}
${p}  |   \\_______/   |${r}
${p}  |  ${w}.--.   .--.${r}${p}  |${r}
${p}  | ${w}( () ) ( () )${r}${p} |${r}    ${bold}Deckard${reset}
${p}  |  ${w}'--'${r} ${y}V${r} ${w}'--'${r}${p}  |${r}    ${dim}scanning $(uname -n)${reset}
${p}   \\    v v v    /${r}
${p}    \\    v v    /${r}
${p}     '-._____.-'${r}

EOF

# 1. Preflight. On success, a summary; on failure, its failed checks and their fixes. Its
#    INFO lines and anything else it printed besides passing checks show either way.
run "Checking this machine" ./preflight.sh
extra="$(grep -Ev '^CHECK +[^ ]+ +PASS|^PREFLIGHT (OK|FAILED)' "$log" \
  | sed -E "s/^CHECK +([^ ]+) +FAIL +(.*)/${red}✗${reset} \1: \2/;
            s/^CHECK +([^ ]+) +[A-Z]+ +(.*)/· \1: \2/;
            s/^ +FIX: (.*)/  ${dim}→${reset} \1/" || true)"
if [ "$status" -ne 0 ]; then
  bad "Machine not ready" "fix what is below, then run ./start.sh again"
  printf '%s\n' "$extra" | sed 's/^/  /' >&2
  exit 1
fi
docker_v="$(passed docker | sed -n 's/^server \([^,]*\).*/Docker \1/p')"
mem="$(passed memory | awk '$1 + 0 > 0 { printf "%d GB RAM", $1 / 1024 + 0.5 }')"
osq="$(passed osquery | sed -n 's/.*version \([^ ]*\).*/osquery \1/p')"
ok "Machine ready" "$(printf '%s\n' "$docker_v" "$mem" "$osq" | sed '/^$/d' | paste -sd'|' | sed 's/|/ · /g')"
[ -z "$extra" ] || printf '%s\n' "$extra" | sed 's/^/  /'

# 2. Scan.
run "Scanning this machine for AI agents" ./scan-local.sh
if [ "$status" -ne 0 ]; then
  bad "Scan failed"
  show_log
  exit 1
fi
ok "Scanned" "${elapsed}s"

# 3. Start the stack. Deckard publishes a scan only when it starts, so a running one must
#    restart to pick this one up.
was_running="$(docker compose ps -q --status running deckard 2>/dev/null || true)"
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
up() {
  # --remove-orphans: the Kibana an older checkout ran, which the viewer replaced.
  docker compose up -d --wait --remove-orphans
  [ -z "$was_running" ] || docker compose restart deckard
}
first=""
[ -n "$(docker compose images -q 2>/dev/null)" ] || first=" (the first start downloads about 1.4 GB)"
run "Starting Deckard, Elasticsearch and the viewer$first" up
if [ "$status" -ne 0 ]; then
  bad "Deckard did not start"
  show_log
  docker compose ps -a --format 'table {{.Service}}\t{{.Status}}' 2>/dev/null | sed 's/^/    /' >&2
  note "docker compose logs <service> (run in docker-compose/) says why." \
       "Elasticsearch can be slow on a first start: run ./start.sh again."
  exit 1
fi
ok "Deckard running" "Elasticsearch + viewer · ${elapsed}s"

# 4. Wait for the scan to reach Elasticsearch.
# The password .env sets for elastic, if any, else the Compose file's default.
pw="$(sed -n "s/^ELASTIC_PASSWORD=['\"]\{0,1\}\([^'\"]*\).*/\1/p" .env 2>/dev/null | tail -n 1 || true)"
pw="${pw:-changeme}"

# Events of this machine's scans since this run started, matching the extra filter $1.
count() {
  curl -s -u "elastic:$pw" -H 'Content-Type: application/json' \
    'http://localhost:9200/logs-arthur.discovery-*/_count' \
    -d "{\"query\":{\"bool\":{\"filter\":[
          {\"term\":{\"source.name\":\"this-machine\"}},
          {\"range\":{\"@timestamp\":{\"gte\":\"$started\"}}},
          $1]}}}" | sed -n 's/.*"count":\([0-9]*\).*/\1/p'
}
outcome='{"term":{"event_type":"arthur.discovery.scan_outcome"}}'
arrived() { [ "$(count "$outcome")" -gt 0 ] 2>/dev/null; }
wait_scan() {
  local _
  for _ in $(seq 1 60); do arrived && return 0; sleep 5; done
  return 1
}

run "Waiting for Deckard's scan" wait_scan
if [ "$status" -ne 0 ]; then
  bad "No scan arrived" "after 5 minutes"
  note "docker compose logs --tail 50 deckard (in docker-compose/) says why."
  exit 1
fi
if ! [ "$(count "$outcome, {\"term\":{\"outcome.succeeded\":true}}")" -gt 0 ] 2>/dev/null; then
  bad "Deckard's scan failed"
  note "docker compose logs --no-log-prefix deckard | grep '\"succeeded\"' (in docker-compose/) says why."
  exit 1
fi

# 5. The agents found: name, kind and where, one row each.
esql='FROM logs-arthur.discovery-*
  | WHERE event_type == "arthur.discovery.agent" AND source.name == "this-machine" AND @timestamp >= TO_DATETIME("'"$started"'")
  | STATS BY agent.name, agent.creation_source.observations.classification, agent.creation_source.observations.install_path
  | SORT agent.name'
body="$(printf '%s' "$esql" | tr '\n' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g')"
rows="$(curl -s -u "elastic:$pw" -H 'Content-Type: application/json' \
          'http://localhost:9200/_query?format=tsv' -d "{\"query\": \"$body\"}" \
        | tail -n +2 | sed '/^[[:space:]]*$/d' \
        | awk -F'\t' -v home="$HOME" 'BEGIN { OFS = "\t" } {
            for (i = 1; i <= NF; i++) if ($i == "null") $i = ""
            if (home != "" && index($3, home) == 1) $3 = "~" substr($3, length(home) + 1)
            print }')"
n="$(printf '%s' "$rows" | grep -c . || true)"

if [ "$n" -gt 0 ]; then
  ok "Scan published" "$n AI agent$([ "$n" = 1 ] || echo s) found"
  printf '\n%sAI agents on this machine%s\n' "$bold" "$reset"
  printf '%s\n' "$rows" | awk -F'\t' -v dim="$dim" -v reset="$reset" '
    { name[NR] = $1; kind[NR] = $2; where[NR] = $3
      if (length($1) > w1) w1 = length($1); if (length($2) > w2) w2 = length($2) }
    END { for (i = 1; i <= NR; i++)
            printf "  %-*s  %-*s  %s%s%s\n", w1, name[i], w2, kind[i], dim, where[i], reset }'
else
  ok "Scan published" "none of the AI agents in the catalog are on this machine"
fi

cat <<EOF

${bold}See them${reset}      http://localhost:7493
${bold}Rescan${reset}        ./start.sh
${bold}Add sources${reset}   cloud, MDM or SIEM: see docker-compose/README.md

EOF
