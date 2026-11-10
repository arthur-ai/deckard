<p align="center">
  <img src="docs/assets/deckard-hero.png" alt="Deckard by Arthur banner" width="100%">
</p>

# Arthur Deckard

[![CI](https://github.com/arthur-ai/deckard/actions/workflows/ci.yaml/badge.svg)](https://github.com/arthur-ai/deckard/actions/workflows/ci.yaml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

**Scan your endpoints, cloud, and network for shadow Agents and track them in your SIEM.**

Deckard scans your systems (cloud AI platforms, endpoints, network logs and
your SIEM) for AI agents, and sends every one it finds to Elasticsearch, Splunk, your SIEM or any
webhook. It's headless, read-only, and runs entirely in your environment.

## Quickstart

Find the AI agents on your own machine in a couple of minutes, with no accounts or
credentials. You need Docker with Compose 2.24 or later, and
[osquery](https://osquery.io/downloads) (`brew install --cask osquery` on a Mac).

### Set up with a coding agent

Paste this into Claude Code, Cursor, Codex or any coding agent on your machine:

```text
Download https://raw.githubusercontent.com/arthur-ai/deckard/main/docs/agent-setup/prompt.md with curl, read all of it, and follow its instructions to set up Arthur Deckard on this machine.
```

It checks your machine first and, if something needs installing or your password, stops and
tells you the command to run yourself. Then it runs the steps below, shows you the agents it
found, and can walk you through adding a cloud, MDM or SIEM source and your own destination.
The [prompt](docs/agent-setup/prompt.md) never has it run `sudo`, and is plain Markdown to
read first.

### Or by hand

```bash
git clone https://github.com/arthur-ai/deckard.git
cd deckard && ./start.sh
```

`start.sh` checks your machine, scans it, starts Deckard with an Elasticsearch and Kibana
beside it, waits for the scan to arrive, and prints the agents it found. It installs nothing
and never runs `sudo`: if something is missing, it stops and prints the command to run
yourself. The scan lists what's installed on this machine using the osquery queries from
[ai-detection-spec](https://github.com/arthur-ai/ai-detection-spec), our open format and
catalog for finding AI agents on a machine. It changes nothing and doesn't need root.

```text
==> Found 3 AI agent(s) on this machine
   agent.name   |  source.name
----------------+---------------
Claude Code     |this-machine
Claude Desktop  |this-machine
Cursor          |this-machine
```

Open [Deckard findings](http://localhost:5601/app/discover#/view/deckard-findings) in Kibana,
log in as `elastic` with password `changeme`, and it lists every event Deckard sent: one per
agent found and one per scan, over the last 30 days. Expand a row to see the whole event.
Run `./start.sh` again to rescan.

Next, add your cloud, MDM or SIEM sources to
[`docker-compose/discovery.yaml`](docker-compose/discovery.yaml) (it has commented
examples), and point its `destination` at your own Elasticsearch, Splunk or webhook. Deckard
reads the file only when its container starts, so apply each change with
`docker compose up -d --force-recreate deckard`. See
[`docker-compose/`](docker-compose/README.md) for more.

## Deploy on Kubernetes

```bash
kubectl create namespace deckard
kubectl -n deckard create secret generic deckard-credentials \
  --from-literal=SPLUNK_HEC_TOKEN="$SPLUNK_HEC_TOKEN"

helm install deckard oci://ghcr.io/arthur-ai/charts/deckard -n deckard --set-file config=discovery.yaml
```

The config references each key in the Secret as `${NAME}`. See the
[chart's README](charts/deckard/README.md) for the details and cloud workload identity.

Each [release](https://github.com/arthur-ai/deckard/releases) publishes the image
`arthurplatform/deckard` and this chart at the same version; add `--version` to pin one.

## Integrations

| Class | Sources |
|---|---|
| Cloud AI platforms and workloads | Vertex AI Agent Engine, AWS Bedrock and AgentCore, Cloud Run and GKE, ECS and EKS, Vercel |
| Endpoints and servers | Jamf Pro, Google Compute Engine, AWS EC2, this machine (`scan-local.sh`) |
| Network and gateway logs | AWS CloudWatch Logs, Google Cloud Logging |
| Security telemetry | Splunk Enterprise, Elastic Security |

**Destinations:** Elasticsearch and Elastic Security, Splunk HTTP Event Collector, or any
HTTPS webhook.

Missing one you use? [Open an issue](https://github.com/arthur-ai/deckard/issues).

## Documentation

- [How Deckard works](docs/how-it-works.md): discovery classes, sources and scans
- [Events and alerting](docs/events.md): what your SIEM receives and what to alert on
- [Configuration reference](https://github.com/arthur-ai/arthur-engine/blob/main/ml-engine/docs/standalone-discovery.md):
  every source's fields and permissions, destination options, scheduling

## Contributing

Deckard is the standalone discovery mode of the
[Arthur Engine](https://github.com/arthur-ai/arthur-engine), where its code lives. This
repository holds its deployment and docs. Bug reports and integration requests are welcome
in [issues](https://github.com/arthur-ai/deckard/issues); report security issues
privately, as described in [SECURITY.md](SECURITY.md). How releases are made:
[RELEASING.md](RELEASING.md).

## License

[MIT](LICENSE)
