// The viewer's page. What Deckard found, agents and MCP servers, comes from /api/overview,
// and where its scans stand from /api/scans; everything Deckard sent is text from a scanned
// machine or cloud, so it only ever reaches the page as text nodes.

const REFRESH_MS = 60_000;
const REFRESH_EMPTY_MS = 15_000;
const NEW_SHOWN = 5;
// How often to look again while a scan is running or waiting to.
const SCAN_POLL_MS = 4_000;
// Sources whose scan reads a file another tool writes: scanning again reads the same file.
const RESCAN_ELSEWHERE = { local: "./scan-local.sh && docker compose restart deckard" };
const ACTIVE = new Set(["running", "waiting", "stopping"]);
const TABS = ["agents", "mcp", "sources"];

const state = {
  data: null,
  tab: TABS.includes(location.hash.slice(1)) ? location.hash.slice(1) : "agents",
  status: "current",
  kind: "",
  source: "",
  q: "",
  sort: { key: "name", dir: 1 },
  // The MCP servers tab's own search, filters and sort.
  mcp: { status: "current", detection: "", source: "", q: "", sort: { key: "name", dir: 1 } },
  // What the drawer shows: the key of an agent, or of an MCP server when openKind says so.
  open: null,
  openKind: "agent",
  loading: false,
  // Deckard's own view of its scans: { available, reason, list }.
  scans: { available: false, reason: null, list: [] },
  // Per source: "asking" while a scan request is out, or the error it came back with.
  asking: new Map(),
  scanErrors: new Map(),
  // discovery.yaml's sources and each kind's form: { hash, sources, types, deckard }, or
  // { error } when the viewer can't change them.
  srcs: null,
  // The source being added or edited, or null.
  editor: null,
};

const $ = (id) => document.getElementById(id);
// Replaces el's children, skipping the null and false a conditional child leaves.
const fill = (el, ...kids) => el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));

// h("td", {class: "x"}, "text", child): an element, with strings as text nodes.
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

/* Formatting */

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

function ago(iso) {
  if (!iso) return "—";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 45) return "just now";
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.round(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function until(iso) {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return "—";
  const s = Math.round((t - Date.now()) / 1000);
  if (s < 45) return "any moment";
  if (s < 3600) return `in ${Math.round(s / 60)} min`;
  if (s < 86400) return `in ${Math.round(s / 3600)} h`;
  return `in ${Math.round(s / 86400)} d`;
}

const exact = (iso) => (iso && !Number.isNaN(Date.parse(iso)) ? new Date(iso).toLocaleString() : "");
const when = (iso) => h("span", { title: exact(iso) }, ago(iso));

function duration(a, b) {
  const ms = Date.parse(b) - Date.parse(a);
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.round(ms / 60_000)} min`;
}

const tilde = (p) => (typeof p === "string" ? p.replace(/^\/(home|Users)\/[^/]+/, "~") : p);

/* What an agent is, and where */

function facts(a) {
  const cs = a.agent.creation_source ?? {};
  const obs = cs.observations ?? {};
  const addr = cs.address ?? {};
  const endpoint = cs.type === "ENDPOINT" || a.agent.runs_on === "endpoint";
  // On a machine: the path, on its host. In a cloud: the account or project and region,
  // which people recognise, over the resource's own ID, which they mostly don't.
  const cloudPlace = [addr.instance, addr.scope].filter(Boolean).join(" / ");
  const resource = addr.resource_id ?? obs.service_names?.[0] ?? a.external_id;
  let where, whereSub;
  if (endpoint || obs.install_path) {
    where = obs.install_path ? tilde(obs.install_path) : resource;
    whereSub = [obs.host_name, obs.assigned_user].filter(Boolean).join(" · ");
  } else {
    where = cloudPlace || resource;
    whereSub = cloudPlace ? resource : "";
  }
  return {
    kind: obs.classification ?? null,
    where,
    whereSub,
    host: obs.host_name ?? null,
    runsOn: a.agent.runs_on ?? null,
    platform: a.agent.platform ?? null,
    obs,
    addr,
    cs,
  };
}

const RUNS_ON = { aws: "AWS", gcp: "GCP", azure: "Azure", endpoint: "Endpoint", unknown: "Unknown" };
const keyOf = (id, config) => `${id}\u0000${config ?? ""}`;
const scanOf = (s) => state.scans.list.find((x) => keyOf(x.source_id, x.config_name) === s.key);
const sourceLabel = (s) => (s.config_name ? `${s.name} / ${s.config_name}` : s.name);
// Whether a source ({id, name}) is still configured: in discovery.yaml, or else among the
// scans Deckard runs. Without either to ask, as with a viewer reading another
// Elasticsearch, every source counts as configured.
function isConfigured(src) {
  if (state.srcs?.sources) return state.srcs.sources.some((y) => y.name === src.name);
  if (state.scans.available) return state.scans.list.some((x) => x.source_id === src.id);
  return true;
}

// An agent's status, or an MCP server's, with everything a removed source found no longer
// reported: nothing scans for it any more. Elasticsearch's answer can't know that, so the
// page decides it.
const removedSource = (a) => !isConfigured(a.source);
const statusOf = (a) => (removedSource(a) ? "gone" : a.status);
const isCurrent = (a) => statusOf(a) !== "gone";

function statusBadges(a) {
  const out = [];
  const status = statusOf(a);
  if (status === "gone") {
    const title = removedSource(a) ? "Its source was removed, so nothing scans for it" : "Its source scanned successfully since, and didn't report it";
    out.push(h("span", { class: "badge", title }, "No longer reported"));
  }
  if (status === "unknown") out.push(h("span", { class: "badge warn", title: "No successful scan outcome to compare against" }, "Status unknown"));
  if (a.is_new && status !== "gone") out.push(h("span", { class: "badge new", title: `First seen ${exact(a.first_seen)}` }, "New"));
  return out;
}

/* MCP servers */

const servers = () => state.data?.mcp_servers ?? [];
// How a source knows a server is there, in words. A value this page doesn't know is shown
// as the source sent it.
const DETECTION = {
  called: ["Called", "Tool calls to it were seen passing through a gateway"],
  registered: ["Registered", "It is in a gateway's or a registry's own list of servers, called or not"],
};
const detectionLabel = (d) => DETECTION[d]?.[0] ?? d ?? "—";
const toolNames = (m) => (m.mcp_server.tools ?? []).map((t) => t?.name).filter(Boolean);
const usedBy = (m) => m.mcp_server.used_by ?? [];
// The agent an MCP server's used_by names: the same external ID, from the same source.
const agentUsing = (m, externalId) => state.data.agents.find((a) => a.source.id === m.source.id && a.external_id === externalId);
const serversUsedBy = (a) => servers().filter((m) => m.source.id === a.source.id && usedBy(m).includes(a.external_id));

/* Rendering */

function renderStats() {
  const { agents } = state.data;
  const sources = configuredSources();
  const current = agents.filter(isCurrent).length;
  // New and no longer reported count MCP servers with the agents: neither tile names one.
  const found = [...agents, ...servers()];
  const fresh = found.filter((a) => a.is_new && isCurrent(a)).length;
  const gone = found.filter((a) => statusOf(a) === "gone").length;
  const failing = sources.filter((s) => s.last_scan?.succeeded === false).length;
  const coverage = sources.map((s) => s.last_scan?.device_coverage).filter(Boolean);
  const unreadable = coverage.reduce((n, c) => n + (c.devices_unreadable ?? 0), 0);

  const mcp = servers().filter(isCurrent).length;

  const stat = (value, label, cls) => h("div", { class: `stat ${cls || ""}` }, h("div", { class: "value" }, value), h("div", { class: "label" }, label));
  fill($("stats"), 
    stat(current.toLocaleString(), current === 1 ? "AI agent found" : "AI agents found"),
    servers().length ? stat(mcp.toLocaleString(), mcp === 1 ? "MCP server found" : "MCP servers found") : null,
    stat(fresh.toLocaleString(), "new in the last 7 days", fresh ? "new" : ""),
    stat(gone.toLocaleString(), "no longer reported"),
    stat(failing ? `${failing} of ${sources.length}` : `${sources.length}`,
      failing ? "sources failing" : !sources.length ? "sources scanned yet" : sources.length === 1 ? "source, scanning fine" : "sources, all scanning fine",
      failing ? "bad" : ""),
    coverage.length ? stat(unreadable.toLocaleString(), unreadable === 1 ? "machine Deckard can't read" : "machines Deckard can't read", unreadable ? "warn" : "") : null,
  );
}

function renderAttention() {
  const { agents } = state.data;
  const sources = configuredSources();
  const items = [];
  const goSource = () => setTab("sources");

  for (const s of sources) {
    const ls = s.last_scan;
    if (!ls) continue;
    if (ls.succeeded === false) {
      items.push([h("span", { class: "badge bad" }, "Scan failing"),
        h("span", { class: "what" }, h("a", { onclick: goSource }, sourceLabel(s)), `: ${ls.error_code ?? "error"}`, ls.error ? ` — ${ls.error}` : "",
          h("span", { class: "muted" }, ` · ${ago(ls.at)}`))]);
    }
    if (ls.denied_scopes?.length) {
      items.push([h("span", { class: "badge warn" }, "Scopes refused"),
        h("span", { class: "what" }, h("a", { onclick: goSource }, sourceLabel(s)), `: ${plural(ls.denied_scopes.length, "scope")} it couldn't read, so their agents are invisible`)]);
    }
    const unreadable = ls.device_coverage?.devices_unreadable ?? 0;
    if (unreadable) {
      items.push([h("span", { class: "badge warn" }, "Machines unreadable"),
        h("span", { class: "what" }, h("a", { onclick: goSource }, sourceLabel(s)), `: ${plural(unreadable, "machine")} the scan couldn't read`)]);
    }
    if (ls.records_failed) {
      items.push([h("span", { class: "badge warn" }, "Not delivered"),
        h("span", { class: "what" }, h("a", { onclick: goSource }, sourceLabel(s)), `: ${plural(ls.records_failed, "agent")} the destination refused`)]);
    }
  }

  const fresh = agents.filter((a) => a.is_new && isCurrent(a)).sort((x, y) => Date.parse(y.first_seen) - Date.parse(x.first_seen));
  for (const a of fresh.slice(0, NEW_SHOWN)) {
    const f = facts(a);
    items.push([h("span", { class: "badge new" }, "New agent"),
      h("span", { class: "what" }, h("a", { onclick: () => openAgent(a.key) }, a.name), f.where ? ` at ${f.where}` : "",
        h("span", { class: "muted" }, ` · first seen ${ago(a.first_seen)}`))]);
  }
  if (fresh.length > NEW_SHOWN) {
    items.push([h("span", { class: "badge new" }, "New agents"), h("span", { class: "what muted" }, `and ${fresh.length - NEW_SHOWN} more in the last 7 days`)]);
  }

  const freshServers = servers().filter((m) => m.is_new && isCurrent(m)).sort((x, y) => Date.parse(y.first_seen) - Date.parse(x.first_seen));
  for (const m of freshServers.slice(0, NEW_SHOWN)) {
    const users = usedBy(m).length;
    items.push([h("span", { class: "badge new" }, "New MCP server"),
      h("span", { class: "what" }, h("a", { onclick: () => openServer(m.key) }, m.name), ` from ${m.source.name ?? m.source.id}`,
        users ? `, used by ${plural(users, "agent")}` : "",
        h("span", { class: "muted" }, ` · first seen ${ago(m.first_seen)}`))]);
  }
  if (freshServers.length > NEW_SHOWN) {
    items.push([h("span", { class: "badge new" }, "New MCP servers"), h("span", { class: "what muted" }, `and ${freshServers.length - NEW_SHOWN} more in the last 7 days`)]);
  }

  const box = $("attention");
  box.hidden = !items.length;
  fill(box, h("h3", {}, "Needs attention"), h("ul", {}, items.map((parts) => h("li", {}, parts))));
}

