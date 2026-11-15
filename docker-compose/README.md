# Running Deckard with Docker Compose

```bash
../start.sh
```

It runs `preflight.sh`, `scan-local.sh` and `docker compose up -d --wait`, waits for Deckard's
first scan, and prints the agents found. Then open
[Deckard: this machine](http://localhost:5601/app/dashboards#/view/deckard-this-machine) in Kibana and log in as `elastic`, password `changeme`. You need Docker Compose 2.24 or later.

Or have a coding agent do it, checks and all: paste it this line.

```text
Download https://raw.githubusercontent.com/arthur-ai/deckard/main/docs/agent-setup/prompt.md with curl, read all of it, and follow its instructions to set up Arthur Deckard on this machine.
```

That's the whole setup: [`discovery.yaml`](discovery.yaml) works as shipped. It scans this
machine and sends what it finds to Elasticsearch, which runs in this Compose file with
Kibana beside it. Deckard scans once at startup, so its events are there within a minute.
Kibana opens on the "Deckard: this machine" dashboard after login (see [The dashboards](#the-dashboards)).
Behind it, [Deckard findings](http://localhost:5601/app/discover#/view/deckard-findings) lists
every event Deckard sent over the last 30 days, one per agent found and one per scan saying
how it went, newest first. Expand a row to see the whole event. Both kinds are described in
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
| `kibana` | Browses them, at `localhost:5601` |
| `elastic-setup` | Runs once: creates the `deckard` user Deckard sends as, which can only add documents to `logs-arthur.discovery-*`, sets Kibana's own password, and maps the fields the dashboards read ([`elastic/fields.json`](elastic/fields.json)) |
| `kibana-setup` | Runs once: creates the `Deckard` data view, the Deckard findings view and the two dashboards ([`elastic/dashboards.ndjson`](elastic/dashboards.ndjson)), the first of which Kibana opens on after login, and makes Discover's time range default to the last 30 days |

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

## The dashboards

Deckard reports every agent again on each run, so both dashboards count an agent once per
machine or cloud account, however many events reported it.

### Deckard: this machine

[Deckard: this machine](http://localhost:5601/app/dashboards#/view/deckard-this-machine) is
the page Kibana opens on. It shows only what `scan-local.sh` found, over the last 30 days
unless you change the time range.

| It shows | From |
|---|---|
| AI agents on this machine | the agents in the latest machine scan |
| Added since the first scan, No longer found | agents whose first machine scan is later than the first one in the time range, and agents an earlier scan had that the latest does not |
| The machine, and the time since its scan | green under a day, amber up to 7 days, red after: Deckard stops publishing a scan that old. Run `./scan-local.sh` (or `../start.sh`) to rescan |
| Failed runs | runs that failed in the last 24 hours, with how many succeeded |
| The agents | one row each: category, version (and the earlier one if it changed), what it was found as, where it is installed, and whether it is still there |
| What they are | each agent as a box, grouped and coloured by category |
| How they were identified, Where they are installed | identifier type and install location, each split by category |
| How each agent was identified | the identifier that matched (a bundle id, a package name, an extension id) and where it was found |
| Permissions requested by browser extensions | what each extension's manifest asks for; empty without an AI browser extension |
| Deckard's runs | the last run, its result, and the last problem with its message |

- A scan is two things here. `scan-local.sh` scans the machine; a run is Deckard reading that
  scan and publishing it, once an hour. The numbers follow the machine scan.
- Deckard reports one identifier per agent, the strongest match: an install record before a
  file or a running process. An agent installed two ways shows one of them.
- Found means installed or present on disk, not that it is running.
- Sources you add later do not appear on this dashboard; use the other one.

### Deckard: all sources

[Deckard: all sources](http://localhost:5601/app/dashboards#/view/deckard-all-sources) is for
more than one machine: agents found across every source over the last 7 days, the most common
ones, their categories, where they run, how the count moves per day, an inventory, and the
health of each source's scans. Filter it by source, category or agent, or by clicking a bar
or a slice. An agent that was removed stays counted there until its last report leaves the
time range.

### Changing them

- `kibana-setup` installs both again on every `docker compose up`, replacing changes made to
  them in Kibana. To keep your own version, duplicate a dashboard in Kibana and edit the copy.
- To change the ones that ship, edit them in Kibana and export both over
  `elastic/dashboards.ndjson` (Stack Management > Saved Objects, without related objects). An
  export only imports into that version of Kibana or a later one.
- If you send Deckard's events to your own Elasticsearch, import `elastic/dashboards.ndjson`
  into your Kibana the same way, and pick a data view over `logs-arthur.discovery-*` when it
  asks. They are built for Kibana and Elasticsearch 9.5; on an older version some panels may
  not load.

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

Each scan sends an outcome event. The dashboards count the ones that failed and give the
reason for each source; Discover finds them with `outcome.succeeded : false`, saying why in
`outcome.error`. Deckard logs the same outcome: `docker compose logs deckard`.

| The outcome says | Do this |
|---|---|
| `… machine.json does not exist` | Run `./scan-local.sh`. Deckard reads its output; it can't scan the host itself |
| a scan too old to publish | Run `./scan-local.sh` again |
| nothing in Discover at all | Open the [Deckard findings](http://localhost:5601/app/discover#/view/deckard-findings) view, which covers 30 days (plain Discover may cover only the last 15 minutes). Still nothing: `docker compose logs deckard`. A config Deckard can't use stops it at startup, naming the problem, and a destination that refuses events is logged there too |
| Kibana opens on Deckard findings, not a dashboard | Kibana refused the dashboards: `docker compose logs kibana-setup` says so. They are built for the `ELASTIC_VERSION` this checkout pins |
| the dashboard says the scan is days old | Deckard publishes the scan `scan-local.sh` last took; it does not scan the machine itself. Run `./scan-local.sh` and `docker compose restart deckard`, or `../start.sh` |
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
