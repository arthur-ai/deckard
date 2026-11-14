// Elasticsearch's answers to the viewer's two overview queries, for a cluster holding:
//   corp-macs / all-macs   a Jamf source whose last scan failed, with one unreadable Mac
//   vertex-prod / engines  a Vertex source scanning fine, with a denied project
// and agents that are current, gone, new, and from a source with no scan outcomes.

export const NOW = Date.parse("2026-11-13T12:00:00Z");
const t = (iso) => ({ value: Date.parse(iso), value_as_string: iso });

const scan = (at, succeeded, extra = {}) => ({
  _source: {
    "@timestamp": at,
    outcome: { succeeded, records_published: succeeded ? 3 : 0, error_code: succeeded ? null : "authentication_failed", started_at: at, finished_at: at, ...extra },
  },
});

export const sourceBuckets = [
  {
    key: { source_id: "jamf-1", config_name: "all-macs" },
    doc_count: 40,
    first: t("2026-10-01T00:00:00.000Z"),
    failed: { doc_count: 2 },
    latest: {
      hits: {
        hits: [{
          _source: {
            "@timestamp": "2026-11-13T11:00:00.000Z",
            source: { id: "jamf-1", name: "corp-macs", vendor: "jamf_pro", config_name: "all-macs" },
            outcome: {
              succeeded: false,
              error_code: "authentication_failed",
              error: "Jamf refused the client credentials",
              started_at: "2026-11-13T11:00:00.000Z",
              finished_at: "2026-11-13T11:00:02.000Z",
              records_published: 0,
              denied_scopes: [],
              failed_records: [],
              device_coverage: {
                devices_read: 9,
                devices_in_scope: 10,
                devices_unreadable: 1,
                unreadable_devices: [{ device_key: "42", name: "Ana's MacBook", reason: "never-reported", last_reported: null }],
                unreadable_devices_truncated: 0,
              },
            },
          },
        }],
      },
    },
    last_ok: { hit: { hits: { hits: [{ _source: { "@timestamp": "2026-11-13T10:00:00.000Z", outcome: { started_at: "2026-11-13T10:00:00.000Z" } } }] } } },
    recent: { hits: { hits: [scan("2026-11-13T11:00:00.000Z", false), scan("2026-11-13T10:00:00.000Z", true)] } },
  },
  {
    key: { source_id: "vertex-1", config_name: "engines" },
    doc_count: 10,
    first: t("2026-11-01T00:00:00.000Z"),
    failed: { doc_count: 0 },
    latest: {
      hits: {
        hits: [{
          _source: {
            "@timestamp": "2026-11-13T11:30:00.000Z",
            source: { id: "vertex-1", name: "vertex-prod", vendor: "gcp_vertex", config_name: "engines" },
            outcome: {
              succeeded: true,
              started_at: "2026-11-13T11:30:00.000Z",
              finished_at: "2026-11-13T11:30:04.000Z",
              records_published: 2,
              denied_scopes: [{ scope: "projects/acme-dev-456", reason: "permission_denied" }],
              failed_records: [],
            },
          },
        }],
      },
    },
    last_ok: { hit: { hits: { hits: [{ _source: { "@timestamp": "2026-11-13T11:30:00.000Z", outcome: { started_at: "2026-11-13T11:30:00.000Z" } } }] } } },
    recent: { hits: { hits: [scan("2026-11-13T11:30:00.000Z", true)] } },
  },
];

const agent = (sourceId, sourceName, vendor, config, id, name, first, last, extra = {}) => ({
  key: { source_id: sourceId, external_id: id },
  doc_count: 5,
  first: t(first),
  last: t(last),
  latest: {
    hits: {
      hits: [{
        _source: {
          "@timestamp": last,
          source: { id: sourceId, name: sourceName, vendor, config_name: config },
          agent: { external_id: id, name, last_seen: last, ...extra },
        },
      }],
    },
  },
});

export const agentBuckets = [
  // Reported by the last successful Jamf scan (10:00); the failed 11:00 one doesn't count.
  agent("jamf-1", "corp-macs", "jamf_pro", "all-macs", "mac-1:claude-code", "Claude Code", "2026-10-01T00:00:00.500Z", "2026-11-13T10:00:00.500Z", {
    runs_on: "endpoint",
    creation_source: { type: "ENDPOINT", observations: { classification: "Coding agent", install_path: "/Users/ana/.claude/", host_name: "anas-mac" } },
  }),
  // Last reported before Jamf's last successful scan: gone.
  agent("jamf-1", "corp-macs", "jamf_pro", "all-macs", "mac-1:cursor", "Cursor", "2026-10-01T00:00:00.500Z", "2026-11-12T10:00:00.500Z"),
  // First reported well after Vertex's first scan, two days ago: new.
  agent("vertex-1", "vertex-prod", "gcp_vertex", "engines", "projects/1/reasoningEngines/9", "support-bot", "2026-11-11T09:00:00.000Z", "2026-11-13T11:30:00.300Z", {
    runs_on: "gcp",
    creation_source: { type: "CLOUD", address: { instance: "acme-prod", scope: "us-central1", resource_id: "9" } },
  }),
  // Reported in Vertex's first scan: not new.
  agent("vertex-1", "vertex-prod", "gcp_vertex", "engines", "projects/1/reasoningEngines/1", "old-bot", "2026-11-01T00:00:00.200Z", "2026-11-13T11:30:00.300Z"),
  // A source that never sent a scan outcome.
  agent("hook-1", "siem", "splunk_enterprise", "callers", "role/x", "x-caller", "2026-11-10T00:00:00.000Z", "2026-11-13T09:00:00.000Z"),
];

// A stand-in for es(): answers the agents query or the sources query by what it filters on,
// one page at a time, so paging is exercised too.
export function fakeEs({ pageSize } = {}) {
  const calls = [];
  const call = async (_cfg, path, body) => {
    calls.push({ path, body });
    const type = body.query.bool.filter[0].term.event_type;
    const all = type === "arthur.discovery.agent" ? agentBuckets : sourceBuckets;
    const size = pageSize ?? body.aggs.c.composite.size;
    const after = body.aggs.c.composite.after;
    const start = after ? all.findIndex((b) => JSON.stringify(b.key) === JSON.stringify(after)) + 1 : 0;
    const buckets = all.slice(start, start + size);
    return { aggregations: { c: { buckets, after_key: buckets.at(-1)?.key } } };
  };
  return { call, calls };
}