function fillSelect(sel, values, label) {
  const keep = sel.value;
  fill(sel, h("option", { value: "" }, label), ...values.map(([v, text]) => h("option", { value: v }, text)));
  sel.value = values.some(([v]) => v === keep) ? keep : "";
}

function renderFilters() {
  const kinds = [...new Set(state.data.agents.map((a) => facts(a).kind).filter(Boolean))].sort();
  fillSelect($("filter-kind"), kinds.map((k) => [k, k]), "Every kind");
  const sources = new Map(state.data.agents.map((a) => [a.source.id, a.source.name ?? a.source.id]));
  fillSelect($("filter-source"), [...sources].sort((x, y) => x[1].localeCompare(y[1])), "Every source");
  state.kind = $("filter-kind").value;
  state.source = $("filter-source").value;
}

function sortValue(a, key) {
  const f = facts(a);
  switch (key) {
    case "kind": return (f.kind ?? "").toLowerCase();
    case "where": return String(f.where ?? "").toLowerCase();
    case "runs_on": return f.runsOn ?? "";
    case "source": return (a.source.name ?? "").toLowerCase();
    case "first_seen": return Date.parse(a.first_seen) || 0;
    case "last_seen": return Date.parse(a.last_seen) || 0;
    default: return a.name.toLowerCase();
  }
}

function visibleAgents() {
  const q = state.q.trim().toLowerCase();
  return state.data.agents
    .filter((a) => state.status === "all" || (state.status === "gone" ? statusOf(a) === "gone" : isCurrent(a)))
    .filter((a) => !state.kind || facts(a).kind === state.kind)
    .filter((a) => !state.source || a.source.id === state.source)
    .filter((a) => {
      if (!q) return true;
      const f = facts(a);
      return [a.name, a.external_id, f.kind, f.where, f.whereSub, f.obs.install_path, a.source.name, f.runsOn]
        .some((v) => v && String(v).toLowerCase().includes(q));
    })
    .sort((x, y) => {
      const a = sortValue(x, state.sort.key);
      const b = sortValue(y, state.sort.key);
      return (a < b ? -1 : a > b ? 1 : 0) * state.sort.dir || x.name.localeCompare(y.name);
    });
}

