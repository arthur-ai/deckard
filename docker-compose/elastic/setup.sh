#!/bin/sh
# Sets up the Elasticsearch and Kibana beside Deckard. Compose runs it twice:
#
#   setup.sh elasticsearch   the user Deckard writes as, Kibana's own password, and the
#                            mapping of the fields the dashboards read (fields.json)
#   setup.sh kibana          the data view, the "Deckard findings" list of events, and the
#                            dashboards (dashboards.ndjson): "Deckard: this machine", which
#                            Kibana opens on, and "Deckard: all sources"
#
# Every call creates or replaces, so it is safe to run on every `docker compose up`.
set -eu

ES=http://elasticsearch:9200
KIBANA=http://kibana:5601
# What Deckard writes to: the default index of its elasticsearch destination.
INDEX_PATTERN="logs-arthur.discovery-*"

# Sends a request as the elastic superuser, and stops the setup if it is refused.
call() {
  method=$1 url=$2 body=$3
  shift 3
  curl -sS --fail-with-body -u "elastic:$ELASTIC_PASSWORD" -X "$method" "$url" \
    -H 'Content-Type: application/json' "$@" -d "$body" -o /dev/null
}

elasticsearch() {
  # ELASTIC_PASSWORD is elastic's until someone changes it in Kibana or the API, which
  # Elasticsearch then keeps instead.
  status=$(curl -s -o /dev/null -w '%{http_code}' -u "elastic:$ELASTIC_PASSWORD" "$ES/_security/_authenticate")
  if [ "$status" = 401 ]; then
    echo "Elasticsearch refused ELASTIC_PASSWORD for user elastic. If you changed elastic's" >&2
    echo "password, set ELASTIC_PASSWORD in .env to it, or start over: docker compose down -v" >&2
    exit 1
  fi

  call POST "$ES/_security/user/kibana_system/_password" \
    "{\"password\": \"$ELASTIC_PASSWORD\"}"
  # Only what the destination needs: add documents, and create the data stream the
  # first write goes to.
  call PUT "$ES/_security/role/deckard_writer" \
    "{\"indices\": [{\"names\": [\"$INDEX_PATTERN\"], \"privileges\": [\"create_doc\", \"auto_configure\"]}]}"
  call PUT "$ES/_security/user/deckard" \
    "{\"password\": \"$ELASTIC_PASSWORD\", \"roles\": [\"deckard_writer\"]}"

  # The fields the dashboards read, mapped before any event carries them. Elasticsearch maps
  # a field when its first value arrives, so a scan that finds no agent, or has never
  # failed, would leave the dashboards asking for fields that do not exist. The template is
  # Elasticsearch's own for logs data streams with these fields added, each with the type
  # it would get anyway; the second call gives them to a data stream that already exists.
  # An Elasticsearch that refuses either still takes Deckard's events, so nothing here
  # stops the setup.
  if fields=$(cat /setup/fields.json); then
    call PUT "$ES/_index_template/logs-arthur.discovery" \
      "{\"index_patterns\": [\"$INDEX_PATTERN\"], \"priority\": 200,
        \"data_stream\": {}, \"allow_auto_create\": true,
        \"composed_of\": [\"logs@mappings\", \"logs@settings\", \"logs@custom\", \"ecs@mappings\"],
        \"ignore_missing_component_templates\": [\"logs@custom\"],
        \"template\": {\"mappings\": {\"properties\": $fields}},
        \"_meta\": {\"description\": \"Arthur Deckard's events: the built-in logs template, plus the fields its Kibana dashboards read\"}}" \
      || echo "Elasticsearch kept its own template for Deckard's events"
    call PUT "$ES/$INDEX_PATTERN/_mapping?allow_no_indices=true" "{\"properties\": $fields}" \
      || echo "Elasticsearch kept the mapping of the events it already has"
  else
    echo "Elasticsearch kept its own mapping of Deckard's events: fields.json could not be read"
  fi
  echo "Elasticsearch is ready for Deckard"
}

kibana() {
  call POST "$KIBANA/api/data_views/data_view" \
    "{\"override\": true, \"data_view\": {\"id\": \"deckard\", \"name\": \"Deckard\", \"title\": \"$INDEX_PATTERN\", \"timeFieldName\": \"@timestamp\"}}" \
    -H 'kbn-xsrf: true'
  # So Discover opens on Deckard's events.
  call POST "$KIBANA/api/data_views/default" \
    '{"data_view_id": "deckard", "force": true}' \
    -H 'kbn-xsrf: true'
  # "Deckard findings": every event Deckard sent, newest first, over the last 30 days, so a
  # scan from up to an interval ago shows (Discover's own default is 15 minutes).
  call POST "$KIBANA/api/saved_objects/search/deckard-findings?overwrite=true" \
    '{"attributes": {
        "title": "Deckard findings",
        "description": "Every event Deckard sent: one per agent found, and one per scan saying how it went. Expand a row to see the whole event.",
        "columns": ["event_type", "source.name", "agent.name", "outcome.succeeded", "outcome.records_published", "outcome.error"],
        "sort": [["@timestamp", "desc"]],
        "timeRestore": true,
        "timeRange": {"from": "now-30d", "to": "now"},
        "kibanaSavedObjectMeta": {"searchSourceJSON": "{\"query\": {\"query\": \"\", \"language\": \"kuery\"}, \"filter\": [], \"indexRefName\": \"kibanaSavedObjectMeta.searchSourceJSON.index\"}"}
      },
      "references": [{"name": "kibanaSavedObjectMeta.searchSourceJSON.index", "type": "index-pattern", "id": "deckard"}]}' \
    -H 'kbn-xsrf: true'
  # The dashboards: "Deckard: this machine", for the scan of this machine the shipped
  # config publishes, and "Deckard: all sources", for more than one. The import answers 200
  # even when it refuses an object, so its body says whether it worked. A Kibana that
  # refuses them (an older one, if ELASTIC_VERSION was changed) opens on the findings
  # instead, rather than failing the setup.
  landing="/app/discover#/view/deckard-findings"
  if curl -sS -u "elastic:$ELASTIC_PASSWORD" -X POST "$KIBANA/api/saved_objects/_import?overwrite=true" \
    -H 'kbn-xsrf: true' -F 'file=@/setup/dashboards.ndjson' | grep -q '"success":true'; then
    landing="/app/dashboards#/view/deckard-this-machine"
  else
    echo "Kibana refused Deckard's dashboards, so it opens on Deckard findings"
  fi
  # Kibana opens on it after login, and any Discover search defaults to 30 days. Kibana 9
  # serves its advanced settings only on an internal API, so a Kibana that refuses this
  # keeps its defaults rather than failing the setup.
  call POST "$KIBANA/internal/kibana/settings" \
    "{\"changes\": {\"defaultRoute\": \"$landing\", \"timepicker:timeDefaults\": \"{\\\"from\\\": \\\"now-30d\\\", \\\"to\\\": \\\"now\\\"}\"}}" \
    -H 'kbn-xsrf: true' -H 'x-elastic-internal-origin: kibana' \
    || echo "Kibana kept its default landing page and time range"
  echo "Kibana is ready: http://localhost:5601$landing (user elastic)"
}

"$1"
