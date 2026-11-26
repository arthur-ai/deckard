// What the viewer asks Elasticsearch, and how it shapes the answers for the page.
//
// It reads Deckard's events the way Kibana did: over Elasticsearch's REST API, server side,
// as a user that can only read logs-arthur.discovery-*. The browser never talks to
// Elasticsearch, and can ask only the questions below.
//
// It also asks Deckard itself, over Deckard's control API, where each scan stands and to
// scan a source now. That API takes nothing else.

import { readFileSync } from "node:fs";

const AGENT = "arthur.discovery.agent";
const MCP_SERVER = "arthur.discovery.mcp_server";
const OUTCOME = "arthur.discovery.scan_outcome";
// Composite aggregations are paged; this many pages of PAGE buckets is the most it reads.
const PAGE = 500;
const MAX_PAGES = 40;
// Scans per source shown as its recent history.
const RECENT_SCANS = 30;

export function config(env = process.env) {
  const url = (env.ES_URL || "http://elasticsearch:9200").replace(/\/+$/, "");
  let auth = null;
  if (env.ES_API_KEY) auth = `ApiKey ${env.ES_API_KEY}`;
  else if (env.ES_USERNAME) {
    auth = `Basic ${Buffer.from(`${env.ES_USERNAME}:${env.ES_PASSWORD || ""}`).toString("base64")}`;
  }
  return {
    url,
    auth,
    index: env.ES_INDEX || "logs-arthur.discovery-*",
    port: Number(env.PORT || 7493),
    host: env.HOST || "0.0.0.0",
    // Deckard's control API, which takes "scan this source now". Off without both.
    deckardUrl: (env.DECKARD_URL || "").replace(/\/+$/, "") || null,
    deckardToken: env.DECKARD_CONTROL_TOKEN || null,
    deckardTokenFile: env.DECKARD_CONTROL_TOKEN_FILE || null,
    // Host names the page may be loaded as, beyond this machine's own. A request naming
    // any other is refused, so a site that points its name at 127.0.0.1 can't read it.
    // Deckard's discovery.yaml and secrets/ folder, mounted writable, for adding and
    // editing sources. Off without the config file.
    sourcesConfig: env.SOURCES_CONFIG || null,
    sourcesSecrets: env.SOURCES_SECRETS || null,
    allowedHosts: (env.ALLOWED_HOSTS || "").split(",").map((x) => x.trim().toLowerCase()).filter(Boolean),
  };
}

export class EsError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// POSTs body to path on Elasticsearch and returns the parsed answer, or throws an EsError
// that says what went wrong in words a person can act on.
export async function es(cfg, path, body, fetchImpl = fetch) {
  let res;
  try {
    res = await fetchImpl(`${cfg.url}${path}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(cfg.auth ? { Authorization: cfg.auth } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    throw new EsError(`Elasticsearch at ${cfg.url} can't be reached (${err.cause?.code || err.message})`, 502);
  }
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // Not JSON: a proxy, or not Elasticsearch at all.
  }
  if (!res.ok) {
    const reason = json?.error?.reason || json?.error?.type || text.slice(0, 200) || res.statusText;
    if (res.status === 401) throw new EsError(`Elasticsearch refused the viewer's credentials: ${reason}`, 502);
    if (res.status === 403) throw new EsError(`The viewer's user may not read ${cfg.index}: ${reason}`, 502);
    throw new EsError(`Elasticsearch answered ${res.status}: ${reason}`, 502);
  }
  if (!json) throw new EsError("Elasticsearch answered with something that isn't JSON", 502);
  return json;
}

// Every bucket of a composite aggregation named "c" in body, following its pages until one
// comes back empty, as Elasticsearch documents.
async function compositeBuckets(cfg, body, call) {
  const out = [];
  let after;
  for (let page = 0; page < MAX_PAGES; page++) {
    const req = structuredClone(body);
    if (after) req.aggs.c.composite.after = after;
    const res = await call(cfg, `/${encodeURIComponent(cfg.index)}/_search`, req);
    const agg = res.aggregations?.c;
    if (!agg?.buckets.length || !agg.after_key) return { buckets: out, truncated: false };
    out.push(...agg.buckets);
    after = agg.after_key;
  }
  return { buckets: out, truncated: true };
}

// One bucket per thing found: the same external_id from the same source.id, with when it
// was first and last reported and the latest event. field is where the event holds it.
function foundQuery(eventType, field) {
  return {
    size: 0,
    track_total_hits: false,
    query: { bool: { filter: [{ term: { event_type: eventType } }] } },
    aggs: {
      c: {
        composite: {
          size: PAGE,
          sources: [
            { source_id: { terms: { field: "source.id" } } },
            { external_id: { terms: { field: `${field}.external_id` } } },
          ],
        },
        aggs: {
          first: { min: { field: "@timestamp" } },
          last: { max: { field: "@timestamp" } },
          latest: {
            top_hits: { size: 1, sort: [{ "@timestamp": "desc" }], _source: { includes: [field, "source", "@timestamp"] } },
          },
        },
      },
    },
  };
}