function renderAgents() {
  const rows = visibleAgents();
  $("count-agents").textContent = state.data.agents.filter(isCurrent).length.toLocaleString();
  for (const th of document.querySelectorAll("table.agents th[data-sort]")) {
    th.setAttribute("aria-sort", th.dataset.sort === state.sort.key ? (state.sort.dir > 0 ? "ascending" : "descending") : "none");
  }
  fill($("agents-body"), ...rows.map((a) => {
    const f = facts(a);
    return h("tr", {
      class: statusOf(a) === "gone" ? "gone" : "",
      tabindex: "0",
      onclick: () => openAgent(a.key),
      onkeydown: (e) => { if (e.key === "Enter") openAgent(a.key); },
    },
      h("td", { class: "name" }, a.name, statusBadges(a)),
      h("td", {}, f.kind ?? h("span", { class: "muted" }, "—")),
      h("td", { class: "where" }, h("div", { class: "mono" }, f.where), f.whereSub ? h("div", { class: "sub" }, f.whereSub) : null),
      h("td", {}, RUNS_ON[f.runsOn] ?? f.runsOn ?? "—", f.platform ? h("div", { class: "sub" }, f.platform) : null),
      h("td", {}, a.source.name ?? a.source.id, a.source.vendor ? h("div", { class: "sub" }, a.source.vendor) : null),
      h("td", { class: "when" }, when(a.first_seen)),
      h("td", { class: "when" }, when(a.last_seen)),
    );
  }));
  const empty = $("agents-empty");
  empty.hidden = rows.length > 0;
  document.querySelector("#panel-agents .table-wrap").hidden = !rows.length;
  if (!rows.length) {
    if (state.data.agents.length) empty.textContent = "No agents match these filters.";
    else if (state.data.sources.length) empty.textContent = "Deckard's scans haven't found any AI agents.";
    else empty.textContent = "Waiting for Deckard's first scan. It scans when it starts, so agents show here within a minute or so; this page refreshes itself.";
  }
}

function renderMcpFilters() {
  const found = [...new Set(servers().map((m) => m.mcp_server.detection).filter(Boolean))].sort();
  fillSelect($("mcp-filter-detection"), found.map((d) => [d, detectionLabel(d)]), "However found");
  const sources = new Map(servers().map((m) => [m.source.id, m.source.name ?? m.source.id]));
  fillSelect($("mcp-filter-source"), [...sources].sort((x, y) => x[1].localeCompare(y[1])), "Every source");
  state.mcp.detection = $("mcp-filter-detection").value;
  state.mcp.source = $("mcp-filter-source").value;
}

function mcpSortValue(m, key) {
  switch (key) {
    case "detection": return m.mcp_server.detection ?? "";
    case "tools": return toolNames(m).length;
    case "used_by": return usedBy(m).length;
    case "source": return (m.source.name ?? "").toLowerCase();
    case "first_seen": return Date.parse(m.first_seen) || 0;
    case "last_seen": return Date.parse(m.last_seen) || 0;
    default: return m.name.toLowerCase();
  }
}

function visibleServers() {
  const f = state.mcp;
  const q = f.q.trim().toLowerCase();
  return servers()
    .filter((m) => f.status === "all" || (f.status === "gone" ? statusOf(m) === "gone" : isCurrent(m)))
    .filter((m) => !f.detection || m.mcp_server.detection === f.detection)
    .filter((m) => !f.source || m.source.id === f.source)
    .filter((m) => {
      if (!q) return true;
      return [m.name, m.external_id, m.source.name, detectionLabel(m.mcp_server.detection), ...toolNames(m), ...usedBy(m)]
        .some((v) => v && String(v).toLowerCase().includes(q));
    })
    .sort((x, y) => {
      const a = mcpSortValue(x, f.sort.key);
      const b = mcpSortValue(y, f.sort.key);
      return (a < b ? -1 : a > b ? 1 : 0) * f.sort.dir || x.name.localeCompare(y.name);
    });
}

function renderMcp() {
  const rows = visibleServers();
  $("count-mcp").textContent = servers().filter(isCurrent).length.toLocaleString();
  for (const th of document.querySelectorAll("table.servers th[data-sort]")) {
    th.setAttribute("aria-sort", th.dataset.sort === state.mcp.sort.key ? (state.mcp.sort.dir > 0 ? "ascending" : "descending") : "none");
  }
  const dash = () => h("span", { class: "muted" }, "—");
  fill($("mcp-body"), ...rows.map((m) => {
    const d = m.mcp_server.detection;
    const tools = toolNames(m).length;
    const users = usedBy(m).length;
    return h("tr", {
      class: statusOf(m) === "gone" ? "gone" : "",
      tabindex: "0",
      onclick: () => openServer(m.key),
      onkeydown: (e) => { if (e.key === "Enter") openServer(m.key); },
    },
      h("td", { class: "name" }, m.name, statusBadges(m)),
      h("td", {}, d ? h("span", { title: DETECTION[d]?.[1] }, detectionLabel(d)) : dash()),
      // Left out by a source that can't see them, which isn't the same as none.
      h("td", { class: "num" }, tools ? tools.toLocaleString() : h("span", { class: "muted", title: "This source didn't report any tools for it" }, "—")),
      h("td", { class: "num" }, users ? plural(users, "agent") : h("span", { class: "muted", title: "This source can't tell which agents use it" }, "—")),
      h("td", {}, m.source.name ?? m.source.id, m.source.vendor ? h("div", { class: "sub" }, m.source.vendor) : null),
      h("td", { class: "when" }, when(m.first_seen)),
      h("td", { class: "when" }, when(m.last_seen)),
    );
  }));
  const empty = $("mcp-empty");
  empty.hidden = rows.length > 0;
  document.querySelector("#panel-mcp .table-wrap").hidden = !rows.length;
  if (!rows.length) {
    empty.textContent = servers().length
      ? "No MCP servers match these filters."
      : "No MCP servers found yet. Deckard reports them from sources that can see them, such as a LiteLLM proxy, and needs a release that sends them.";
  }
}

// The Scan now button for source s, or what stands in for it.
function scanControl(s, scan) {
  if (!scan) return null;
  const elsewhere = RESCAN_ELSEWHERE[scan.vendor];
  if (elsewhere) return null;
  const asking = state.asking.get(s.key);
  const label = asking ? "Queued"
    : scan.status === "running" ? "Scanning…"
    : scan.status === "waiting" ? "Queued"
    : scan.status === "stopping" ? "Stopping…"
    : "Scan now";
  const busy = asking || ACTIVE.has(scan.status);
  const title = scan.status === "waiting"
    ? "Due now, waiting for another scan to finish (max_concurrent_scans)"
    : scan.status === "stopping" ? "Past its scan_timeout and told to stop; it can't be scanned again until it ends"
    : busy ? null : `Scan ${sourceLabel(s)} now instead of ${until(scan.next_due_at)}`;
  return h("button", { type: "button", class: `scan-now${busy ? " busy" : ""}`, disabled: busy, title, onclick: () => askScan(s) },
    busy ? h("span", { class: "spinner", "aria-hidden": "true" }) : null, label);
}

