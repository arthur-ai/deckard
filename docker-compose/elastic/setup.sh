#!/bin/sh
# Sets up the Elasticsearch beside Deckard: the user Deckard writes as, and the user the
# viewer reads as, each allowed only that on Deckard's events.
#
# Every call creates or replaces, so it is safe to run on every `docker compose up`.
set -eu

ES=http://elasticsearch:9200
# What Deckard writes to: the default index of its elasticsearch destination.
INDEX_PATTERN="logs-arthur.discovery-*"

# Sends a request as the elastic superuser, and stops the setup if it is refused.
call() {
  method=$1 url=$2 body=$3
  shift 3
  curl -sS --fail-with-body -u "elastic:$ELASTIC_PASSWORD" -X "$method" "$url" \
    -H 'Content-Type: application/json' "$@" -d "$body" -o /dev/null
}

# ELASTIC_PASSWORD is elastic's until someone changes it through the API, which
# Elasticsearch then keeps instead.
status=$(curl -s -o /dev/null -w '%{http_code}' -u "elastic:$ELASTIC_PASSWORD" "$ES/_security/_authenticate")
if [ "$status" = 401 ]; then
  echo "Elasticsearch refused ELASTIC_PASSWORD for user elastic. If you changed elastic's" >&2
  echo "password, set ELASTIC_PASSWORD in .env to it, or start over: docker compose down -v" >&2
  exit 1
fi

# Deckard: add documents, and create the data stream the first write goes to.
call PUT "$ES/_security/role/deckard_writer" \
  "{\"indices\": [{\"names\": [\"$INDEX_PATTERN\"], \"privileges\": [\"create_doc\", \"auto_configure\"]}]}"
call PUT "$ES/_security/user/deckard" \
  "{\"password\": \"$ELASTIC_PASSWORD\", \"roles\": [\"deckard_writer\"]}"

# The viewer: search Deckard's events, and nothing else.
call PUT "$ES/_security/role/deckard_reader" \
  "{\"indices\": [{\"names\": [\"$INDEX_PATTERN\"], \"privileges\": [\"read\"]}]}"
call PUT "$ES/_security/user/deckard_viewer" \
  "{\"password\": \"$ELASTIC_PASSWORD\", \"roles\": [\"deckard_reader\"]}"

echo "Elasticsearch is ready for Deckard and its viewer"
