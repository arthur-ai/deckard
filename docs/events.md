# Events and alerting

Deckard sends three kinds of event to its destination: one per agent found, one per MCP
server found, and one per scan.

## Discovered agents

One event per agent per scan:

```json
{
  "event_type": "arthur.discovery.agent",
  "schema_version": 1,
  "observed_at": "2026-10-07T18:00:00.123456+00:00",
  "source": {"id": "6b0f…", "name": "vertex-prod", "vendor": "gcp_vertex", "config_name": "agent-engines"},
  "agent": {
    "external_id": "projects/123456789012/locations/us-central1/reasoningEngines/111…",
    "name": "personal-assistant",
    "last_seen": "2026-10-07T17:58:12+00:00"
  }
}
```

Each agent records which source found it, where it runs, and when it was last seen, so you
can follow up with the team that owns it. `agent` also carries whatever else the source
reported, such as the models it calls and the tools it uses.

Every scan sends what the source reports now, so the same agents arrive each time. Dedupe on
`agent.external_id` and `source.id`.

## Discovered MCP servers

One event per MCP server per scan, from a source that can see them:

```json
{
  "event_type": "arthur.discovery.mcp_server",
  "schema_version": 1,
  "observed_at": "2026-10-07T18:00:00.123456+00:00",
  "source": {"id": "6b0f…", "name": "llm-gateway", "vendor": "litellm", "config_name": "requests"},
  "mcp_server": {
    "external_id": "litellm:litellm.example.com:4000:mcp_server:github",
    "name": "github",
    "last_seen": "2026-10-07T17:58:12+00:00",
    "detection": "called",
    "tools": [{"name": "github-get_issue", "arguments": []}],
    "used_by": ["litellm:litellm.example.com:4000:virtual_key:9f3b…"]
  }
}
```

An MCP server is never sent as an agent, so a search or an alert on
`arthur.discovery.agent` does not count servers.

- `detection` says how the source knows the server is there. `called` means tool calls to
  it passed through a gateway the source reads.
- `tools` lists the tools the source saw on it. It is left out when the source saw none.
- `used_by` lists the `agent.external_id` of each agent from the same source seen using the
  server. It is left out when the source cannot tell, which is not the same as no agent
  using it.

Dedupe on `mcp_server.external_id` and `source.id`. The same server seen through two
gateways is two events.

## Scan outcomes

With `emit_scan_outcomes: true`, each scan also sends one `arthur.discovery.scan_outcome`
event saying whether it succeeded, how many agents and MCP servers it sent
(`records_published` and `mcp_servers_published`), and why it failed if it did.

## What to alert on

- **A new `agent.external_id`**: an agent nobody has seen before.
- **A new `mcp_server.external_id`**: an MCP server nobody has seen before, and in
  `used_by`, the agents already using it.
- **`outcome.succeeded: false`**: a source Deckard can no longer read. `error_code` says why
  (`authentication_failed`, `permission_denied`, …).
- **A non-empty `outcome.denied_scopes`**: a cloud project or account inside the scope that
  the scan was refused, so its agents are invisible.
- **`outcome.device_coverage.unreadable_devices`**: machines the scan could not read, such as
  ones the endpoint collector has never reported from. A machine Deckard cannot see is where
  unmanaged AI sits.

The [configuration reference](https://github.com/arthur-ai/arthur-engine/blob/main/ml-engine/docs/standalone-discovery.md#what-the-destination-receives)
documents every field.
