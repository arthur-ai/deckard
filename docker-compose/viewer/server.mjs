// Deckard's viewer: a page of the AI agents Deckard found and how its scans went, read from
// the Elasticsearch it sends to. No dependencies beyond Node itself.
//
//   GET /                 the page
//   GET /api/overview     every agent and every source, shaped for the page
//   GET /api/sightings    the scans one agent was reported in (?source_id=&external_id=)
//   GET /api/health       200 once Elasticsearch answers the viewer's user
//   GET /api/scans        where each of Deckard's scans stands, from Deckard's control API
//   POST /api/scans/run   ask Deckard to scan one source now ({source_id, config_name})
//   GET /api/sources      the sources in discovery.yaml, with no secret's value, and the
//                         form for each kind
//   POST /api/sources/add, /update, /remove, /test
//                         change discovery.yaml's sources, or Test Connection; see
//                         sources.mjs. A change is applied by Deckard before the
//                         answer, which carries Deckard's scans so a new source shows
//                         scanning at once.
//
// Configured from the environment: ES_URL, ES_USERNAME and ES_PASSWORD or ES_API_KEY,
// ES_INDEX (logs-arthur.discovery-*), PORT (7493), HOST (0.0.0.0); DECKARD_URL and
// DECKARD_CONTROL_TOKEN or DECKARD_CONTROL_TOKEN_FILE for scans; SOURCES_CONFIG and
// SOURCES_SECRETS for sources; ALLOWED_HOSTS.
//
// THERE IS NO LOGIN, so the viewer answers only a page loaded from this machine. Every
// request must name localhost, 127.0.0.1 or [::1] (or an ALLOWED_HOSTS name) as its Host,
// which keeps out a site that points its own name at 127.0.0.1. Every POST, the requests
// that do something, must also come from the viewer's own page: an Origin matching its
// Host, and a JSON body, which a page elsewhere can't send without CORS the viewer never
// grants.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  applyConfig,
  config,
  DeckardError,
  engineConfig,
  es,
  EsError,
  overview,
  requestScan,
  scans,
  sightings,
  sourceTypes,
  testSource,
} from "./lib.mjs";
import {
  addSource,
  buildSource,
  itemOf,
  ownSecretFiles,
  readSources,
  removeSource,
  replaceSource,
  SourcesError,
  SourcesFile,
} from "./sources.mjs";

const cfg = config();
const here = dirname(fileURLToPath(import.meta.url));

// The only files served, so no path from a request ever reaches the filesystem.
const STATIC = {
  "/": ["index.html", "text/html; charset=utf-8"],
  "/app.js": ["app.js", "text/javascript; charset=utf-8"],
  "/style.css": ["style.css", "text/css; charset=utf-8"],
  "/owl.svg": ["owl.svg", "image/svg+xml"],
};

const SECURITY_HEADERS = {
  "Content-Security-Policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

function send(res, status, body, type) {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", ...SECURITY_HEADERS });
  res.end(body);
}

const json = (res, status, value) => send(res, status, JSON.stringify(value), "application/json; charset=utf-8");

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

// The host name a request was sent to, without its port, or null if it has none.
function hostName(host) {
  if (!host) return null;
  const m = /^(\[[0-9a-f:.]+\]|[^:]+)(?::\d+)?$/i.exec(host.trim());
  return m ? m[1].toLowerCase() : null;
}

function hostAllowed(req) {
  const name = hostName(req.headers.host);
  return name != null && (LOCAL_HOSTS.has(name) || cfg.allowedHosts.includes(name));
}

// Sent by the viewer's own page: from its own origin, as JSON.
function fromOwnPage(req) {
  const origin = req.headers.origin;
  const own = [`http://${req.headers.host}`, `https://${req.headers.host}`];
  const type = (req.headers["content-type"] || "").split(";")[0].trim().toLowerCase();
  return own.includes(origin) && type === "application/json";
}

// A source with a service account key or a CA certificate in it is a few KB.
const MAX_BODY = 256 * 1024;

const sourcesFile = cfg.sourcesConfig ? new SourcesFile(cfg.sourcesConfig, cfg.sourcesSecrets) : null;

function needSources() {
  if (!sourcesFile) throw new SourcesError("The viewer isn't set up to change sources: it needs SOURCES_CONFIG", 503);
  return sourcesFile;
}

async function listSources() {
  const file = needSources();
  const [{ text, hash }, types, engine] = await Promise.all([file.read(), sourceTypes(cfg), engineConfig(cfg)]);
  return { hash, sources: readSources(text, types.secretKeys), source_types: types.types, deckard: engine };
}

// After discovery.yaml is written: have Deckard apply it now, so a source just added is
// already scanning when the page hears back. scans and deckard are null when Deckard
// can't be asked; it then applies the file within its next check.
async function applied(written) {
  const now = await applyConfig(cfg);
  return { ...written, scans: now?.scans ?? null, deckard: now?.config ?? null };
}

// add, update, remove and test, each from a POST body.
const SOURCE_ACTIONS = {
  async add(body) {
    const { secretKeys } = await sourceTypes(cfg);
    return needSources().update(body.base_hash, async (text) => {
      const built = buildSource(body.source, { secretKeys });
      await testSource(cfg, built.test, { validateOnly: true });
      return { text: addSource(text, built.item), files: built.files };
    });
  },
  async update(body) {
    const { secretKeys } = await sourceTypes(cfg);
    return needSources().update(body.base_hash, async (text) => {
      const existing = itemOf(text, body.name);
      const built = buildSource(body.source, { secretKeys, existing });
      await testSource(cfg, built.test, { validateOnly: true, keepSecretsFrom: body.name });
      return { text: replaceSource(text, body.name, built.item), files: built.files };
    });
  },
  async remove(body) {
    return needSources().update(body.base_hash, async (text) => {
      const removed = removeSource(text, body.name);
      return { text: removed.text, removeFiles: ownSecretFiles(removed.item) };
    });
  },
  async test(body) {
    const { secretKeys } = await sourceTypes(cfg);
    const existing = body.editing ? itemOf((await needSources().read()).text, body.editing) : null;
    const built = buildSource(body.source, { secretKeys, existing });
    return testSource(cfg, built.test, { configName: body.config_name, keepSecretsFrom: body.editing || undefined });
  },
};

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new DeckardError("the request is too large", 413);
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new DeckardError("the body must be JSON", 400);
  }
}

