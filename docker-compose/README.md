# Running Deckard with Docker Compose

```bash
../start.sh
```

It runs `preflight.sh`, then `scan-local.sh` while it starts Elasticsearch and the viewer, and
opens the viewer's welcome page at [localhost:7493](http://localhost:7493/#welcome), where you
can add cloud, MDM and SIEM sources while the scan runs. Then it starts Deckard, waits for its
first scan, and prints the agents found. You need Docker Compose 2.24 or later.

On a terminal it keeps running after that, so the viewer's **Scan now** can scan this machine
again: the scan has to run on the host, which the viewer's container can't reach. The two pass
requests and results through `runner/` (see [`viewer/localscan.mjs`](viewer/localscan.mjs)).
Ctrl-C stops it and leaves Deckard running. Without a terminal, as under a coding agent, it
exits once it has printed the agents. `DECKARD_NO_BROWSER=1` keeps it from opening a browser.

On Windows, run the two steps yourself, from PowerShell ([On Windows](#on-windows)):

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scan-local.ps1
docker compose up -d --wait
```

Or, on macOS or Linux, have a coding agent do it, checks and all: paste it this line.

```text
Download https://raw.githubusercontent.com/arthur-ai/deckard/main/docs/agent-setup/prompt.md with curl, read all of it, and follow its instructions to set up Arthur Deckard on this machine.
```

That's the whole setup: [`discovery.yaml`](discovery.yaml) works as shipped. It scans this
machine and sends what it finds to Elasticsearch, which runs in this Compose file with
Deckard's viewer beside it. Deckard scans once at startup, so its events are there within a
minute. The viewer shows one row per agent, however many scans reported it, and marks the
ones the latest successful scan no longer reports. Its Sources tab shows each source's recent
scans and why any failed, and a **Scan now** button on each cloud, MDM and SIEM source
that asks Deckard to scan it without waiting for the next interval. Both kinds of event are described in
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
| `control-token` | Runs once: makes the random token the viewer shows Deckard to ask for a scan, kept in the `control` volume that only those two mount |

- Both ports listen on this machine only, and the viewer has no login: anyone who can reach
  `localhost:7493` on this machine sees what Deckard found. Deckard and the viewer reach
  Elasticsearch over Compose's private network, in plain HTTP. The browser never talks to
  Elasticsearch, only to the viewer's own few questions about Deckard's events.
- **Add source** and **Edit** write `discovery.yaml` and `secrets/`, which the viewer has
  mounted writable. Anyone who can load `localhost:7493` can add, change and test sources,
  and a test of an edited source can use the secrets it already has. So the same rules as
  Scan now apply: the viewer accepts a change only from its own page loaded as
  `localhost`. A value containing `${` is refused, so a form can't make Deckard read an
  environment variable into a source.
- **Scan now** goes from the viewer to Deckard's control API on port 7494, which only
  Compose's private network can reach and which needs the token. That API can only bring a
  configured scan forward: it takes no config, credentials or destination, and a source
  already scanning isn't started twice. The viewer accepts the request only from its own
  page loaded as `localhost`, so another website you visit can't send it. A Deckard release
  without the control API shows no buttons, and says why on the Sources tab.
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
| `machine.json` | which machine it was: its hardware UUID on macOS, `/etc/machine-id` on Linux, or `MachineGuid` on Windows, plus its hostname and OS version |

- It needs [osquery](https://osquery.io/downloads) and runs on macOS and Linux.
- It doesn't need root. Run as you, it sees what you can read, which on a laptop is where
  these tools install.
- It downloads the collector pinned to one arthur-engine commit, and won't run it if the
  download doesn't match the pinned hash.
- Deckard re-reads `local-scan/` every interval (1 hour in the shipped config), but the
  folder only changes when you run `./scan-local.sh` again. To publish a new scan now,
  `docker compose restart deckard`, or use **Scan now** in the viewer while `../start.sh` runs,
  which does both. A scan more than 7 days old is not published.

### On Windows

`scan-local.ps1` does the same from PowerShell. It downloads the collector's Windows
build, pinned and checked the same way, runs it, and writes the same two files:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\scan-local.ps1
```

- It needs [osquery](https://osquery.io/downloads) 5.17.0 or later: the Windows installer
  (`.msi`). The installer also starts osquery's own background service, `osqueryd`, which
  Deckard doesn't use; `Stop-Service osqueryd; Set-Service osqueryd -StartupType Disabled`
  from an administrator PowerShell turns it off.
- It doesn't need an administrator. Run as you, it sees what you can read. Windows lists
  the apps a user installed for themselves only while that user is signed in, so it finds
  yours, not those of other people on the machine who are signed out.
- From an administrator PowerShell, the collector refuses to write into a folder that
  other accounts can write in, and names them. A clone outside your user folder is usually
  one. Run it from an ordinary PowerShell window instead, or from a clone in your user
  folder.
- `-ExecutionPolicy Bypass` lets Windows run this one script file this once, since by
  default it runs none. Nothing is changed for other scripts.
- If you downloaded the repository as a ZIP rather than cloning it, Windows marks the file
  as downloaded; run `Unblock-File .\scan-local.ps1` first.
- A machine whose IT allows signed scripts only (an `AllSigned` execution policy set by
  Group Policy) won't run it, and `-ExecutionPolicy Bypass` can't override that. Where
  AppLocker or Windows Defender Application Control restricts unsigned scripts to
  PowerShell's ConstrainedLanguage mode, it runs unchanged: it and the collector use only
  what that mode allows.
- Its last line says `degraded` on a machine with Docker installed, which running Deckard
  needs. osquery reads no containers on Windows, and the collector says so rather than
  report none. The rest of the scan is complete.
- As with `scan-local.sh`, Deckard picks up a new scan at its next interval, or now with
  `docker compose restart deckard`.

## Adding sources

The easy way is **Add source** on the viewer's Sources tab:

1. Pick a kind of source. The forms are the Arthur Platform's, with the same fields
   and help.
2. Fill it in, and **Test connection**. Deckard reads a preview from the source and
   shows the first agents it finds, or the vendor's error. Nothing is published.
3. **Add source**. The viewer adds it to `discovery.yaml`, with each secret in its own
   file in `secrets/`. Deckard notices the change and starts scanning it within seconds.

**Edit** on a source's card changes it the same way, and **Remove** takes it out. Leave a
secret blank to keep the one it has. The viewer changes only that source's lines in
`discovery.yaml`; every other line and comment stays as you wrote it.

To do it by hand instead, uncomment or add sources in `discovery.yaml`. Each one is documented in the
[configuration reference](https://github.com/arthur-ai/arthur-engine/blob/main/ml-engine/docs/standalone-discovery.md).
Keep their credentials out of the file:

- values it references as `${NAME}` go in `.env` (start from `.env.template`);
- files it references as `{file: secrets/...}` go in `secrets/`, e.g. a GCP service
  account key at `secrets/gcp-key.json`.

`.env`, `secrets/` and `local-scan/` are gitignored. Deckard watches `discovery.yaml` and
the files in `secrets/` it reads, and applies a change to its sources within seconds; the
viewer's Sources tab says so if it can't use the file as you left it. Two changes still
need Deckard recreated:

- a new or changed value in `.env`, which a container reads only when it is created;
- a `discovery.yaml` saved by an editor that replaces the file rather than writing it in
  place, which leaves the running container on the old one.

```bash
docker compose up -d --wait --force-recreate deckard
```

A change to `schedule`, `destination` or `emit_scan_outcomes` needs only a restart:
`docker compose restart deckard`.

## Sending to your SIEM

Replace the `destination` in `discovery.yaml` with one of the commented examples beneath it
(your own Elasticsearch or Elastic Security, Splunk HEC, or your own HTTPS endpoint), put
its credential in `.env`, and apply it with
`docker compose up -d --wait --force-recreate deckard`. The Elasticsearch here keeps
running but gets nothing new. If your destination is Elasticsearch, point the viewer at it too:
set `VIEWER_ES_URL` and `VIEWER_ES_API_KEY` (a key with `read` on `logs-arthur.discovery-*`)
in `.env`, and `docker compose up -d --wait viewer`.

## Troubleshooting

Start with `./preflight.sh` (macOS and Linux). It only reads, and checks what the quickstart
needs: Docker running and usable by you, its memory and disk, Compose 2.24 or later, free
ports, osquery and the machine ID, printing the command to fix each one that fails.

Each scan sends an outcome event. A failed one shows in the viewer under Needs attention
and on its Sources tab, saying why. Deckard logs the same outcome:
`docker compose logs deckard`.

| The outcome says | Do this |
|---|---|
| `… machine.json does not exist` | Run `./scan-local.sh` (`scan-local.ps1` on Windows). Deckard reads its output; it can't scan the host itself |
| a scan too old to publish | Run `./scan-local.sh` (`scan-local.ps1` on Windows) again |
| nothing in the viewer at all | `docker compose logs deckard`. A config Deckard can't use stops it at startup, naming the problem, and a destination that refuses events is logged there too |
| the viewer says it can't load Deckard's events | It names the problem: `docker compose logs viewer` for more |
| the Sources tab says adding sources is unavailable | It names the problem. "can't add sources yet" means this Deckard release has no source routes |
| saving a source says the viewer can't write | Set `VIEWER_UID` in `.env` to the owner of `discovery.yaml` and `secrets/` (`id -u`), then `docker compose up -d --wait viewer` |
| the Sources tab says Scan now is unavailable | It names the problem. "can't be reached" while Deckard is up means this Deckard release has no control API yet |
| `docker compose up` fails at `elastic-setup` | `docker compose logs elastic-setup` says why |
| Compose warns of orphan containers `kibana` and `kibana-setup` | Left from before the viewer replaced Kibana: `docker compose up -d --wait --remove-orphans` removes them |

`scan-local.sh` says so if osquery is missing, and prints the collector's own output if the
scan fails. `scan-local.ps1` does the same, and also says if osquery is older than the
Windows scan needs.

## Notes

- Deckard runs as UID `65532`, which must be able to read `discovery.yaml` and everything in
  `secrets/` and `local-scan/`. `scan-local.sh` sets that for its own files. For `secrets/`
  on Linux, `chmod` or `chown` accordingly, and keep it unreadable to anyone else. The
  viewer does this for the secrets it writes: it runs as you (`VIEWER_UID`, which
  `start.sh` sets) in Deckard's group, and writes them readable by that group only.
- The image is built for `linux/amd64` and `linux/arm64`, so it runs natively on Apple
  Silicon and Intel alike. Deckard 0.1.0 was amd64 only; Docker Desktop runs it under
  emulation.
- This checkout runs the `arthurplatform/deckard` image of its own version. Set
  `DECKARD_VERSION` in `.env` to run a different
  [release](https://github.com/arthur-ai/deckard/releases), and `ELASTIC_VERSION` to
  run another Elasticsearch.
- `stop_grace_period` is 30s so running scans get Deckard's 15-second drain before the
  container is killed.