export const agentsQuery = () => foundQuery(AGENT, "agent");
// MCP servers are events of their own type, from a Deckard release that reports them.
export const mcpServersQuery = () => foundQuery(MCP_SERVER, "mcp_server");

export function sourcesQuery() {
  return {
    size: 0,
    track_total_hits: false,
    query: { bool: { filter: [{ term: { event_type: OUTCOME } }] } },
    aggs: {
      c: {
        composite: {
          size: PAGE,
          sources: [
            { source_id: { terms: { field: "source.id" } } },
            { config_name: { terms: { field: "source.config_name" } } },
          ],
        },
        aggs: {
          first: { min: { field: "@timestamp" } },
          latest: { top_hits: { size: 1, sort: [{ "@timestamp": "desc" }], _source: { includes: ["source", "outcome", "@timestamp"] } } },
          last_ok: {
            filter: { term: { "outcome.succeeded": true } },
            aggs: {
              hit: {
                top_hits: {
                  size: 1,
                  sort: [{ "@timestamp": "desc" }],
                  _source: { includes: ["outcome.started_at", "outcome.finished_at", "@timestamp"] },
                },
              },
            },
          },
          failed: { filter: { term: { "outcome.succeeded": false } } },
          recent: {
            top_hits: {
              size: RECENT_SCANS,
              sort: [{ "@timestamp": "desc" }],
              _source: {
                includes: [
                  "@timestamp",
                  "outcome.succeeded",
                  "outcome.records_published",
                  "outcome.mcp_servers_published",
                  "outcome.error_code",
                  "outcome.started_at",
                  "outcome.finished_at",
                ],
              },
            },
          },
        },
      },
    },
  };
}

// kind is "agent" or "mcp_server": which of the two the external ID names.
export function sightingsQuery(sourceId, externalId, kind = "agent") {
  const server = kind === "mcp_server";
  return {
    size: 100,
    track_total_hits: true,
    sort: [{ "@timestamp": "desc" }],
    _source: false,
    fields: ["@timestamp"],
    query: {
      bool: {
        filter: [
          { term: { event_type: server ? MCP_SERVER : AGENT } },
          { term: { "source.id": sourceId } },
          { term: { [server ? "mcp_server.external_id" : "agent.external_id"]: externalId } },
        ],
      },
    },
  };
}

const sourceKey = (id, config) => `${id}\u0000${config ?? ""}`;
const time = (s) => {
  const t = Date.parse(s);
  return Number.isNaN(t) ? null : t;
};

// One entry per source and config Deckard reported a scan for, newest scan first.
export function shapeSources(buckets) {
  return buckets.map((b) => {
    const latest = b.latest.hits.hits[0]?._source ?? {};
    const ok = b.last_ok.hit.hits.hits[0]?._source;
    const outcome = latest.outcome ?? {};
    const coverage = outcome.device_coverage ?? null;
    return {
      key: sourceKey(b.key.source_id, b.key.config_name),
      id: b.key.source_id,
      name: latest.source?.name ?? b.key.source_id,
      vendor: latest.source?.vendor ?? outcome.vendor ?? null,
      config_name: b.key.config_name,
      scans: b.doc_count,
      failed_scans: b.failed.doc_count,
      first_scan_at: b.first.value_as_string ?? null,
      last_scan: {
        at: latest["@timestamp"] ?? null,
        succeeded: outcome.succeeded ?? null,
        started_at: outcome.started_at ?? null,
        finished_at: outcome.finished_at ?? null,
        records_published: outcome.records_published ?? null,
        mcp_servers_published: outcome.mcp_servers_published ?? null,
        records_failed: outcome.records_failed ?? 0,
        failed_records: outcome.failed_records ?? [],
        error: outcome.error ?? null,
        error_code: outcome.error_code ?? null,
        denied_scopes: outcome.denied_scopes ?? [],
        lookback_hours: outcome.lookback_hours ?? null,
        device_coverage: coverage,
      },
      last_success_at: ok ? (ok.outcome?.started_at ?? ok["@timestamp"]) : null,
      recent: b.recent.hits.hits.map((h) => ({
        at: h._source["@timestamp"],
        succeeded: h._source.outcome?.succeeded ?? null,
        records_published: h._source.outcome?.records_published ?? null,
        mcp_servers_published: h._source.outcome?.mcp_servers_published ?? null,
        error_code: h._source.outcome?.error_code ?? null,
        started_at: h._source.outcome?.started_at ?? null,
        finished_at: h._source.outcome?.finished_at ?? null,
      })),
    };
  });
}