async function askScan(s) {
  state.asking.set(s.key, true);
  state.scanErrors.delete(s.key);
  renderSources();
  try {
    const res = await fetch("/api/scans/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source_id: s.id, config_name: s.config_name ?? undefined }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `the viewer answered ${res.status}`);
    for (const updated of body.scans ?? []) {
      const i = state.scans.list.findIndex((x) => x.source_id === updated.source_id && x.config_name === updated.config_name);
      if (i >= 0) state.scans.list[i] = updated;
      else state.scans.list.push(updated);
    }
  } catch (err) {
    state.scanErrors.set(s.key, `Unable to start the scan: ${err.message}`);
  } finally {
    state.asking.delete(s.key);
    renderSources();
    pollScans();
  }
}

// The sources with events that are still configured. A source removed from discovery.yaml
// keeps its scans in Elasticsearch, but isn't a source any more. Without discovery.yaml or
// Deckard to ask, as with a viewer reading another Elasticsearch, every source with events.
function configuredSources() {
  return state.data.sources.filter(isConfigured);
}

// Every configured source with events, then every scan Deckard has configured that hasn't
// sent any, then every source in discovery.yaml that Deckard hasn't loaded yet.
function sourceList() {
  const sources = configuredSources();
  const known = new Set(sources.map((s) => s.key));
  const unseen = state.scans.list
    .filter((x) => !known.has(keyOf(x.source_id, x.config_name)))
    .map((x) => ({
      key: keyOf(x.source_id, x.config_name),
      id: x.source_id,
      name: x.source_name,
      vendor: x.vendor,
      config_name: x.config_name,
      scans: 0,
      failed_scans: 0,
      last_scan: null,
      last_success_at: null,
      recent: [],
      unseen: true,
    }));
  // Then every source in discovery.yaml that Deckard hasn't loaded yet: saved, but not
  // applied, as when Deckard couldn't be asked to apply it and will at its next check.
  const named = new Set([...sources, ...unseen].map((s) => s.name));
  const pending = (state.srcs?.sources ?? [])
    .filter((y) => !named.has(y.name))
    .flatMap((y) => (y.configs.length ? y.configs : [{ name: null }]).map((c) => ({
      key: `pending\u0000${y.name}\u0000${c.name ?? ""}`,
      id: null,
      name: y.name,
      vendor: y.vendor,
      config_name: c.name,
      scans: 0,
      failed_scans: 0,
      last_scan: null,
      last_success_at: null,
      recent: [],
      pending: true,
    })));
  return [...sources, ...unseen, ...pending];
}

function renderSources() {
  if (!state.data) return;
  const sources = sourceList();
  $("count-sources").textContent = sources.length.toLocaleString();
  const empty = $("sources-empty");
  empty.hidden = sources.length > 0;
  empty.textContent = "No scans yet. Deckard scans each source when it starts, and every interval after.";
  const note = $("scans-note");
  note.hidden = state.scans.available || !state.scans.reason;
  note.textContent = `Scan now is unavailable. ${state.scans.reason ?? ""}.`;
  renderSourcesStatus();

  const order = (s) => (s.last_scan?.succeeded === false ? 0 : 1);
  const list = [...sources].sort((a, b) => order(a) - order(b) || sourceLabel(a).localeCompare(sourceLabel(b)));
  fill($("sources-list"), ...list.map((s) => {
    const ls = s.last_scan;
    const scan = scanOf(s);
    const scanError = state.scanErrors.get(s.key);
    const agentsHere = state.data.agents.filter((a) => a.source.id === s.id && a.source.config_name === s.config_name && isCurrent(a)).length;
    const serversHere = servers().filter((m) => m.source.id === s.id && m.source.config_name === s.config_name && isCurrent(m)).length;
    let pill;
    if (s.pending) pill = h("span", { class: "badge", title: "Saved in discovery.yaml; Deckard starts scanning it within a few seconds" }, "Starting…");
    else if (s.unseen) pill = h("span", { class: "badge" }, ACTIVE.has(scan?.status) ? "First scan" : "Not scanned yet");
    else if (!ls) pill = h("span", { class: "badge", title: "This source sends no scan outcomes: set emit_scan_outcomes: true" }, "No scan outcomes");
    else if (ls.succeeded) pill = h("span", { class: "badge ok" }, "Scanning fine");
    else pill = h("span", { class: "badge bad" }, "Last scan failed");

    const dl = (pairs) => h("dl", { class: "facts" }, pairs.filter(Boolean).map(([k, v]) => h("div", {}, h("dt", {}, k), h("dd", {}, v))));
    const cov = ls?.device_coverage;
    return h("article", { class: "source" },
      h("div", { class: "source-head" },
        h("div", {}, h("h3", {}, s.name), h("div", { class: "meta" }, [s.vendor, s.config_name && `config ${s.config_name}`].filter(Boolean).join(" · "))),
        h("div", { class: "source-actions" }, pill, scanControl(s, scan), editControl(s))),
      dl([
        ["Last scan", ls ? when(ls.at) : "—"],
        ls && ["Took", duration(ls.started_at, ls.finished_at)],
        ["Agents now", agentsHere.toLocaleString()],
        (serversHere || ls?.mcp_servers_published) && ["MCP servers now", serversHere.toLocaleString()],
        ls && ["Sent last scan", ls.mcp_servers_published
          ? `${plural(ls.records_published ?? 0, "agent")}, ${plural(ls.mcp_servers_published, "MCP server")}`
          : (ls.records_published ?? "—")],
        ["Scans", s.failed_scans ? `${s.scans.toLocaleString()} (${s.failed_scans.toLocaleString()} failed)` : s.scans.toLocaleString()],
        s.last_success_at && ls && !ls.succeeded && ["Last success", when(s.last_success_at)],
        scan && scan.status === "scheduled" && scan.next_due_at && ["Next scan", h("span", { title: exact(scan.next_due_at) }, until(scan.next_due_at))],
        scan && RESCAN_ELSEWHERE[scan.vendor] && ["Rescan", h("code", { title: "In docker-compose/: scanning again from here would read the same file" }, RESCAN_ELSEWHERE[scan.vendor])],
        cov && ["Machines read", `${(cov.devices_read ?? 0).toLocaleString()} of ${(cov.devices_in_scope ?? cov.devices_read ?? 0).toLocaleString()}`],
      ]),
      scanError ? h("div", { class: "error-box" }, scanError) : null,
      ls && ls.succeeded === false
        ? h("div", { class: "error-box" }, h("strong", {}, ls.error_code ?? "error"), ls.error ? `: ${ls.error}` : "")
        : null,
      ls?.denied_scopes?.length
        ? h("div", { class: "warn-box" }, h("strong", {}, `${plural(ls.denied_scopes.length, "scope")} refused`), " — agents there are invisible to Deckard.",
            h("ul", {}, ls.denied_scopes.map((d) => h("li", {}, h("code", {}, d.scope ?? JSON.stringify(d)), d.reason ? ` (${d.reason})` : ""))))
        : null,
      cov?.devices_unreadable
        ? h("div", { class: "warn-box" },
            h("strong", {}, `${plural(cov.devices_unreadable, "machine")} unreadable`), " — where unmanaged AI could be.",
            h("table", { class: "sub-table" },
              h("thead", {}, h("tr", {}, h("th", {}, "Machine"), h("th", {}, "Where"), h("th", {}, "Why"), h("th", {}, "Last reported"))),
              h("tbody", {}, (cov.unreadable_devices ?? []).map((d) => h("tr", {},
                h("td", {}, d.name ?? d.device_key ?? "—"),
                h("td", {}, d.location ?? "—"),
                h("td", {}, d.reason ?? "—"),
                h("td", {}, d.last_reported ? when(d.last_reported) : "never"))))),
            cov.unreadable_devices_truncated ? h("p", { class: "small muted" }, `and ${cov.unreadable_devices_truncated.toLocaleString()} more not listed`) : null)
        : null,
      ls?.failed_records?.length
        ? h("div", { class: "warn-box" }, h("strong", {}, `${plural(ls.failed_records.length, "agent")} not delivered`),
            h("ul", {}, ls.failed_records.map((r) => h("li", {}, h("code", {}, r.external_id ?? "?"), `: ${r.reason ?? ""}${r.detail ? ` — ${r.detail}` : ""}`))))
        : null,
      s.recent.length
        ? h("div", { class: "history" },
            h("div", { class: "label" }, `Last ${plural(s.recent.length, "scan")}, oldest first`),
            h("div", { class: "ticks" }, tickBars(s.recent)))
        : null,
    );
  }));
}

function tickBars(recent) {
  const max = Math.max(1, ...recent.map((r) => r.records_published ?? 0));
  return [...recent].reverse().map((r) => {
    const cls = r.succeeded === false ? "tick bad" : r.succeeded ? "tick" : "tick unknown";
    const label = r.succeeded === false
      ? `${exact(r.at)}: failed, ${r.error_code ?? "error"}`
      : `${exact(r.at)}: ${plural(r.records_published ?? 0, "agent")}${r.mcp_servers_published ? ` and ${plural(r.mcp_servers_published, "MCP server")}` : ""} sent`;
    const el = h("div", { class: cls, title: label, "aria-label": label });
    el.style.height = r.succeeded === false ? "100%" : `${Math.max(18, ((r.records_published ?? 0) / max) * 100)}%`;
    return el;
  });
}

/* Agent details */

function openAgent(key) {
  state.open = key;
  state.openKind = "agent";
  renderDrawer();
}

function openServer(key) {
  state.open = key;
  state.openKind = "mcp";
  renderDrawer();
}

function closeAgent() {
  state.open = null;
  $("drawer").hidden = true;
  if (!state.editor) $("scrim").hidden = true;
}

function renderDrawer() {
  return state.openKind === "mcp" ? renderServerDrawer() : renderAgentDrawer();
}

const kv = (pairs) => h("dl", { class: "kv" }, pairs
  .filter(([, v]) => v != null && v !== "" && !(Array.isArray(v) && !v.length))
  .map(([k, v]) => [h("dt", {}, k), h("dd", {}, Array.isArray(v) ? h("div", { class: "chips" }, v.map((x) => h("span", { class: "badge" }, x))) : v)]));

// The drawer's last two sections, the same for an agent and an MCP server: when it was
// seen, and everything the source sent. sightings is filled in once the viewer answers.
function seenSections(x, record, sightings) {
  const raw = JSON.stringify(record, null, 2);
  const copy = h("button", { type: "button", onclick: async () => {
    try { await navigator.clipboard.writeText(raw); copy.textContent = "Copied"; } catch { copy.textContent = "Copy failed"; }
    setTimeout(() => { copy.textContent = "Copy JSON"; }, 1500);
  } }, "Copy JSON");
  return [
    h("section", {}, h("h3", {}, "Seen"), kv([
      ["First seen", h("span", { title: exact(x.first_seen) }, `${ago(x.first_seen)} · ${exact(x.first_seen)}`)],
      ["Last seen", h("span", { title: exact(x.last_seen) }, `${ago(x.last_seen)} · ${exact(x.last_seen)}`)],
      ["Source last saw it", record.last_seen ? h("span", { title: exact(record.last_seen) }, ago(record.last_seen)) : null],
      ["Source", [x.source.name, x.source.vendor, x.source.config_name].filter(Boolean).join(" · ")],
    ]), sightings),
    h("section", {}, h("details", {}, h("summary", {}, "Everything the source reported"), h("pre", { class: "raw" }, raw), h("div", { class: "row-actions" }, copy))),
  ];
}

// Says how often x was reported, once the viewer has counted. kind is what x is to
// /api/sightings: "agent" or "mcp_server".
async function fillSightings(el, x, kind) {
  try {
    const res = await fetch(`/api/sightings?${new URLSearchParams({ source_id: x.source.id, external_id: x.external_id, kind })}`);
    if (!res.ok || state.open !== x.key) return;
    const s = await res.json();
    if (s.times.length > 1) {
      const gaps = s.times.slice(0, -1).map((t, i) => Date.parse(t) - Date.parse(s.times[i + 1])).filter((g) => g > 0).sort((x, y) => x - y);
      const typical = gaps[Math.floor(gaps.length / 2)];
      el.textContent = `Reported in ${plural(s.total, "scan")}, about every ${typical >= 3_600_000 ? `${Math.round(typical / 3_600_000)} h` : `${Math.max(1, Math.round(typical / 60_000))} min`}.`;
    }
  } catch {
    // The count from the overview stays.
  }
}

async function renderServerDrawer() {
  const m = servers().find((x) => x.key === state.open);
  if (!m) return closeAgent();
  const record = m.mcp_server;
  const d = record.detection;
  $("drawer").hidden = false;
  $("scrim").hidden = false;
  $("drawer-title").textContent = m.name;
  fill($("drawer-badges"),
    ...statusBadges(m),
    h("span", { class: "badge accent" }, "MCP server"),
    d ? h("span", { class: "badge", title: DETECTION[d]?.[1] }, detectionLabel(d)) : null,
    record.runs_on ? h("span", { class: "badge" }, RUNS_ON[record.runs_on] ?? record.runs_on) : null,
  );

  const users = usedBy(m);
  const tools = toolNames(m);
  const sightings = h("p", { class: "muted" }, `Reported in ${plural(m.sightings, "scan")}.`);
  fill($("drawer-body"),
    h("section", {}, h("h3", {}, "What it is"), kv([
      ["How found", d ? h("span", { class: "prose" }, `${detectionLabel(d)}${DETECTION[d] ? `: ${DETECTION[d][1].toLowerCase()}` : ""}`) : null],
      ["Runs on", record.runs_on ? (RUNS_ON[record.runs_on] ?? record.runs_on) : null],
      ["External ID", h("span", { class: "mono" }, m.external_id)],
    ])),
    h("section", {}, h("h3", {}, "Used by"),
      users.length
        ? h("ul", { class: "link-list" }, users.map((id) => {
            const a = agentUsing(m, id);
            // An agent this page doesn't hold: read before this scan's agents were, or
            // from a source whose agents went elsewhere.
            return h("li", {}, a ? h("a", { onclick: () => openAgent(a.key) }, a.name) : h("span", { class: "mono" }, id));
          }))
        : h("p", { class: "muted" }, "This source can't tell which agents use it. That isn't the same as no agent using it.")),
    h("section", {}, h("h3", {}, `Tools${tools.length ? ` (${tools.length.toLocaleString()})` : ""}`),
      tools.length
        ? h("div", { class: "chips" }, tools.map((t) => h("span", { class: "badge" }, t)))
        : h("p", { class: "muted" }, "This source didn't report any tools for it.")),
    ...seenSections(m, record, sightings),
  );
  fillSightings(sightings, m, "mcp_server");
}

async function renderAgentDrawer() {
  const a = state.data?.agents.find((x) => x.key === state.open);
  if (!a) return closeAgent();
  const f = facts(a);
  const { obs, addr, cs } = f;
  $("drawer").hidden = false;
  $("scrim").hidden = false;
  $("drawer-title").textContent = a.name;
  fill($("drawer-badges"), 
    ...statusBadges(a),
    f.kind ? h("span", { class: "badge accent" }, f.kind) : null,
    f.runsOn ? h("span", { class: "badge" }, RUNS_ON[f.runsOn] ?? f.runsOn) : null,
  );

  const sightings = h("p", { class: "muted" }, `Reported in ${plural(a.sightings, "scan")}.`);
  const uses = serversUsedBy(a);

  fill($("drawer-body"), 
    h("section", {}, h("h3", {}, "Where it is"), kv([
      ["Install path", obs.install_path ? h("span", { class: "mono" }, obs.install_path) : null],
      ["Host", obs.host_name],
      ["Host group", obs.host_group],
      ["OS", obs.os_version],
      ["Platform", f.platform],
      ["Assigned user", obs.assigned_user],
      ["Account / project", addr.instance && cs.type !== "ENDPOINT" ? addr.instance : null],
      ["Scope", addr.scope],
      ["Resource", addr.resource_id && addr.resource_id !== obs.install_path ? h("span", { class: "mono" }, addr.resource_id) : null],
      ["Resource kind", addr.resource_kind],
    ])),
    h("section", {}, h("h3", {}, "What it is"), kv([
      ["Kind", f.kind],
      ["Version", obs.version],
      ["Previous version", obs.previous_version],
      ["Permissions", obs.permissions],
      ["Services", obs.service_names],
      ["External ID", h("span", { class: "mono" }, a.external_id)],
    ])),
    obs.occurrences?.length
      ? h("section", {}, h("h3", {}, "Found as"),
          h("table", { class: "sub-table" },
            h("thead", {}, h("tr", {}, h("th", {}, "Kind"), h("th", {}, "Path"), h("th", {}, "Version"))),
            h("tbody", {}, obs.occurrences.map((o) => h("tr", {}, h("td", {}, o.kind ?? "—"), h("td", { class: "mono" }, tilde(o.path) ?? "—"), h("td", {}, o.version ?? "—"))))))
      : null,
    uses.length
      ? h("section", {}, h("h3", {}, "MCP servers it uses"),
          h("ul", { class: "link-list" }, uses.map((m) => h("li", {}, h("a", { onclick: () => openServer(m.key) }, m.name),
            toolNames(m).length ? h("span", { class: "muted" }, ` · ${plural(toolNames(m).length, "tool")}`) : null))))
      : null,
    ...seenSections(a, a.agent, sightings),
  );
  fillSightings(sightings, a, "agent");
}


/* Adding and editing sources */

const CLASS_LABEL = { cloud: "Cloud", endpoint: "Endpoints (MDM)", siem: "SIEM", network: "Network logs" };
// Kinds that aren't added from here: this machine's scan is set up by ./start.sh.
const NOT_ADDED_HERE = new Set(["local"]);
const LOOKBACKS = [
  [3600, "1 hour"], [6 * 3600, "6 hours"], [86400, "1 day"], [7 * 86400, "7 days"], [30 * 86400, "30 days"], [0, "Everything (full listing)"],
];
const QUERY_LANGUAGE = { spl: "SPL", esql: "ES|QL", kql: "KQL" };

const yamlSource = (name) => state.srcs?.sources?.find((x) => x.name === name);
const typeOf = (vendor) => state.srcs?.types?.find((t) => t.vendor === vendor);
const label = (name) => name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()).replace(/\bUrl\b|\burl\b/g, "URL").replace(/\bid\b/gi, "ID").replace(/\bca\b/gi, "CA").replace(/\bapi\b/gi, "API").replace(/\btls\b/gi, "TLS");
// Secrets are never multi-line here: they are password inputs, so they don't show on
// screen. A browser strips the line breaks from what is pasted into one, which leaves a
// service account's JSON key valid: its own line breaks are escaped inside its strings.
const multiline = (f) => !f.is_sensitive && /certificate|_key$|regex|query/.test(f.name);
// What a query's results must hold, for the vendors whose scans run one.
const QUERY_HELP = "One row per agent, with external_id (stable across scans), name and last_seen columns. llm_models, tools, sub_agents, data_sources, runs_on and platform are optional; any other column fails the scan.";
const QUERY_EXAMPLE = {
  spl: "search index=<index> <filter>\n| stats max(_time) as last_seen, values(model) as llm_models by consumer\n| eval external_id=\"<namespace>:\" . consumer, name=consumer, last_seen=strftime(last_seen, \"%Y-%m-%dT%H:%M:%SZ\")\n| table external_id, name, last_seen, llm_models",
  esql: "FROM <index>\n| STATS last_seen = MAX(@timestamp), llm_models = VALUES(model) BY consumer\n| EVAL external_id = CONCAT(\"<namespace>:\", consumer), name = consumer\n| KEEP external_id, name, last_seen, llm_models\n| LIMIT 10000",
};

