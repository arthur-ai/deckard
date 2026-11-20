// What the viewer asks Elasticsearch, and how it shapes the answers for the page.
//
// It reads Deckard's events the way Kibana did: over Elasticsearch's REST API, server side,
// as a user that can only read logs-arthur.discovery-*. The browser never talks to
// Elasticsearch, and can ask only the questions below.

const AGENT = "arthur.discovery.agent";
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

export function agentsQuery() {
  return {
    size: 0,
    track_total_hits: false,
    query: { bool: { filter: [{ term: { event_type: AGENT } }] } },
    aggs: {
      c: {
        composite: {
          size: PAGE,
          sources: [
            { source_id: { terms: { field: "source.id" } } },
            { external_id: { terms: { field: "agent.external_id" } } },
          ],
        },
        aggs: {
          first: { min: { field: "@timestamp" } },
          last: { max: { field: "@timestamp" } },
          latest: {
            top_hits: { size: 1, sort: [{ "@timestamp": "desc" }], _source: { includes: ["agent", "source", "@timestamp"] } },
          },
        },
      },
    },
  };
}

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

export function sightingsQuery(sourceId, externalId) {
  return {
    size: 100,
    track_total_hits: true,
    sort: [{ "@timestamp": "desc" }],
    _source: false,
    fields: ["@timestamp"],
    query: {
      bool: {
        filter: [
          { term: { event_type: AGENT } },
          { term: { "source.id": sourceId } },
          { term: { "agent.external_id": externalId } },
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

export function shapeAgents(buckets, sources, now = Date.now()) {
  const lastOk = new Map(sources.map((s) => [s.key, time(s.last_success_at)]));
  const firstScan = new Map(sources.map((s) => [s.key, time(s.first_scan_at)]));
  return buckets.map((b) => {
    const hit = b.latest.hits.hits[0]?._source ?? {};
    const agent = hit.agent ?? {};
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
      name: agent.name ?? b.key.external_id,
      source: { id: b.key.source_id, name: src.name ?? null, vendor: src.vendor ?? null, config_name: src.config_name ?? null },
      first_seen: b.first.value_as_string ?? null,
      last_seen: b.last.value_as_string ?? null,
      sightings: b.doc_count,
      status,
      is_new: isNew,
      agent,
    };
  });
}

// Everything the page shows, in one answer.
export async function overview(cfg, call = es) {
  const [s, a] = await Promise.all([
    compositeBuckets(cfg, sourcesQuery(), call),
    compositeBuckets(cfg, agentsQuery(), call),
  ]);
  const sources = shapeSources(s.buckets);
  const agents = shapeAgents(a.buckets, sources);
  // Sources that sent agents but never a scan outcome still belong in the list.
  const known = new Set(sources.map((x) => x.key));
  for (const ag of agents) {
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
    truncated: s.truncated || a.truncated,
    sources,
    agents,
  };
}

export async function sightings(cfg, sourceId, externalId, call = es) {
  const res = await call(cfg, `/${encodeURIComponent(cfg.index)}/_search`, sightingsQuery(sourceId, externalId));
  return {
    total: res.hits?.total?.value ?? 0,
    times: (res.hits?.hits ?? []).map((h) => h.fields?.["@timestamp"]?.[0]).filter(Boolean),
  };
}
