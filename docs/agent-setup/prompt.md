# Set up Arthur Deckard: instructions for a coding agent

You are a coding agent on the user's own machine. These steps take the user from nothing to
Deckard's findings in their browser, then, if they want, connect a real discovery source and
destination. Deckard is Arthur's open-source, read-only scanner for AI agents:
https://github.com/arthur-ai/deckard. Follow the phases in order.

## Rules

1. **Run each command yourself, as written**, and read its output. Replace `<DECKARD_DIR>`
   with the absolute path from Phase 2. Every block starts with `cd` because your shell may
   not keep the directory between commands.
2. **Never run `sudo`, install software, or change system settings** (services, users and
   groups, kernel settings), even if you could. A step that needs any of that is the user's:
   **[STOP]**.
3. **[STOP]** means: tell the user what failed and why, give them the exact command(s) to
   run themselves (for Phase 3, every `FIX:` line exactly as printed), tell them to ask you to
   follow these instructions again once done, and end. Don't look for another way.
4. **[ASK USER]** means: ask that question and wait for the answer. Never guess it. Ask
   before deleting anything.
5. **Never print or repeat a secret.** The only password you may show is the local demo
   password: `changeme`, unless `.env` sets `ELASTIC_PASSWORD`.
6. You cannot open a browser. Print URLs for the user.
7. After each phase, tell the user in a line what passed.

## Phase 1: Tools to get Deckard

```bash
command -v git && command -v curl
```

If either is missing, **[STOP]**: on macOS the fix is `xcode-select --install`; on Linux,
`sudo apt-get install -y git curl` (Debian, Ubuntu) or `sudo dnf install -y git curl`
(Fedora, RHEL).

## Phase 2: Get Deckard

Use an existing checkout if there is one, else clone:

- If `git remote get-url origin` in the current directory names `arthur-ai/deckard` or
  `arthur-ai/arthur-deckard`, `<DECKARD_DIR>` is `git rev-parse --show-toplevel`.
- Else, if `./deckard` is such a checkout, `<DECKARD_DIR>` is its absolute path.
- Else run this, and `<DECKARD_DIR>` is the path it prints:

```bash
git clone https://github.com/arthur-ai/deckard.git && cd deckard && pwd
```

Then make the files the containers read readable to them (a strict umask can block it):

```bash
cd <DECKARD_DIR>/docker-compose && chmod a+r discovery.yaml elastic/setup.sh && chmod a+rx elastic secrets local-scan && git -C <DECKARD_DIR> log -1 --format='%h %s'
```

## Phase 3: Pre-flight

```bash
cd <DECKARD_DIR>/docker-compose && ./preflight.sh
```

It only reads. It checks the OS, the network, Docker (running, usable by this user, memory,
disk), Docker Compose 2.24 or later, ports 9200 and 7493, osquery, and the machine ID.

- Last line `PREFLIGHT OK`: tell the user about any `WARN` line, and go on.
- Last line `PREFLIGHT FAILED`: **[STOP]**. Show the user each `FAIL` line with the `FIX:`
  lines under it, exactly as printed. Don't run any `FIX:` yourself, even one without `sudo`.

## Phase 4: Scan this machine

```bash
cd <DECKARD_DIR>/docker-compose && ./scan-local.sh && cat local-scan/status.txt
```

It downloads Arthur's endpoint collector, checks it against a pinned hash, runs it with
osquery for about 10 seconds and writes `local-scan/`. It needs no root.

**Success:** it ends with `Done: ...`. If it fails:

| It says | Do this |
|---|---|
| `could not download the collector` | **[STOP]**: a network or proxy problem (`curl -fsSI https://raw.githubusercontent.com` shows it) |
| `does not match its pinned hash; not running it` | **[STOP]**. Never work around it: something altered the download, or the checkout is inconsistent (`git -C <DECKARD_DIR> status`) |
| `the collector failed`, with its output | `permission denied` on other users' folders is normal. On macOS, a privacy prompt for osqueryi may be waiting: ask the user to allow it, then run this again. Anything else: **[STOP]** with the output |
| `osquery is not installed`, `could not read this machine's id` | Phase 3 missed it: run `./preflight.sh` again |

