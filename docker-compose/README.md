# Running Deckard with Docker Compose

```bash
../start.sh
```

It runs `preflight.sh`, `scan-local.sh` and `docker compose up -d --wait`, waits for Deckard's
first scan, and prints the agents found. Then open the viewer at
[localhost:7493](http://localhost:7493). You need Docker Compose 2.24 or later.

Or have a coding agent do it, checks and all: paste it this line.

```text
Download https://raw.githubusercontent.com/arthur-ai/deckard/main/docs/agent-setup/prompt.md with curl, read all of it, and follow its instructions to set up Arthur Deckard on this machine.
```

That's the whole setup: [`discovery.yaml`](discovery.yaml) works as shipped. It scans this
machine and sends what it finds to Elasticsearch, which runs in this Compose file with
Deckard's viewer beside it. Deckard scans once at startup, so its events are there within a
minute. The viewer shows one row per agent, however many scans reported it, and marks the
ones the latest successful scan no longer reports. Its Sources tab shows each source's recent
scans and why any failed. Both kinds of event are described in
[Events and alerting](../docs/events.md).

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
| `viewer` | Shows them, at `localhost:7493`: Node running [`viewer/`](viewer/), with no dependencies to install |
| `elastic-setup` | Runs once: creates the `deckard` user Deckard sends as, which can only add documents to `logs-arthur.discovery-*`, and the `deckard_viewer` user the viewer reads as, which can only read them |

- Both ports listen on this machine only, and the viewer has no login: anyone who can reach
  `localhost:7493` on this machine sees what Deckard found. Deckard and the viewer reach
  Elasticsearch over Compose's private network, in plain HTTP. The browser never talks to
  Elasticsearch, only to the viewer's own few questions about Deckard's events.
- One password, `ELASTIC_PASSWORD` in `.env` (`changeme` if unset), is used for `elastic`,
  `deckard` and `deckard_viewer`. Set your own and `docker compose up -d` again.
- The events are kept in the `elasticsearch-data` volume. `docker compose down -v` deletes
  them.
- Elasticsearch takes a few GB of memory and up to a minute to start; Deckard and the viewer
  wait for it to be set up, and `--wait` waits for all of it.
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
`docker compose up -d --wait --force-recreate deckard`. The Elasticsearch here keeps
running but gets nothing new. If your destination is Elasticsearch, point the viewer at it too:
set `VIEWER_ES_URL` and `VIEWER_ES_API_KEY` (a key with `read` on `logs-arthur.discovery-*`)
in `.env`, and `docker compose up -d --wait viewer`.

## Troubleshooting

Start with `./preflight.sh`. It only reads, and checks what the quickstart needs: Docker
running and usable by you, its memory and disk, Compose 2.24 or later, free ports, osquery
and the machine ID, printing the command to fix each one that fails.

Each scan sends an outcome event. A failed one shows in the viewer under Needs attention
and on its Sources tab, saying why. Deckard logs the same outcome:
`docker compose logs deckard`.

| The outcome says | Do this |
|---|---|
| `… machine.json does not exist` | Run `./scan-local.sh`. Deckard reads its output; it can't scan the host itself |
| a scan too old to publish | Run `./scan-local.sh` again |
| nothing in the viewer at all | `docker compose logs deckard`. A config Deckard can't use stops it at startup, naming the problem, and a destination that refuses events is logged there too |
| the viewer says it can't load Deckard's events | It names the problem: `docker compose logs viewer` for more |
| `docker compose up` fails at `elastic-setup` | `docker compose logs elastic-setup` says why |
| Compose warns of orphan containers `kibana` and `kibana-setup` | Left from before the viewer replaced Kibana: `docker compose up -d --wait --remove-orphans` removes them |

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
  run another Elasticsearch.
- `stop_grace_period` is 30s so running scans get Deckard's 15-second drain before the
  container is killed.