// One entry per agent: the same agent.external_id from the same source.id, however many
// scans reported it. status says whether its source's latest successful scan still did:
//   current  it did
//   gone     the source scanned successfully since, and it wasn't there
//   unknown  no successful scan outcome to compare against (emit_scan_outcomes off, or
//            every scan failed)
// is_new: first reported in the last NEW_DAYS by a source that had already scanned before,
// so a source's first scan doesn't call everything it finds new.
const NEW_DAYS = 7;

export const shapeAgents = (buckets, sources, now = Date.now()) => shapeFound(buckets, sources, now, "agent");

// One entry per MCP server, with the same status and is_new an agent has. Its record is
// under mcp_server: how the source knows it is there (detection), the tools seen on it,
// and used_by, the external_id of each agent of the same source seen using it.
export const shapeMcpServers = (buckets, sources, now = Date.now()) => shapeFound(buckets, sources, now, "mcp_server");

function shapeFound(buckets, sources, now, field) {
  const lastOk = new Map(sources.map((s) => [s.key, time(s.last_success_at)]));
  const firstScan = new Map(sources.map((s) => [s.key, time(s.first_scan_at)]));
  return buckets.map((b) => {
    const hit = b.latest.hits.hits[0]?._source ?? {};
    const record = hit[field] ?? {};
    const src = hit.source ?? {};
    const last = b.last.value;
    const key = sourceKey(b.key.source_id, src.config_name);
    const okAt = lastOk.get(key);
    let status = "unknown";
    if (okAt != null && last != null) status = last >= okAt ? "current" : "gone";
    const first = b.first.value;
    const scannedBefore = firstScan.get(key);
    // A minute's grace: a scan's agents are written just after its outcome's timestamp.
    const isNew =
      first != null && scannedBefore != null && first > scannedBefore + 60000 && now - first < NEW_DAYS * 86400000;
    return {
      key: `${b.key.source_id}\u0000${b.key.external_id}`,
      external_id: b.key.external_id,
      name: record.name ?? b.key.external_id,
      source: { id: b.key.source_id, name: src.name ?? null, vendor: src.vendor ?? null, config_name: src.config_name ?? null },
      first_seen: b.first.value_as_string ?? null,
      last_seen: b.last.value_as_string ?? null,
      sightings: b.doc_count,
      status,
      is_new: isNew,
      [field]: record,
    };
  });
}

// Everything the page shows, in one answer.
export async function overview(cfg, call = es) {
  const [s, a, m] = await Promise.all([
    compositeBuckets(cfg, sourcesQuery(), call),
    compositeBuckets(cfg, agentsQuery(), call),
    compositeBuckets(cfg, mcpServersQuery(), call),
  ]);
  const sources = shapeSources(s.buckets);
  const agents = shapeAgents(a.buckets, sources);
  const mcpServers = shapeMcpServers(m.buckets, sources);
  // Sources that sent agents or MCP servers but never a scan outcome still belong in the
  // list.
  const known = new Set(sources.map((x) => x.key));
  for (const ag of [...agents, ...mcpServers]) {
    const key = sourceKey(ag.source.id, ag.source.config_name);
    if (known.has(key)) continue;
    known.add(key);
    sources.push({
      key,
      id: ag.source.id,
      name: ag.source.name ?? ag.source.id,
      vendor: ag.source.vendor,
      config_name: ag.source.config_name,
      scans: 0,
      failed_scans: 0,
      first_scan_at: null,
      last_scan: null,
      last_success_at: null,
      recent: [],
    });
  }
  return {
    generated_at: new Date().toISOString(),
    index: cfg.index,
    truncated: s.truncated || a.truncated || m.truncated,
    sources,
    agents,
    mcp_servers: mcpServers,
  };
}

export async function sightings(cfg, sourceId, externalId, kind = "agent", call = es) {
  const res = await call(cfg, `/${encodeURIComponent(cfg.index)}/_search`, sightingsQuery(sourceId, externalId, kind));
  return {
    total: res.hits?.total?.value ?? 0,
    times: (res.hits?.hits ?? []).map((h) => h.fields?.["@timestamp"]?.[0]).filter(Boolean),
  };
}

/* Deckard's control API */

export class DeckardError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

// The token, read from its file on every call: the file is written by a one-shot service
// that may finish after the viewer starts, and may be replaced by a later one.
function deckardToken(cfg) {
  if (cfg.deckardToken) return cfg.deckardToken;
  if (!cfg.deckardTokenFile) return null;
  try {
    return readFileSync(cfg.deckardTokenFile, "utf8").trim() || null;
  } catch {
    return null;
  }
}