## Phase 5: Start Deckard, Elasticsearch and the viewer

Use a command timeout of at least 15 minutes: the first run downloads about 1.4 GB of images.

```bash
cd <DECKARD_DIR>/docker-compose && docker compose up -d --wait --remove-orphans; docker compose ps -a --format 'table {{.Service}}\t{{.Status}}'
```

**Success:** `deckard`, `elasticsearch` and `viewer` are `(healthy)`, and `elastic-setup` is
`Exited (0)`. Deckard scans once at startup, so its first events land
within about a minute.

If it fails, find the first service that isn't, and read its log
(`docker compose logs --tail 80 <service>`):

| Symptom | Do this |
|---|---|
| `toomanyrequests` or `unauthorized` pulling from Docker Hub | **[STOP]**: the user runs `docker login` |
| only `docker.elastic.co` can't be reached | Elastic publishes the same images on Docker Hub: `docker pull elasticsearch:9.5.5 && docker tag elasticsearch:9.5.5 docker.elastic.co/elasticsearch/elasticsearch:9.5.5` (use `ELASTIC_VERSION` from `.env` if it sets one), then run Phase 5 again |
| other pull errors, `i/o timeout`, `TLS handshake timeout` | **[STOP]**: a proxy or VPN; the user sets Docker's proxy settings |
| `port is already allocated` | run `./preflight.sh` again and follow it |
| `elasticsearch` log has `OutOfMemoryError`, or exit code 137 | **[STOP]**: Docker needs more memory (Docker Desktop: Settings > Resources > Memory, 6 GB) |
| `elasticsearch` log has `AccessDeniedException` on its data | **[ASK USER]** "May I delete the local Deckard data with `docker compose down -v`?" If yes, run it, then Phase 5 again |
| `elastic-setup` log says `refused ELASTIC_PASSWORD` | the stored data keeps an older password. **[ASK USER]** whether to delete the data as above, or to set that password as `ELASTIC_PASSWORD` in `.env` themselves (as for a secret, 8.3) |
| `Permission denied` on `/setup/setup.sh` or `discovery.yaml` | run Phase 2's `chmod` line, then Phase 5 again |
| `elasticsearch` not healthy | it is slow on a first start: run Phase 5 once more |
| `viewer` not healthy | `docker compose logs --tail 20 viewer` says what Elasticsearch answered it; `refused the viewer's credentials` means `elastic-setup` didn't run: Phase 5 again |
| `deckard` restarting | its log names the config problem: fix it (Phase 8) |

If the same failure repeats, **[STOP]** with the log lines.

## Phase 6: Check the findings arrived

```bash
cd <DECKARD_DIR>/docker-compose && PW=$(sed -n "s/^ELASTIC_PASSWORD=['\"]\{0,1\}\([^'\"]*\).*/\1/p" .env 2>/dev/null | tail -n 1); PW=${PW:-changeme}
count() { curl -s -u "elastic:$PW" -H 'Content-Type: application/json' 'http://localhost:9200/logs-arthur.discovery-*/_count' -d "{\"query\":{\"query_string\":{\"query\":\"$1\"}}}" | sed -n 's/.*"count":\([0-9]*\).*/\1/p'; }
scan='event_type:\"arthur.discovery.scan_outcome\" AND source.name:\"this-machine\"'
for i in $(seq 1 60); do [ "$(count "$scan")" -gt 0 ] 2>/dev/null && break; sleep 5; done
echo "successful scans: $(count "$scan AND outcome.succeeded:true") of $(count "$scan")"
echo "agents found:     $(count 'event_type:\"arthur.discovery.agent\" AND source.name:\"this-machine\"')"
curl -s -o /dev/null -w 'viewer:           HTTP %{http_code}\n' 'http://localhost:7493/api/overview'
curl -s -u "elastic:$PW" 'http://localhost:9200/_query?format=txt' -H 'Content-Type: application/json' \
  -d '{"query": "FROM logs-arthur.discovery-* | WHERE event_type == \"arthur.discovery.agent\" | STATS last_reported = MAX(@timestamp) BY agent.name, source.name | SORT agent.name"}'
```

