// The viewer's page. Everything it shows comes from /api/overview; everything Deckard sent
// is text from a scanned machine or cloud, so it only ever reaches the page as text nodes.

const REFRESH_MS = 60_000;
const REFRESH_EMPTY_MS = 15_000;
const NEW_SHOWN = 5;

const state = {
  data: null,
  tab: location.hash === "#sources" ? "sources" : "agents",
  status: "current",
  kind: "",
  source: "",
  q: "",
  sort: { key: "name", dir: 1 },
  open: null,
  loading: false,
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
const sourceLabel = (s) => (s.config_name ? `${s.name} / ${s.config_name}` : s.name);
const isCurrent = (a) => a.status !== "gone";

function statusBadges(a) {
  const out = [];
  if (a.status === "gone") out.push(h("span", { class: "badge", title: "Its source scanned successfully since, and didn't report it" }, "No longer reported"));
  if (a.status === "unknown") out.push(h("span", { class: "badge warn", title: "No successful scan outcome to compare against" }, "Status unknown"));
  if (a.is_new && a.status !== "gone") out.push(h("span", { class: "badge new", title: `First seen ${exact(a.first_seen)}` }, "New"));
  return out;
}

/* Rendering */

function renderStats() {
  const { agents, sources } = state.data;
  const current = agents.filter(isCurrent).length;
  const fresh = agents.filter((a) => a.is_new && isCurrent(a)).length;
  const gone = agents.filter((a) => a.status === "gone").length;
  const failing = sources.filter((s) => s.last_scan?.succeeded === false).length;
  const coverage = sources.map((s) => s.last_scan?.device_coverage).filter(Boolean);
  const unreadable = coverage.reduce((n, c) => n + (c.devices_unreadable ?? 0), 0);

  const stat = (value, label, cls) => h("div", { class: `stat ${cls || ""}` }, h("div", { class: "value" }, value), h("div", { class: "label" }, label));
  fill($("stats"), 
    stat(current.toLocaleString(), current === 1 ? "AI agent found" : "AI agents found"),
    stat(fresh.toLocaleString(), "new in the last 7 days", fresh ? "new" : ""),
    stat(gone.toLocaleString(), "no longer reported"),
    stat(failing ? `${failing} of ${sources.length}` : `${sources.length}`,
      failing ? "sources failing" : !sources.length ? "sources scanned yet" : sources.length === 1 ? "source, scanning fine" : "sources, all scanning fine",
      failing ? "bad" : ""),
    coverage.length ? stat(unreadable.toLocaleString(), unreadable === 1 ? "machine Deckard can't read" : "machines Deckard can't read", unreadable ? "warn" : "") : null,
  );
}

function renderAttention() {
  const { agents, sources } = state.data;
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
    .filter((a) => state.status === "all" || (state.status === "gone" ? a.status === "gone" : isCurrent(a)))
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
  for (const th of document.querySelectorAll("th[data-sort]")) {
    th.setAttribute("aria-sort", th.dataset.sort === state.sort.key ? (state.sort.dir > 0 ? "ascending" : "descending") : "none");
  }
  fill($("agents-body"), ...rows.map((a) => {
    const f = facts(a);
    return h("tr", {
      class: a.status === "gone" ? "gone" : "",
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

function renderSources() {
  const { sources } = state.data;
  $("count-sources").textContent = sources.length.toLocaleString();
  const empty = $("sources-empty");
  empty.hidden = sources.length > 0;
  empty.textContent = "No scans yet. Deckard scans each source when it starts, and every interval after.";

  const order = (s) => (s.last_scan?.succeeded === false ? 0 : 1);
  const list = [...sources].sort((a, b) => order(a) - order(b) || sourceLabel(a).localeCompare(sourceLabel(b)));
  fill($("sources-list"), ...list.map((s) => {
    const ls = s.last_scan;
    const agentsHere = state.data.agents.filter((a) => a.source.id === s.id && a.source.config_name === s.config_name && isCurrent(a)).length;
    let pill;
    if (!ls) pill = h("span", { class: "badge", title: "This source sends no scan outcomes: set emit_scan_outcomes: true" }, "No scan outcomes");
    else if (ls.succeeded) pill = h("span", { class: "badge ok" }, "Scanning fine");
    else pill = h("span", { class: "badge bad" }, "Last scan failed");

    const dl = (pairs) => h("dl", { class: "facts" }, pairs.filter(Boolean).map(([k, v]) => h("div", {}, h("dt", {}, k), h("dd", {}, v))));
    const cov = ls?.device_coverage;
    return h("article", { class: "source" },
      h("div", { class: "source-head" },
        h("div", {}, h("h3", {}, s.name), h("div", { class: "meta" }, [s.vendor, s.config_name && `config ${s.config_name}`].filter(Boolean).join(" · "))),
        pill),
      dl([
        ["Last scan", ls ? when(ls.at) : "—"],
        ls && ["Took", duration(ls.started_at, ls.finished_at)],
        ["Agents now", agentsHere.toLocaleString()],
        ls && ["Sent last scan", ls.records_published ?? "—"],
        ["Scans", s.failed_scans ? `${s.scans.toLocaleString()} (${s.failed_scans.toLocaleString()} failed)` : s.scans.toLocaleString()],
        s.last_success_at && ls && !ls.succeeded && ["Last success", when(s.last_success_at)],
        cov && ["Machines read", `${(cov.devices_read ?? 0).toLocaleString()} of ${(cov.devices_in_scope ?? cov.devices_read ?? 0).toLocaleString()}`],
      ]),
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
      : `${exact(r.at)}: ${plural(r.records_published ?? 0, "agent")} sent`;
    const el = h("div", { class: cls, title: label, "aria-label": label });
    el.style.height = r.succeeded === false ? "100%" : `${Math.max(18, ((r.records_published ?? 0) / max) * 100)}%`;
    return el;
  });
}

/* Agent details */

function openAgent(key) {
  state.open = key;
  renderDrawer();
}

function closeAgent() {
  state.open = null;
  $("drawer").hidden = true;
  $("scrim").hidden = true;
}

async function renderDrawer() {
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

  const kv = (pairs) => h("dl", { class: "kv" }, pairs
    .filter(([, v]) => v != null && v !== "" && !(Array.isArray(v) && !v.length))
    .map(([k, v]) => [h("dt", {}, k), h("dd", {}, Array.isArray(v) ? h("div", { class: "chips" }, v.map((x) => h("span", { class: "badge" }, x))) : v)]));

  const sightings = h("p", { class: "muted" }, `Reported in ${plural(a.sightings, "scan")}.`);
  const raw = JSON.stringify(a.agent, null, 2);
  const copy = h("button", { type: "button", onclick: async () => {
    try { await navigator.clipboard.writeText(raw); copy.textContent = "Copied"; } catch { copy.textContent = "Copy failed"; }
    setTimeout(() => { copy.textContent = "Copy JSON"; }, 1500);
  } }, "Copy JSON");

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
    h("section", {}, h("h3", {}, "Seen"), kv([
      ["First seen", h("span", { title: exact(a.first_seen) }, `${ago(a.first_seen)} · ${exact(a.first_seen)}`)],
      ["Last seen", h("span", { title: exact(a.last_seen) }, `${ago(a.last_seen)} · ${exact(a.last_seen)}`)],
      ["Source last saw it", a.agent.last_seen ? h("span", { title: exact(a.agent.last_seen) }, ago(a.agent.last_seen)) : null],
      ["Source", [a.source.name, a.source.vendor, a.source.config_name].filter(Boolean).join(" · ")],
    ]), sightings),
    h("section", {}, h("details", {}, h("summary", {}, "Everything the source reported"), h("pre", { class: "raw" }, raw), h("div", { class: "row-actions" }, copy))),
  );

  try {
    const res = await fetch(`/api/sightings?${new URLSearchParams({ source_id: a.source.id, external_id: a.external_id })}`);
    if (!res.ok || state.open !== a.key) return;
    const s = await res.json();
    if (s.times.length > 1) {
      const gaps = s.times.slice(0, -1).map((t, i) => Date.parse(t) - Date.parse(s.times[i + 1])).filter((g) => g > 0).sort((x, y) => x - y);
      const typical = gaps[Math.floor(gaps.length / 2)];
      sightings.textContent = `Reported in ${plural(s.total, "scan")}, about every ${typical >= 3_600_000 ? `${Math.round(typical / 3_600_000)} h` : `${Math.max(1, Math.round(typical / 60_000))} min`}.`;
    }
  } catch {
    // The count from the overview stays.
  }
}

/* Loading */

function setTab(tab) {
  state.tab = tab;
  history.replaceState(null, "", tab === "sources" ? "#sources" : "#agents");
  for (const b of document.querySelectorAll("[data-tab]")) b.setAttribute("aria-selected", String(b.dataset.tab === tab));
  $("panel-agents").hidden = tab !== "agents";
  $("panel-sources").hidden = tab !== "sources";
}

function render() {
  if (!state.data) return;
  renderStats();
  renderAttention();
  renderFilters();
  renderAgents();
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
    banner.hidden = true;
    if (body.truncated) {
      banner.hidden = false;
      banner.textContent = "There are more agents than the viewer reads at once; some aren't shown.";
    }
    render();
  } catch (err) {
    banner.hidden = false;
    banner.textContent = `Couldn't load Deckard's events: ${err.message}`;
  } finally {
    state.loading = false;
    $("refresh").disabled = false;
    const empty = !state.data || (!state.data.agents.length && !state.data.sources.length);
    timer = setTimeout(load, empty ? REFRESH_EMPTY_MS : REFRESH_MS);
    showUpdated();
  }
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
  for (const th of document.querySelectorAll("th[data-sort]")) {
    th.tabIndex = 0;
    const sort = () => {
      const key = th.dataset.sort;
      const dates = key === "first_seen" || key === "last_seen";
      state.sort = state.sort.key === key ? { key, dir: -state.sort.dir } : { key, dir: dates ? -1 : 1 };
      renderAgents();
    };
    th.addEventListener("click", sort);
    th.addEventListener("keydown", (e) => { if (e.key === "Enter") sort(); });
  }
  $("drawer-close").addEventListener("click", closeAgent);
  $("scrim").addEventListener("click", closeAgent);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && state.open) closeAgent(); });
  setInterval(showUpdated, 15_000);
  load();
}

wire();