async function loadSources() {
  try {
    const res = await fetch("/api/sources");
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `the viewer answered ${res.status}`);
    state.srcs = { hash: body.hash, sources: body.sources, types: body.source_types, deckard: body.deckard };
  } catch (err) {
    state.srcs = { error: err.message };
  }
  // Which sources are configured decides what the stats and Needs attention count, and
  // which agents are no longer reported, too.
  if (state.data) { renderStats(); renderAttention(); renderAgents(); renderMcp(); }
  renderSources();
}

function renderSourcesStatus() {
  const add = $("add-source");
  add.hidden = !state.srcs || !!state.srcs.error;
  const box = $("sources-status");
  const d = state.srcs?.deckard;
  fill(box,
    state.srcs?.error ? h("p", { class: "small muted scans-note" }, `Adding sources is unavailable. ${state.srcs.error}.`) : null,
    d?.error
      ? h("div", { class: "error-box" }, h("strong", {}, "Deckard can't use discovery.yaml as it is now"),
          `, so it's still scanning with the version it loaded ${ago(d.loaded_at)}. `, h("pre", { class: "plain" }, d.error))
      : null,
    d?.restart_required?.length
      ? h("div", { class: "warn-box" }, h("strong", {}, `${d.restart_required.join(", ")} changed`),
          " in discovery.yaml. That takes effect when Deckard restarts: ", h("code", {}, "docker compose restart deckard"))
      : null);
}