**Success:** at least `1` successful scan, and `viewer: HTTP 200`. `agents found: 0`
after a successful scan is a real result: none of the agents in the catalog are installed.

- `of 0` after five minutes: `docker compose logs --tail 50 deckard` names the problem.
- No successful scan: `docker compose logs --no-log-prefix deckard | grep '"succeeded"' | tail -n 1`
  shows `error`. `machine.json does not exist` or a scan too old: run Phase 4, then
  `docker compose restart deckard`, and this phase again.
- `viewer:` anything but `HTTP 200`: `docker compose logs --tail 20 viewer`, then Phase 5 again.

## Phase 7: Give the user the link

Only after Phase 6 passed, print this with the agent list from Phase 6:

> **Deckard is running.** Open http://localhost:7493 to see the AI agents it found.
>
> Each agent shows where it is, what kind it is, and when Deckard first and last saw it.
> Click one for everything its source reported. **Needs attention**, at the top, lists new
> agents and any scan that failed or couldn't see all of its scope, and the **Sources** tab
> shows how each source's recent scans went.

## Phase 8: Connect a real source and destination

**[ASK USER]** "Deckard works on this machine. Would you like to connect a real discovery
source (cloud, MDM, network logs or SIEM) and send results to your own SIEM? (yes / not now)"
If not now, give them the Appendix and end.

### 8.1 Choose

Read `<DECKARD_DIR>/docs/agent-setup/integrations.md`: it has the menus and a card per source
and destination. Ask one question at a time:

1. **[ASK USER]** which source to add, from its source menu. Tell them that card's
   **Prerequisites**; if they lack one, give them the link and offer to stop there.
2. **[ASK USER]** "Keep scanning this machine too? (yes / no)". Default yes.
3. **[ASK USER]** which destination, from its destination menu. Moving off the local
   Elasticsearch means the viewer gets nothing new, unless the new destination is an
   Elasticsearch it can read (the `elasticsearch` card in integrations.md says how).

### 8.2 Back up the config

```bash
cd <DECKARD_DIR>/docker-compose && cp discovery.yaml "discovery.yaml.bak-$(date +%Y%m%d%H%M%S)" && ls discovery.yaml.bak-*
```

### 8.3 Collect the values

