#!/usr/bin/env bash
# Start Deckard on this machine and show the AI agents it finds.
#
# Usage: ./start.sh
#
# Checks this machine (docker-compose/preflight.sh), scans it (docker-compose/scan-local.sh),
# starts Deckard with Elasticsearch and Kibana beside it, waits for the scan to land, and
# prints what it found. It installs nothing and never runs sudo: if a check fails, it stops
# and prints the commands to run yourself. Run it again to rescan and refresh the results.

set -euo pipefail

cd "$(dirname "$0")/docker-compose"

fail() { echo "start: $*" >&2; exit 1; }
step() { printf '\n==> %s\n' "$*"; }

step "Checking this machine"
./preflight.sh || fail "fix the checks above, then run ./start.sh again"

step "Scanning this machine for AI agents"
./scan-local.sh >/dev/null

# The password .env sets for elastic, if any, else the Compose file's default.
pw="$(sed -n "s/^ELASTIC_PASSWORD=['\"]\{0,1\}\([^'\"]*\).*/\1/p" .env 2>/dev/null | tail -n 1 || true)"
pw="${pw:-changeme}"

# Deckard publishes a scan only when it starts, so a running one must restart to pick this one up.
was_running="$(docker compose ps -q --status running deckard 2>/dev/null || true)"
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

step "Starting Deckard, Elasticsearch and Kibana (the first start downloads about 2 GB)"
if ! docker compose up -d --wait; then
  docker compose ps -a --format 'table {{.Service}}\t{{.Status}}' >&2
  fail "a service did not start; docker compose logs <service> (run in docker-compose/) says why.
       Kibana can be slow on a first start: run ./start.sh again."
fi
[ -z "$was_running" ] || docker compose restart deckard >/dev/null

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

step "Waiting for Deckard's scan"
for _ in $(seq 1 60); do
  [ "$(count "$outcome")" -gt 0 ] 2>/dev/null && break
  sleep 5
done
[ "$(count "$outcome")" -gt 0 ] 2>/dev/null \
  || fail "no scan arrived after 5 minutes; docker compose logs --tail 50 deckard (in docker-compose/) says why"
[ "$(count "$outcome, {\"term\":{\"outcome.succeeded\":true}}")" -gt 0 ] 2>/dev/null \
  || fail "the scan failed; docker compose logs --no-log-prefix deckard | grep '\"succeeded\"' (in docker-compose/) says why"

agents="$(count '{"term":{"event_type":"arthur.discovery.agent"}}')"
if [ "${agents:-0}" -gt 0 ]; then
  step "Found $agents AI agent(s) on this machine"
  curl -s -u "elastic:$pw" 'http://localhost:9200/_query?format=txt' -H 'Content-Type: application/json' \
    -d "{\"query\": \"FROM logs-arthur.discovery-* | WHERE event_type == \\\"arthur.discovery.agent\\\" AND source.name == \\\"this-machine\\\" AND @timestamp >= TO_DATETIME(\\\"$started\\\") | KEEP agent.name, source.name | SORT agent.name\"}"
else
  step "The scan succeeded and found none of the AI agents in the catalog on this machine"
fi

cat <<EOF

Browse every event in Kibana: http://localhost:5601/app/discover#/view/deckard-findings
  user elastic, password $( [ "$pw" = changeme ] && echo changeme || echo "ELASTIC_PASSWORD from docker-compose/.env" )

Run ./start.sh again to rescan. To add cloud, MDM or SIEM sources, edit
docker-compose/discovery.yaml, then in docker-compose/: docker compose up -d --force-recreate deckard
EOF