function editControl(s) {
  if (!state.srcs || state.srcs.error || !yamlSource(s.name)) return null;
  return h("button", { type: "button", onclick: () => openEditor(s.name) }, "Edit");
}

function openEditor(name) {
  const existing = name ? yamlSource(name) : null;
  const config = existing?.configs?.[0];
  state.editor = {
    name: existing?.name ?? "",
    editing: existing ? existing.name : null,
    vendor: existing?.vendor ?? "",
    // Each field as the form shows it. A secret, and a value read from a file, start
    // blank: blank keeps what discovery.yaml has.
    values: Object.fromEntries((existing?.fields ?? []).filter((f) => !f.secret && f.ref !== "file").map((f) => [f.key, f.value])),
    config: {
      name: config?.name ?? "default",
      query: config?.query ?? "",
      query_file: config?.query_file,
      query_language: config?.query_language,
      lookback_window_seconds: config?.lookback_window_seconds ?? 86400,
    },
    otherConfigs: (existing?.configs ?? []).slice(1),
    test: null,
    busy: null,
    error: null,
  };
  $("editor").hidden = false;
  $("scrim").hidden = false;
  renderEditor();
}

function closeEditor() {
  state.editor = null;
  $("editor").hidden = true;
  if (!state.open) $("scrim").hidden = true;
}