- **Not secret** (URLs, project IDs, regions): ask for them; offer the card's default.
- **Secrets** (*secret* in the cards): never ask for them in the chat. Clear the variable's
  old line (here `SPLUNK_HEC_TOKEN`; use the card's name):
  ```bash
  cd <DECKARD_DIR>/docker-compose && { [ -f .env ] || cp .env.template .env; } && chmod 600 .env && sed -i.bak '/^SPLUNK_HEC_TOKEN=/d' .env && rm -f .env.bak
  ```
  Then the user types it into their own terminal. Give them this, with the name and label
  changed (it works in bash and zsh):
  ```bash
  cd <DECKARD_DIR>/docker-compose && printf 'Splunk HEC token: ' && stty -echo && IFS= read -r v; stty echo; printf '\n'; printf "SPLUNK_HEC_TOKEN='%s'\n" "$v" >> .env; unset v
  ```
  When they say it's done, `grep -c "^SPLUNK_HEC_TOKEN='..*'" .env` must print `1`. A value
  can't contain `'`. If the user pastes a secret into the chat anyway, write it to `.env`
  the same way without repeating it, and suggest they rotate it.
- **Secret files** (a GCP key, a CA certificate): ask for the file's path (not secret) and
  copy it under the card's name. Deckard's container (UID 65532) must be able to read it:
  ```bash
  cd <DECKARD_DIR>/docker-compose && cp "<path>" secrets/gcp-key.json && chmod 644 secrets/gcp-key.json
  ```
  On Linux, tell the user other local users can read it, and that to lock it to Deckard they
  can run `sudo chown 65532:65532 secrets/gcp-key.json && sudo chmod 600 secrets/gcp-key.json`
  themselves.

### 8.4 Edit `discovery.yaml`

- Add the source's block from its card under `sources:`. Keep `this-machine` unless the user
  said no. Source names must be unique.
- Replace the whole `destination:` block with the card's, unless keeping the local one.
- Secrets appear only as `${NAME}` or `{file: secrets/...}`, never as values.
- Keep each `lookback_window_seconds` at least the `schedule.interval` (`1h` is 3600).

Then check it:

```bash
cd <DECKARD_DIR>/docker-compose && chmod a+r discovery.yaml && docker compose run --rm --no-deps --entrypoint python deckard -c "import sys; sys.path.insert(0, 'src/ml_engine'); from pathlib import Path; from standalone.discovery_config import load_config; load_config(Path('/etc/deckard/discovery.yaml')); print('discovery.yaml OK')"
```

**Success:** the last line is `discovery.yaml OK`. Otherwise it names the field or the unset
variable: fix it and check again. (An `ImportError` means this Deckard release moved the
check: skip it and rely on 8.5.)

### 8.5 Apply and verify

Deckard reads `discovery.yaml` and `.env` only when its container starts, and Compose doesn't
notice an edited file, so **after every change to either, recreate it**:

```bash
cd <DECKARD_DIR>/docker-compose && docker compose up -d --wait --no-deps --force-recreate deckard
```

Then wait for the new source's first scan (up to 5 minutes; a large cloud source can take
15), replacing `<source name>` with its `name`:

```bash
cd <DECKARD_DIR>/docker-compose && for i in $(seq 1 60); do docker compose logs --no-log-prefix deckard | grep -q '^INFO:standalone.scan.<source name>/.*"succeeded"' && break; sleep 5; done; docker compose logs --no-log-prefix deckard | grep '"succeeded"' | tail -n 4
```

Each line is one scan's outcome as JSON. **Success:** the new source's line has
`"succeeded": true`, and no line's `error_code` is `publication_failed`. Then do the
destination card's **Verify** (ask the user what they see).

| `error_code` | Fix |
|---|---|
| `not_configured` | a field is missing or wrong (`error` names it), or a SIEM query's columns aren't the contract's |
| `credentials_unavailable` | a `${NAME}` is empty, or a key file is missing or unreadable (8.3) |
| `authentication_failed` | the credential was refused: the user enters it again (8.3) |
| `permission_denied` | the credential lacks the permission on the source's card |
| `provider_error` | the provider errored or couldn't be reached: URL, region, network |
| `publication_failed` | the destination refused the events: its URL, token or index permissions |

After any fix to `discovery.yaml` or `.env`, run 8.5 again.

### 8.6 Finish

Tell the user which sources run, where events go, how often (`schedule.interval`, `1h` as
shipped), where the `discovery.yaml.bak-*` backup is, and the Appendix. `.env` and `secrets/`
hold their credentials and are gitignored; `discovery.yaml` is now changed in their checkout,
so a later `git pull` may need `git stash` first.

## Appendix: day-to-day commands

From `<DECKARD_DIR>/docker-compose`:

| To | Run |
|---|---|
| See what Deckard found | open http://localhost:7493 |
| See status | `docker compose ps -a` |
| Read Deckard's log | `docker compose logs --tail 100 deckard` |
| Rescan this machine now | `./scan-local.sh && docker compose restart deckard` |
| Apply a changed `discovery.yaml` or `.env` | `docker compose up -d --wait --no-deps --force-recreate deckard` |
| Stop, keeping the data | `docker compose down` |
| Start again | `docker compose up -d --wait` |
| Delete everything, events too | `docker compose down -v` (ask first) |
