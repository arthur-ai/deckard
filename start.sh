#!/usr/bin/env bash
# Start Deckard on this machine, open its viewer, and show the AI agents it finds.
#
# Usage: ./start.sh
#
# Checks this machine (docker-compose/preflight.sh), then scans it (docker-compose/
# scan-local.sh) while it starts Elasticsearch and the viewer, and opens the viewer's
# welcome page, where you can add cloud, MDM and SIEM sources while the scan runs. Then it
# starts Deckard, which reads the scan, waits for it to land, and prints what it found.
# It installs nothing and never runs sudo: if a check fails, it stops and prints the
# commands to run yourself.
#
# On a terminal it then keeps running, so the viewer's Scan now can scan this machine again:
# the scan runs here, on the host, and the viewer is a container that can't. The two talk
# through docker-compose/runner/ (see viewer/localscan.mjs). Ctrl-C stops that, and leaves
# Deckard running. Without a terminal, as under a coding agent or CI, it exits once it has
# printed the agents, and opens no browser. DECKARD_NO_BROWSER=1 never opens one.
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
serve_pid=""
beat_pid=""
serving=0
runner="$PWD/runner"
viewer_url="http://localhost:7493"

# Stops the scans this script runs for the viewer, and tells the viewer it's gone.
stop_runner() {
  local p
  for p in $serve_pid $beat_pid; do kill "$p" 2>/dev/null || true; done
  rm -f "$runner/heartbeat"
}
trap 'stop_runner; rm -f "$log"' EXIT
interrupted() {
  [ -z "$bg_pid" ] || kill "$bg_pid" 2>/dev/null
  printf '\n'
  if [ "$serving" = 1 ]; then
    printf '%s\n' "Stopped. Deckard keeps running at $viewer_url, and ./start.sh scans this machine again."
    exit 0
  fi
  exit 130
}
trap interrupted INT TERM

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

# This machine's scans, for the viewer: run in the background, writing runner/status.json.

# $1 as a JSON string: control characters dropped, tabs as spaces, lines joined with \n.
json_string() {
  printf '%s' "$1" | tr -d '\000-\010\013-\037' | tr '\t' ' ' | sed 's/\\/\\\\/g; s/"/\\"/g' \
    | awk 'BEGIN { ORS = ""; printf "%s", "\"" } { if (NR > 1) printf "%s", "\\n"; print } END { printf "%s", "\"" }'
}
now_iso() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# write_status RUN STATE STARTED [FINISHED SECONDS MESSAGE]: whole, so the viewer never
# reads half of it.
write_status() {
  local finished=null seconds=null
  [ -z "${4:-}" ] || finished="\"$4\""
  [ -z "${5:-}" ] || seconds="$5"
  printf '{"run": "%s", "state": "%s", "host": %s, "started_at": "%s", "finished_at": %s, "seconds": %s, "message": %s}\n' \
    "$1" "$2" "$(json_string "$(uname -n)")" "$3" "$finished" "$seconds" "$(json_string "${6:-}")" >"$runner/.status.tmp"
  mv "$runner/.status.tmp" "$runner/status.json"
}

# One scan, as run RUN. Killed, it kills the scan too.
scan_pid=""
scan_once() {
  local run="$1" started t0=$SECONDS status=0
  started="$(now_iso)"
  write_status "$run" running "$started"
  ./scan-local.sh >"$runner/scan.log" 2>&1 &
  scan_pid=$!
  wait "$scan_pid" || status=$?
  scan_pid=""
  if [ "$status" = 0 ]; then
    write_status "$run" succeeded "$started" "$(now_iso)" "$((SECONDS - t0))" "$(tail -n 1 "$runner/scan.log")"
  else
    write_status "$run" failed "$started" "$(now_iso)" "$((SECONDS - t0))" "$(tail -n 15 "$runner/scan.log")"
  fi
}

# The first scan, then each the viewer asks for. A request holds only its run's id, kept
# to letters, digits and dashes; nothing in it is run.
serve() {
  set +e
  trap '[ -z "$scan_pid" ] || kill "$scan_pid" 2>/dev/null; exit 0' TERM
  scan_once start
  local run
  while :; do
    if [ -f "$runner/request" ]; then
      run="$(head -c 64 "$runner/request" 2>/dev/null | tr -cd 'A-Za-z0-9-')"
      rm -f "$runner/request"
      scan_once "${run:-r$(date +%s)}"
    fi
    sleep 1
  done
}

# Fresh while this script runs: the viewer offers Scan now only then. It holds the time,
# for the next ./start.sh to tell; the viewer reads when it was written.
heartbeat() {
  trap 'exit 0' TERM
  while :; do date +%s >"$runner/heartbeat"; sleep 2; done
}

# The first scan's state, once it has one: running, succeeded or failed.
first_scan() { sed -n 's/^{"run": "start", "state": "\([a-z]*\)".*/\1/p' "$runner/status.json" 2>/dev/null; }

# Opens url $1 in a browser on this machine's screen, if it has one and this is a terminal.
open_browser() {
  [ "$tty" = 1 ] && [ -z "${DECKARD_NO_BROWSER:-}" ] && [ -z "${SSH_CONNECTION:-}" ] || return 1
  case "$(uname -s)" in
    Darwin) open "$1" >/dev/null 2>&1 ;;
    *)
      [ -n "${DISPLAY:-}${WAYLAND_DISPLAY:-}" ] && command -v xdg-open >/dev/null 2>&1 || return 1
      xdg-open "$1" >/dev/null 2>&1 &
      ;;
  esac
}

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