// Calls Deckard's control API and returns its parsed answer, or throws a DeckardError that
// says what went wrong.
export async function deckard(cfg, method, path, body, fetchImpl = fetch, timeoutMs = 10000) {
  const token = deckardToken(cfg);
  if (!cfg.deckardUrl || !token) {
    throw new DeckardError("The viewer isn't set up to ask Deckard for scans: it needs DECKARD_URL and a control token", 503);
  }
  let res;
  try {
    res = await fetchImpl(`${cfg.deckardUrl}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { "Content-Type": "application/json" } : {}) },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err.name === "TimeoutError") throw new DeckardError(`Deckard didn't answer within ${timeoutMs / 1000} s`, 504);
    throw new DeckardError(
      `Deckard at ${cfg.deckardUrl} can't be reached (${err.cause?.code || err.message}). It may be restarting, or a Deckard release that takes no scan requests yet`,
      502,
    );
  }
  let json = null;
  try {
    json = JSON.parse(await res.text());
  } catch {
    // Not JSON: not Deckard's control API.
  }
  if (res.status === 401) throw new DeckardError("Deckard refused the viewer's control token; the two were given different tokens", 502);
  if (res.status === 404 && path === "/scans/run") {
    throw new DeckardError("Deckard has no scan configured for that source any more; refresh the page", 404);
  }
  if (res.status === 400 && json?.error) throw new DeckardError(json.error, 400);
  // Flask's own 404, for a route this Deckard's control API doesn't have.
  if (res.status === 404 && !json) {
    throw new DeckardError("This Deckard release can't add sources yet: its control API has no source routes", 501);
  }
  if (!res.ok || !json) throw new DeckardError(`Deckard answered ${res.status}${json?.error ? `: ${json.error}` : ""}`, 502);
  return json;
}

// Where each of Deckard's configured scans stands. Never throws: a Deckard that can't be
// asked is a page without scan buttons, not a broken page.
export async function scans(cfg, call = deckard) {
  try {
    const res = await call(cfg, "GET", "/scans");
    return { available: true, scans: Array.isArray(res.scans) ? res.scans : [] };
  } catch (err) {
    if (!(err instanceof DeckardError)) throw err;
    return { available: false, reason: err.message, scans: [] };
  }
}

const ID_MAX = 200;

// Asks Deckard to scan one source's config now.
export async function requestScan(cfg, body, call = deckard) {
  const sourceId = body?.source_id;
  const configName = body?.config_name;
  const ok = (v) => typeof v === "string" && v.length > 0 && v.length <= ID_MAX;
  if (!ok(sourceId) || (configName != null && !ok(configName))) {
    throw new DeckardError("source_id is required, and config_name if given must be a short string", 400);
  }
  const res = await call(cfg, "POST", "/scans/run", { source_id: sourceId, ...(configName != null ? { config_name: configName } : {}) });
  return { scans: Array.isArray(res.scans) ? res.scans : [] };
}

/* Sources */

// Each vendor's form, from Deckard; and per vendor, the names of its secret fields.
export async function sourceTypes(cfg, call = deckard) {
  const res = await call(cfg, "GET", "/source-types");
  const types = Array.isArray(res.source_types) ? res.source_types : [];
  const secret = new Map(types.map((t) => [t.vendor, new Set((t.fields ?? []).filter((f) => f.is_sensitive).map((f) => f.name))]));
  return { types, secretKeys: (vendor) => secret.get(vendor) ?? null };
}

// How Deckard's config file stands: when it was loaded, and why a later change wasn't.
export async function engineConfig(cfg, call = deckard) {
  try {
    return await call(cfg, "GET", "/config");
  } catch (err) {
    if (err instanceof DeckardError) return null;
    throw err;
  }
}

// Asks Deckard to apply discovery.yaml now, rather than at its next check (every 5 s), and
// to start what that made due: {config, scans}. Never throws: a Deckard without the route,
// or one that can't be asked, answers null, and still applies the file at its next check.
export async function applyConfig(cfg, call = deckard) {
  try {
    const res = await call(cfg, "POST", "/config/reload");
    return { config: res.config ?? null, scans: Array.isArray(res.scans) ? res.scans : [] };
  } catch (err) {
    if (err instanceof DeckardError) return null;
    throw err;
  }
}

// Test Connection, or with validateOnly just the checks Deckard's config loader makes.
// keepSecretsFrom names the configured source whose secrets fill the ones left blank.
export async function testSource(cfg, source, { configName, keepSecretsFrom, validateOnly = false } = {}, call = deckard) {
  const body = { source, validate_only: validateOnly };
  if (configName) body.config_name = configName;
  if (keepSecretsFrom) body.keep_secrets_from = keepSecretsFrom;
  // A test reads for up to 120 s before Deckard gives up on it.
  return call(cfg, "POST", "/sources/test", body, undefined, validateOnly ? 10000 : 135000);
}