function renderEditor() {
  const e = state.editor;
  if (!e) return;
  const type = typeOf(e.vendor);
  const existing = e.editing ? yamlSource(e.editing) : null;
  $("editor-title").textContent = e.editing ? `Edit ${e.editing}` : "Add source";
  $("editor-sub").textContent = e.editing
    ? `${type?.display_name ?? e.vendor} · changes go to discovery.yaml, and Deckard applies them within seconds`
    : "Saved to discovery.yaml, with secrets in secrets/. Deckard starts scanning it within seconds.";

  const kinds = (state.srcs?.types ?? []).filter((t) => !NOT_ADDED_HERE.has(t.vendor));
  const groups = Object.entries(CLASS_LABEL).map(([cls, text]) => [text, kinds.filter((t) => t.source_class === cls)]).filter(([, ts]) => ts.length);

  const field = (f) => {
    const stored = existing?.fields?.find((x) => x.key === f.name);
    const id = `f-${f.name}`;
    let input;
    let hint = null;
    if (f.d_type === "enum") {
      input = h("select", { id, onchange: (ev) => { e.values[f.name] = ev.target.value; } },
        f.is_optional || !e.values[f.name] ? h("option", { value: "" }, f.is_optional ? "Default" : "Choose…") : null,
        (f.allowed_values ?? []).map((v) => h("option", { value: v, selected: e.values[f.name] === v }, v)));
    } else {
      const props = {
        id,
        autocomplete: "off",
        spellcheck: "false",
        oninput: (ev) => { e.values[f.name] = ev.target.value; },
      };
      if (f.is_sensitive) {
        if (stored?.set) {
          props.placeholder = "Saved. Leave blank to keep it";
          hint = stored.ref === "env" ? "Now read from an environment variable in .env" : stored.ref === "file" ? "Now read from a file in secrets/" : null;
        }
      } else if (stored?.ref === "file") {
        props.placeholder = `Read from ${stored.file}. Leave blank to keep it`;
      }
      // What was typed, secret or not: the form re-renders while a test runs.
      const value = e.values[f.name] ?? "";
      input = multiline(f)
        ? h("textarea", { ...props, rows: f.is_sensitive ? 4 : 3 }, value)
        : h("input", { ...props, type: f.is_sensitive ? "password" : "text", value });
    }
    return h("div", { class: "field" },
      h("label", { for: id }, label(f.name), f.is_optional ? h("span", { class: "muted" }, " (optional)") : null, f.is_sensitive ? h("span", { class: "badge" }, "secret") : null),
      input,
      f.description ? h("p", { class: "help" }, f.description) : null,
      hint ? h("p", { class: "help" }, hint) : null);
  };

  const c = e.config;
  const ql = type?.query_language && type.query_language !== "none" ? type.query_language : null;
  const lookbacks = LOOKBACKS.some(([v]) => v === c.lookback_window_seconds) ? LOOKBACKS : [...LOOKBACKS, [c.lookback_window_seconds, `${Math.round(c.lookback_window_seconds / 3600)} hours`]];

  fill($("editor-form"),
    e.editing ? null : h("div", { class: "field" },
      h("label", { for: "f-vendor" }, "Kind"),
      h("select", { id: "f-vendor", onchange: (ev) => { e.vendor = ev.target.value; e.values = {}; e.test = null; e.error = null; e.config.query_language = typeOf(e.vendor)?.query_language; renderEditor(); } },
        h("option", { value: "" }, "Choose a kind of source…"),
        groups.map(([text, ts]) => h("optgroup", { label: text }, ts.map((t) => h("option", { value: t.vendor, selected: t.vendor === e.vendor }, `${t.display_name}${t.availability === "preview" ? " (preview)" : ""}`)))))),
    e.editing ? null : type ? h("div", { class: "field" },
      h("label", { for: "f-name" }, "Name"),
      h("input", { id: "f-name", type: "text", autocomplete: "off", spellcheck: "false", value: e.name, placeholder: `${e.vendor.replace(/_/g, "-")}-prod`, oninput: (ev) => { e.name = ev.target.value; } }),
      h("p", { class: "help" }, "How Deckard and this page name it. Letters, digits, dots, dashes and underscores. It can't be changed later.")) : null,
    type ? h("fieldset", {}, h("legend", {}, `${type.display_name} settings`), [...type.fields].sort((a, b) => a.priority - b.priority).map(field)) : null,
    type ? h("fieldset", {}, h("legend", {}, "Scan"),
      h("div", { class: "field" },
        h("label", { for: "f-lookback" }, "Look back"),
        h("select", { id: "f-lookback", onchange: (ev) => { c.lookback_window_seconds = Number(ev.target.value); } },
          lookbacks.map(([v, t]) => h("option", { value: v, selected: v === c.lookback_window_seconds }, t))),
        h("p", { class: "help" }, "How far back each scan reads. A source that lists an inventory, rather than reading logs, ignores it.")),
      ql ? h("div", { class: "field" },
        h("label", { for: "f-query" }, `Query (${QUERY_LANGUAGE[ql] ?? ql})`),
        h("textarea", { id: "f-query", rows: 5, spellcheck: "false", placeholder: c.query_file ? `Read from ${c.query_file}. Leave blank to keep it` : QUERY_EXAMPLE[ql] ?? "", oninput: (ev) => { c.query = ev.target.value; } }, c.query ?? ""),
        h("p", { class: "help" }, QUERY_HELP)) : null,
      e.otherConfigs.length ? h("p", { class: "help" }, `This source has ${plural(e.otherConfigs.length + 1, "config")}; only ${c.name} is edited here, and the rest are kept as they are.`) : null) : null,
    e.error ? h("div", { class: "error-box" }, e.error) : null,
    testResult(e.test),
    type ? h("div", { class: "editor-actions" },
      h("button", { type: "button", disabled: !!e.busy, onclick: () => runTest() }, e.busy === "test" ? [h("span", { class: "spinner", "aria-hidden": "true" }), "Testing…"] : "Test connection"),
      h("button", { type: "submit", class: "primary", disabled: !!e.busy }, e.busy === "save" ? "Saving…" : e.editing ? "Save changes" : "Add source"),
      e.editing ? h("button", { type: "button", class: "danger", disabled: !!e.busy, onclick: () => removeEditing() }, e.busy === "remove" ? "Removing…" : "Remove") : null) : null,
  );
}

function testResult(t) {
  if (!t) return null;
  if (t.outcome === "succeeded") {
    const rows = t.rows ?? [];
    return h("div", { class: "ok-box" },
      h("strong", {}, "Connected."),
      ` ${rows.length ? `${plural(rows.length, "agent")}${t.truncated ? " or more" : ""} in the preview` : "The source answered, with no agents in the preview"}.`,
      rows.length ? h("table", { class: "sub-table" },
        h("thead", {}, h("tr", {}, h("th", {}, "Agent"), h("th", {}, "Runs on"), h("th", {}, "ID"))),
        h("tbody", {}, rows.slice(0, 10).map((r) => h("tr", {}, h("td", {}, r.name ?? "—"), h("td", {}, r.runs_on ?? "—"), h("td", { class: "mono" }, r.external_id ?? "—"))))) : null);
  }
  const err = t.error ?? {};
  return h("div", { class: "error-box" },
    h("strong", {}, `Test failed: ${(err.category ?? "error").replace(/_/g, " ")}`),
    err.vendor_status_code ? ` (HTTP ${err.vendor_status_code})` : "",
    h("pre", { class: "plain" }, err.message ?? ""));
}

// The form as the viewer's API takes it.
function formSource() {
  const e = state.editor;
  const fields = {};
  for (const f of typeOf(e.vendor)?.fields ?? []) {
    if (f.name in e.values) fields[f.name] = e.values[f.name] ?? "";
    else if (!yamlSource(e.editing)?.fields?.find((x) => x.key === f.name && (x.ref === "file" || x.secret))) fields[f.name] = "";
  }
  const c = e.config;
  const config = { name: c.name, query_language: typeOf(e.vendor)?.query_language ?? c.query_language ?? "none", lookback_window_seconds: c.lookback_window_seconds };
  if (!(c.query_file && !c.query)) config.query = c.query ?? "";
  return { name: e.editing ?? e.name.trim(), vendor: e.vendor, fields, configs: [config, ...e.otherConfigs] };
}

async function post(path, body) {
  const res = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `the viewer answered ${res.status}`);
  return out;
}

async function busy(kind, work) {
  const e = state.editor;
  e.busy = kind;
  e.error = null;
  renderEditor();
  try {
    await work(e);
  } catch (err) {
    e.error = err.message;
  } finally {
    e.busy = null;
    if (state.editor === e) renderEditor();
  }
}

function runTest() {
  return busy("test", async (e) => {
    e.test = null;
    e.test = await post("/api/sources/test", { source: formSource(), editing: e.editing ?? undefined, config_name: e.config.name });
  });
}

