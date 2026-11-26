import { test } from "node:test";
import assert from "node:assert/strict";
import { config, es, EsError, mcpServersQuery, overview, sightingsQuery, shapeAgents, shapeMcpServers, shapeSources } from "../lib.mjs";
import { agentBuckets, fakeEs, mcpServerBuckets, NOW, sourceBuckets } from "./fixtures.mjs";

const cfg = config({ ES_URL: "http://es:9200/", ES_USERNAME: "u", ES_PASSWORD: "p" });

test("config reads the environment", () => {
  assert.equal(cfg.url, "http://es:9200");
  assert.equal(cfg.auth, `Basic ${Buffer.from("u:p").toString("base64")}`);
  assert.equal(cfg.index, "logs-arthur.discovery-*");
  assert.equal(config({ ES_API_KEY: "k", ES_USERNAME: "u" }).auth, "ApiKey k");
  assert.equal(config({}).auth, null);
});

test("an agent's status comes from its source's last successful scan", () => {
  const sources = shapeSources(sourceBuckets);
  const agents = Object.fromEntries(shapeAgents(agentBuckets, sources, NOW).map((a) => [a.name, a]));
  // The failed scan after it doesn't make it gone.
  assert.equal(agents["Claude Code"].status, "current");
  assert.equal(agents.Cursor.status, "gone");
  assert.equal(agents["support-bot"].status, "current");
  assert.equal(agents["x-caller"].status, "unknown");
});

test("new means first reported after its source's first scan, in the last 7 days", () => {
  const sources = shapeSources(sourceBuckets);
  const agents = Object.fromEntries(shapeAgents(agentBuckets, sources, NOW).map((a) => [a.name, a]));
  assert.equal(agents["support-bot"].is_new, true);
  assert.equal(agents["old-bot"].is_new, false, "found by the source's first scan");
  assert.equal(agents["Claude Code"].is_new, false, "first seen over 7 days ago");
  assert.equal(agents["x-caller"].is_new, false, "no scan outcomes to compare against");
});

test("sources carry what the page alerts on", () => {
  const [jamf, vertex] = shapeSources(sourceBuckets);
  assert.equal(jamf.name, "corp-macs");
  assert.equal(jamf.last_scan.succeeded, false);
  assert.equal(jamf.last_scan.error_code, "authentication_failed");
  assert.equal(jamf.last_scan.device_coverage.devices_unreadable, 1);
  assert.equal(jamf.last_success_at, "2026-11-13T10:00:00.000Z");
  assert.equal(jamf.failed_scans, 2);
  assert.equal(jamf.recent.length, 2);
  assert.deepEqual(vertex.last_scan.denied_scopes, [{ scope: "projects/acme-dev-456", reason: "permission_denied" }]);
});

test("overview follows composite pages and lists sources that sent no outcomes", async () => {
  const { call, calls } = fakeEs({ pageSize: 2 });
  const o = await overview(cfg, call);
  assert.equal(o.agents.length, agentBuckets.length);
  assert.equal(o.mcp_servers.length, mcpServerBuckets.length);
  assert.equal(o.sources.length, 4);
  const gateway = o.sources.find((s) => s.name === "llm-gateway");
  assert.equal(gateway.last_scan, null, "a source that sent only MCP servers is listed too");
  const siem = o.sources.find((s) => s.name === "siem");
  assert.equal(siem.scans, 0);
  assert.equal(siem.last_scan, null);
  assert.ok(calls.some((c) => c.body.aggs.c.composite.after), "asked for a second page");
  assert.ok(calls.every((c) => c.path === "/logs-arthur.discovery-*/_search"));
});

test("sightings asks for one agent from one source", () => {
  const q = sightingsQuery("src", "ext");
  assert.deepEqual(q.query.bool.filter.slice(1), [{ term: { "source.id": "src" } }, { term: { "agent.external_id": "ext" } }]);
});

test("sightings asks for an MCP server by its own event type and field", () => {
  const q = sightingsQuery("src", "ext", "mcp_server");
  assert.deepEqual(q.query.bool.filter, [
    { term: { event_type: "arthur.discovery.mcp_server" } },
    { term: { "source.id": "src" } },
    { term: { "mcp_server.external_id": "ext" } },
  ]);
});

test("MCP servers are read from their own events, never counted among agents", () => {
  const q = mcpServersQuery();
  assert.deepEqual(q.query.bool.filter, [{ term: { event_type: "arthur.discovery.mcp_server" } }]);
  assert.deepEqual(q.aggs.c.composite.sources[1], { external_id: { terms: { field: "mcp_server.external_id" } } });
  assert.deepEqual(q.aggs.c.aggs.latest.top_hits._source.includes, ["mcp_server", "source", "@timestamp"]);
});

test("an MCP server has an agent's status and newness, and carries what the source said", () => {
  const sources = shapeSources(sourceBuckets);
  const servers = Object.fromEntries(shapeMcpServers(mcpServerBuckets, sources, NOW).map((m) => [m.name, m]));
  assert.equal(servers.bigquery.status, "current");
  assert.equal(servers.bigquery.is_new, true);
  assert.equal(servers.maps.status, "gone");
  assert.equal(servers.github.status, "unknown", "its source sends no scan outcomes");
  assert.equal(servers.github.mcp_server.detection, "called");
  assert.deepEqual(servers.github.mcp_server.used_by, ["litellm:gw:virtual_key:9f3b"]);
  assert.equal(servers.bigquery.mcp_server.used_by, undefined, "left out, not empty: the source can't tell");
  assert.equal(servers.github.agent, undefined);
});

test("a scan's outcome says how many MCP servers it sent, when the release reports them", () => {
  const [jamf, vertex] = shapeSources(sourceBuckets);
  assert.equal(jamf.last_scan.mcp_servers_published, null);
  assert.equal(vertex.last_scan.mcp_servers_published, 2);
  assert.equal(vertex.recent[0].mcp_servers_published, 2);
});

test("es() says what went wrong", async () => {
  const answer = (status, body) => async () => new Response(JSON.stringify(body), { status });
  await assert.rejects(es(cfg, "/x", {}, answer(401, { error: { reason: "bad password" } })), (e) => e instanceof EsError && /credentials: bad password/.test(e.message));
  await assert.rejects(es(cfg, "/x", {}, answer(403, { error: { reason: "no" } })), /may not read logs-arthur\.discovery-\*/);
  await assert.rejects(es(cfg, "/x", {}, async () => { throw new TypeError("fetch failed", { cause: { code: "ECONNREFUSED" } }); }), /can't be reached \(ECONNREFUSED\)/);
  await assert.rejects(es(cfg, "/x", {}, async () => new Response("<html>", { status: 200 })), /isn't JSON/);
  assert.deepEqual(await es(cfg, "/x", {}, answer(200, { ok: 1 })), { ok: 1 });
});