# 2. Scan, in the background, while the viewer starts. Another ./start.sh scanning for the
#    viewer would answer its requests too: one at a time.
beat="$(cat "$runner/heartbeat" 2>/dev/null || true)"
if [ -n "$beat" ] && [ "$(( $(date +%s) - beat ))" -lt 10 ] 2>/dev/null; then
  bad "Already running" "another ./start.sh is scanning for the viewer: stop it first, or use $viewer_url"
  exit 1
fi
mkdir -p "$runner"
rm -f "$runner/request" "$runner/status.json"
heartbeat & beat_pid=$!
serve & serve_pid=$!

# 3. Start Elasticsearch and the viewer. create pulls every image, Deckard's too, so it
#    starts at once when the scan ends.
#    --remove-orphans: the Kibana an older checkout ran, which the viewer replaced.
#    VIEWER_UID: the viewer edits discovery.yaml, secrets/ and runner/ as you, who own them.
export VIEWER_UID="${VIEWER_UID:-$(id -u)}"
was_running="$(docker compose ps -q --status running deckard 2>/dev/null || true)"
first=""
[ -n "$(docker compose images -q 2>/dev/null)" ] || first=" (the first start downloads about 1.4 GB)"
up_viewer() { docker compose create --remove-orphans && docker compose up -d --wait viewer; }
run "Starting Elasticsearch and the viewer$first" up_viewer
if [ "$status" -ne 0 ]; then
  bad "Viewer did not start"
  show_log
  docker compose ps -a --format 'table {{.Service}}\t{{.Status}}' 2>/dev/null | sed 's/^/    /' >&2
  note "docker compose logs <service> (run in docker-compose/) says why." \
       "Elasticsearch can be slow on a first start: run ./start.sh again."
  exit 1
fi
ok "Viewer running" "Elasticsearch + viewer · ${elapsed}s"
if open_browser "$viewer_url/#welcome"; then
  ok "Viewer opened" "$viewer_url · add your cloud, MDM and SIEM sources there"
else
  ok "Viewer ready" "open $viewer_url/#welcome to add your cloud, MDM and SIEM sources"
fi

# 4. Wait for this machine's scan.
wait_first() {
  while [ "$(first_scan)" = running ] || [ -z "$(first_scan)" ]; do
    kill -0 "$serve_pid" 2>/dev/null || return 1
    sleep 0.5
  done
  [ "$(first_scan)" = succeeded ]
}
run "Scanning this machine for AI agents" wait_first
scanned=$status
if [ "$scanned" -eq 0 ]; then
  ok "Scanned" "$(sed -n 's/.*"seconds": \([0-9]*\).*/\1/p' "$runner/status.json")s"
else
  bad "Scan failed"
  tail -n 20 "$runner/scan.log" 2>/dev/null | sed 's/^/    /' >&2
  if [ "$tty" = 0 ]; then exit 1; fi
  note "The viewer has Scan now on its welcome page and Sources tab, to try again."
fi

# 5. Start Deckard, which publishes the scan when it starts, so a running one must restart
#    to pick this one up.
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
up_deckard() {
  docker compose up -d --wait deckard
  [ -z "$was_running" ] || docker compose restart deckard
}
run "Starting Deckard" up_deckard
if [ "$status" -ne 0 ]; then
  bad "Deckard did not start"
  show_log
  note "docker compose logs --tail 50 deckard (run in docker-compose/) says why."
  exit 1
fi
ok "Deckard running" "${elapsed}s"

# 6. Wait for the scan to reach Elasticsearch.
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

# Steps 6 and 7, which fail by returning 1 once they have said why.
report() {
  run "Waiting for Deckard's scan" wait_scan
  if [ "$status" -ne 0 ]; then
    bad "No scan arrived" "after 5 minutes"
    note "docker compose logs --tail 50 deckard (in docker-compose/) says why."
    return 1
  fi
  if ! [ "$(count "$outcome, {\"term\":{\"outcome.succeeded\":true}}")" -gt 0 ] 2>/dev/null; then
    bad "Deckard's scan failed"
    note "docker compose logs --no-log-prefix deckard | grep '\"succeeded\"' (in docker-compose/) says why."
    return 1
  fi

  # 7. The agents found: name, kind and where, one row each.
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
}

# Without a terminal, a failure is the script's. On one, the viewer stays to try again.
reported=1
if [ "$scanned" -eq 0 ]; then
  reported=0
  report || reported=$?
fi
[ "$tty" = 1 ] || [ "$reported" -eq 0 ] || exit 1

if [ "$tty" = 0 ]; then
  cat <<EOF

${bold}See them${reset}      $viewer_url
${bold}Rescan${reset}        ./start.sh
${bold}Add sources${reset}   cloud, MDM or SIEM: the viewer's Sources tab

EOF
  exit 0
fi

cat <<EOF

${bold}See them${reset}      $viewer_url
${bold}Rescan${reset}        Scan now in the viewer, while this runs
${bold}Add sources${reset}   cloud, MDM or SIEM: the viewer's welcome page or Sources tab

${dim}Leave this running to scan this machine from the viewer. Ctrl-C stops that; Deckard keeps running.${reset}
EOF
serving=1
wait "$serve_pid"