// After a change. The answer carries Deckard's scans as they stand once it applied the
// file, so a new source is on the page, scanning, straight away; its outcome reloads the
// page when it ends. A Deckard that couldn't be asked applies the file within about 5 s:
// keep asking where its scans stand until it has.
function afterChange(message, out, name) {
  closeEditor();
  showToast(message);
  if (out?.hash && state.srcs) state.srcs.hash = out.hash;
  if (out?.deckard && state.srcs) state.srcs.deckard = out.deckard;
  if (out?.scans) state.scans = { available: true, reason: null, list: out.scans };
  loadSources();
  render();
  if (out?.scans) pollScans();
  else if (name) awaitSource(name);
}

const AWAIT_SOURCE_MS = 1_000;
const AWAIT_SOURCE_TRIES = 15;

async function awaitSource(name, tries = AWAIT_SOURCE_TRIES) {
  await loadScans();
  if (tries > 1 && !state.scans.list.some((x) => x.source_name === name)) {
    setTimeout(() => awaitSource(name, tries - 1), AWAIT_SOURCE_MS);
  }
}

function saveEditor() {
  return busy("save", async (e) => {
    const source = formSource();
    const out = e.editing
      ? await post("/api/sources/update", { base_hash: state.srcs.hash, name: e.editing, source })
      : await post("/api/sources/add", { base_hash: state.srcs.hash, source });
    const started = out.scans?.some((x) => x.source_name === source.name && ACTIVE.has(x.status));
    afterChange(
      e.editing
        ? `Saved ${e.editing}.${started ? " Scanning it with the change." : ""}`
        : started ? `Added ${source.name}. Scanning it now.` : `Added ${source.name}. Deckard starts scanning it within a few seconds.`,
      out,
      source.name,
    );
  });
}

function removeEditing() {
  const e = state.editor;
  if (!confirm(`Remove ${e.editing} from discovery.yaml? Deckard stops scanning it, and the agents it found move to No longer reported. Its events stay in Elasticsearch.`)) return;
  return busy("remove", async () => {
    const out = await post("/api/sources/remove", { base_hash: state.srcs.hash, name: e.editing });
    state.srcs.sources = state.srcs.sources.filter((y) => y.name !== e.editing);
    afterChange(`Removed ${e.editing}.`, out);
  });
}

function showToast(text) {
  const t = $("toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { t.hidden = true; }, 6000);
}

/* Loading */

function setTab(tab) {
  state.tab = tab;
  history.replaceState(null, "", `#${tab}`);
  for (const b of document.querySelectorAll("[data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  for (const t of TABS) $(`panel-${t}`).hidden = t !== tab;
}

function render() {
  if (!state.data) return;
  renderStats();
  renderAttention();
  renderFilters();
  renderAgents();
  renderMcpFilters();
  renderMcp();
  renderSources();
  if (state.open) renderDrawer();
}

let timer = null;
let updatedAt = null;

async function load() {
  if (state.loading) return;
  state.loading = true;
  $("refresh").disabled = true;
  clearTimeout(timer);
  const banner = $("banner");
  try {
    const res = await fetch("/api/overview");
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `the viewer answered ${res.status}`);
    state.data = body;
    updatedAt = Date.now();
    if (!scanTimer) loadScans();
    if (!state.srcs) loadSources();
    banner.hidden = true;
    if (body.truncated) {
      banner.hidden = false;
      banner.textContent = "There are more agents or MCP servers than the viewer reads at once; some aren't shown.";
    }
    render();
  } catch (err) {
    banner.hidden = false;
    banner.textContent = `Couldn't load Deckard's events: ${err.message}`;
  } finally {
    state.loading = false;
    $("refresh").disabled = false;
    const empty = !state.data || (!state.data.agents.length && !servers().length && !state.data.sources.length);
    timer = setTimeout(load, empty ? REFRESH_EMPTY_MS : REFRESH_MS);
    showUpdated();
  }
}

// Asks where Deckard's scans stand, and keeps asking while any is running or due. When one
// ends, its outcome and agents are in Elasticsearch: reload the page's data.
let scanTimer = null;

async function loadScans() {
  const before = new Set(state.scans.list.filter((x) => ACTIVE.has(x.status)).map((x) => keyOf(x.source_id, x.config_name)));
  try {
    const res = await fetch("/api/scans");
    const body = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(body.error || `the viewer answered ${res.status}`);
    state.scans = { available: body.available, reason: body.reason ?? null, list: body.scans ?? [] };
  } catch (err) {
    state.scans = { available: false, reason: err.message, list: [] };
  }
  const ended = [...before].some((k) => !state.scans.list.some((x) => keyOf(x.source_id, x.config_name) === k && ACTIVE.has(x.status)));
  renderSources();
  if (ended) load();
  pollScans();
}

function pollScans() {
  clearTimeout(scanTimer);
  scanTimer = state.scans.list.some((x) => ACTIVE.has(x.status)) ? setTimeout(loadScans, SCAN_POLL_MS) : null;
}

function showUpdated() {
  $("updated").textContent = updatedAt ? `Updated ${ago(new Date(updatedAt).toISOString())}` : "";
}

function wire() {
  setTab(state.tab);
  $("refresh").addEventListener("click", load);
  for (const b of document.querySelectorAll("[data-tab]")) b.addEventListener("click", () => setTab(b.dataset.tab));
  for (const b of document.querySelectorAll("[data-status]")) {
    b.addEventListener("click", () => {
      state.status = b.dataset.status;
      for (const x of document.querySelectorAll("[data-status]")) x.setAttribute("aria-pressed", String(x === b));
      renderAgents();
    });
  }
  $("search").addEventListener("input", (e) => { state.q = e.target.value; renderAgents(); });
  $("filter-kind").addEventListener("change", (e) => { state.kind = e.target.value; renderAgents(); });
  $("filter-source").addEventListener("change", (e) => { state.source = e.target.value; renderAgents(); });
  for (const b of document.querySelectorAll("[data-mcp-status]")) {
    b.addEventListener("click", () => {
      state.mcp.status = b.dataset.mcpStatus;
      for (const x of document.querySelectorAll("[data-mcp-status]")) x.setAttribute("aria-pressed", String(x === b));
      renderMcp();
    });
  }
  $("mcp-search").addEventListener("input", (e) => { state.mcp.q = e.target.value; renderMcp(); });
  $("mcp-filter-detection").addEventListener("change", (e) => { state.mcp.detection = e.target.value; renderMcp(); });
  $("mcp-filter-source").addEventListener("change", (e) => { state.mcp.source = e.target.value; renderMcp(); });
  // Each table sorts on its own: which state holds its sort, and what redraws it.
  for (const [table, held, redraw] of [["agents", state, renderAgents], ["servers", state.mcp, renderMcp]]) {
    for (const th of document.querySelectorAll(`table.${table} th[data-sort]`)) {
      th.tabIndex = 0;
      const sort = () => {
        const key = th.dataset.sort;
        // Newest first for a date, most first for a count.
        const descending = ["first_seen", "last_seen", "tools", "used_by"].includes(key);
        held.sort = held.sort.key === key ? { key, dir: -held.sort.dir } : { key, dir: descending ? -1 : 1 };
        redraw();
      };
      th.addEventListener("click", sort);
      th.addEventListener("keydown", (e) => { if (e.key === "Enter") sort(); });
    }
  }
  $("drawer-close").addEventListener("click", closeAgent);
  $("editor-close").addEventListener("click", closeEditor);
  $("add-source").addEventListener("click", () => openEditor(null));
  $("editor-form").addEventListener("submit", (e) => { e.preventDefault(); saveEditor(); });
  $("scrim").addEventListener("click", () => { closeAgent(); closeEditor(); });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (state.editor) closeEditor();
    else if (state.open) closeAgent();
  });
  setInterval(showUpdated, 15_000);
  load();
}

wire();