async function handle(req, res) {
  const url = new URL(req.url, "http://viewer");
  if (!hostAllowed(req)) {
    return json(res, 403, { error: "open the viewer as http://localhost:7493, or add this host name to ALLOWED_HOSTS" });
  }
  const action = /^\/api\/sources\/(add|update|remove|test)$/.exec(url.pathname)?.[1];
  if (action) {
    if (req.method !== "POST") return json(res, 405, { error: "POST only" });
    if (!fromOwnPage(req)) return json(res, 403, { error: "sources can be changed only from the viewer's own page" });
    const body = await readJson(req);
    if (!body || typeof body !== "object") return json(res, 400, { error: "the body must be a JSON object" });
    const out = await SOURCE_ACTIONS[action](body);
    return json(res, 200, action === "test" ? out : await applied(out));
  }
  if (url.pathname === "/api/scans/run") {
    if (req.method !== "POST") return json(res, 405, { error: "POST only" });
    if (!fromOwnPage(req)) return json(res, 403, { error: "scans can be asked for only from the viewer's own page" });
    return json(res, 202, await requestScan(cfg, await readJson(req)));
  }
  if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "GET only" });

  if (url.pathname in STATIC) {
    const [file, type] = STATIC[url.pathname];
    return send(res, 200, await readFile(join(here, "public", file)), type);
  }
  if (url.pathname === "/api/overview") return json(res, 200, await overview(cfg));
  if (url.pathname === "/api/sightings") {
    const sourceId = url.searchParams.get("source_id");
    const externalId = url.searchParams.get("external_id");
    if (!sourceId || !externalId || sourceId.length > 1024 || externalId.length > 4096) {
      return json(res, 400, { error: "source_id and external_id are required" });
    }
    return json(res, 200, await sightings(cfg, sourceId, externalId));
  }
  if (url.pathname === "/api/scans") return json(res, 200, await scans(cfg));
  if (url.pathname === "/api/sources") return json(res, 200, await listSources());
  if (url.pathname === "/api/health") {
    // A search the viewer's user may run, so a wrong password or role fails the check.
    await es(cfg, `/${encodeURIComponent(cfg.index)}/_count`, { query: { match_none: {} } });
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: "not found" });
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (err instanceof EsError || err instanceof DeckardError || err instanceof SourcesError) {
      // Logged too: the healthcheck discards the answer, so this is where a failing
      // viewer says why.
      console.error(`${new URL(req.url, "http://viewer").pathname}: ${err.message}`);
      return json(res, err.status, { error: err.message });
    }
    console.error(err);
    json(res, 500, { error: "the viewer failed; docker compose logs viewer says why" });
  });
});

server.listen(cfg.port, cfg.host, () => {
  console.log(`Deckard viewer on port ${cfg.port}, reading ${cfg.index} at ${cfg.url}`);
  if (cfg.deckardUrl) console.log(`Asking Deckard at ${cfg.deckardUrl} for scans`);
});

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.close(() => process.exit(0)));
