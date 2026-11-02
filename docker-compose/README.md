# Running Deckard with Docker Compose

```bash
./scan-local.sh
docker compose up -d --wait
```

Then open [Deckard findings](http://localhost:5601/app/discover#/view/deckard-findings) in
Kibana and log in as `elastic`, password `changeme`. You need Docker Compose 2.24 or later.

Or have a coding agent do it, checks and all: paste it this line.

```text
Download https://raw.githubusercontent.com/arthur-ai/deckard/main/docs/agent-setup/prompt.md with curl, read all of it, and follow its instructions to set up Arthur Deckard on this machine.
```

That's the whole setup: [`discovery.yaml`](discovery.yaml) works as shipped. It scans this
machine and sends what it finds to Elasticsearch, which runs in this Compose file with
Kibana beside it. Deckard scans once at startup, so its events are there within a minute.
Kibana opens on the Deckard findings view after login: every event Deckard sent over the
last 30 days, one per agent found and one per scan saying how it went, newest first. Expand a
row to see the whole event. Both kinds are described in [Events and alerting](../docs/events.md).

To see the agents from the terminal instead:

```bash
curl -s -u elastic:changeme 'localhost:9200/_query?format=txt' \
  -H 'Content-Type: application/json' \
  -d '{"query": "FROM logs-arthur.discovery-* | WHERE event_type == \"arthur.discovery.agent\" | KEEP @timestamp, agent.name, source.name | SORT @timestamp DESC"}'
```

## What runs

| Service | Does |
|---|---|
| `deckard` | Scans on the schedule in `discovery.yaml` |
| `elasticsearch` | Stores the events, at `localhost:9200`, in the `logs-arthur.discovery-default` data stream |
| `kibana` | Browses them, at `localhost:5601` |
| `elastic-setup` | Runs once: creates the `deckard` user Deckard sends as, which can only add documents to `logs-arthur.discovery-*`, and sets Kibana's own password |
| `kibana-setup` | Runs once: creates the `Deckard` data view and the Deckard findings view, which Kibana opens on after login, and makes Discover's time range default to the last 30 days |

- Both ports listen on this machine only. Deckard reaches Elasticsearch over Compose's
  private network, in plain HTTP.
- One password, `ELASTIC_PASSWORD` in `.env` (`changeme` if unset), is used for `elastic`,
  for Kibana's user and for `deckard`. Set your own and `docker compose up -d` again.
- The events are kept in the `elasticsearch-data` volume. `docker compose down -v` deletes
  them.
- Elasticsearch and Kibana take about 3.5 GB of memory between them, and a minute or so
  to start; Deckard waits for both to be set up, and `--wait` waits for all of it.
- This Elasticsearch is a single-node demo. It ignores its disk watermarks, so a nearly
  full disk doesn't stop it, and doesn't memory-map its files, so the host's
  `vm.max_map_count` needn't be raised. Don't keep data in it you can't lose.

## Scanning this machine

`scan-local.sh` runs Arthur's
[endpoint collector](https://github.com/arthur-ai/arthur-engine/tree/main/integrations/endpoint-ai-discovery),
which uses osquery to list the coding agents, desktop assistants, AI browsers and
extensions installed on this machine. It writes two files to `local-scan/`, which Compose
mounts into Deckard:

| File | Holds |
|---|---|
| `inventory.json` | what the collector found |
| `machine.json` | which machine it was: its hardware UUID on macOS, or `/etc/machine-id` on Linux, plus its hostname and OS version |

- It needs [osquery](https://osquery.io/downloads) and runs on macOS and Linux.
- It doesn't need root. Run as you, it sees what you can read, which on a laptop is where
  these tools install.
- It downloads the collector pinned to one arthur-engine commit, and won't run it if the
  download doesn't match the pinned hash.
- Deckard re-reads `local-scan/` every interval (1 hour in the shipped config), but the
  folder only changes when you run `./scan-local.sh` again. To publish a new scan now,
  `docker compose restart deckard`. A scan more than 7 days old is not published.

## Adding sources

Uncomment or add sources in `discovery.yaml`. Each one is documented in the
[configuration reference](https://github.com/arthur-ai/arthur-engine/blob/main/ml-engine/docs/standalone-discovery.md).
Keep their credentials out of the file:

- values it references as `${NAME}` go in `.env` (start from `.env.template`);
- files it references as `{file: secrets/...}` go in `secrets/`, e.g. a GCP service
  account key at `secrets/gcp-key.json`.

`.env`, `secrets/` and `local-scan/` are gitignored. Then apply the change:

```bash
docker compose up -d --wait --force-recreate deckard
```

Deckard reads `discovery.yaml` and `.env` only when its container starts, and Compose
doesn't notice an edited file by itself (an editor that saves by replacing the file even
leaves the running container on the old one), so this recreates it. Do the same after
every change to either file.

## Sending to your SIEM

Replace the `destination` in `discovery.yaml` with one of the commented examples beneath it
(your own Elasticsearch or Elastic Security, Splunk HEC, or your own HTTPS endpoint), put
its credential in `.env`, and apply it with
`docker compose up -d --wait --force-recreate deckard`. The Elasticsearch and Kibana here
keep running but get nothing new; remove them from `docker-compose.yaml` if you like, along
with Deckard's `depends_on`.

## Troubleshooting

Start with `./preflight.sh`. It only reads, and checks what the quickstart needs: Docker
running and usable by you, its memory and disk, Compose 2.24 or later, free ports, osquery
and the machine ID, printing the command to fix each one that fails.

Each scan sends an outcome event, which Discover finds with `outcome.succeeded : false`
when one fails, saying why in `outcome.error`. Deckard logs the same outcome:
`docker compose logs deckard`.

| The outcome says | Do this |
|---|---|
| `… machine.json does not exist` | Run `./scan-local.sh`. Deckard reads its output; it can't scan the host itself |
| a scan too old to publish | Run `./scan-local.sh` again |
| nothing in Discover at all | Open the [Deckard findings](http://localhost:5601/app/discover#/view/deckard-findings) view, which covers 30 days (plain Discover may cover only the last 15 minutes). Still nothing: `docker compose logs deckard`. A config Deckard can't use stops it at startup, naming the problem, and a destination that refuses events is logged there too |
| `docker compose up` fails at `elastic-setup` | `docker compose logs elastic-setup` says why |

`scan-local.sh` says so if osquery is missing, and prints the collector's own output if the
scan fails.

## Notes

- Deckard runs as UID `65532`, which must be able to read `discovery.yaml` and everything in
  `secrets/` and `local-scan/`. `scan-local.sh` sets that for its own files. For `secrets/`
  on Linux, `chmod` or `chown` accordingly, and keep it unreadable to anyone else.
- The image is built for `linux/amd64` and `linux/arm64`, so it runs natively on Apple
  Silicon and Intel alike. Deckard 0.1.0 was amd64 only; Docker Desktop runs it under
  emulation.
- This checkout runs the `arthurplatform/deckard` image of its own version. Set
  `DECKARD_VERSION` in `.env` to run a different
  [release](https://github.com/arthur-ai/deckard/releases), and `ELASTIC_VERSION` to
  run another Elasticsearch and Kibana.
- `stop_grace_period` is 30s so running scans get Deckard's 15-second drain before the
  container is killed.
