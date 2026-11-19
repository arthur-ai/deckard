// Deckard's viewer: a page of the AI agents Deckard found and how its scans went, read from
// the Elasticsearch it sends to. No dependencies beyond Node itself.
//
//   GET /                 the page
//   GET /api/overview     every agent and every source, shaped for the page
//   GET /api/sightings    the scans one agent was reported in (?source_id=&external_id=)
//   GET /api/health       200 once Elasticsearch answers the viewer's user
//   GET /api/scans        where each of Deckard's scans stands, from Deckard's control API
//   POST /api/scans/run   ask Deckard to scan one source now ({source_id, config_name})
//
// Configured from the environment: ES_URL, ES_USERNAME and ES_PASSWORD or ES_API_KEY,
// ES_INDEX (logs-arthur.discovery-*), PORT (7493), HOST (0.0.0.0); DECKARD_URL and
// DECKARD_CONTROL_TOKEN or DECKARD_CONTROL_TOKEN_FILE for scans; ALLOWED_HOSTS.
//
// THERE IS NO LOGIN, so the viewer answers only a page loaded from this machine. Every
// request must name localhost, 127.0.0.1 or [::1] (or an ALLOWED_HOSTS name) as its Host,
// which keeps out a site that points its own name at 127.0.0.1. The one request that does
// something, POST /api/scans/run, must also come from the viewer's own page: an Origin
// matching its Host, and a JSON body, which a page elsewhere can't send without CORS the
// viewer never grants.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config, DeckardError, es, EsError, overview, requestScan, scans, sightings } from "./lib.mjs";

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

const MAX_BODY = 4096;

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
  if (url.pathname === "/api/health") {
    // A search the viewer's user may run, so a wrong password or role fails the check.
    await es(cfg, `/${encodeURIComponent(cfg.index)}/_count`, { query: { match_none: {} } });
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: "not found" });
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (err instanceof EsError || err instanceof DeckardError) return json(res, err.status, { error: err.message });
    console.error(err);
    json(res, 500, { error: "the viewer failed; docker compose logs viewer says why" });
  });
});

server.listen(cfg.port, cfg.host, () => {
  console.log(`Deckard viewer on port ${cfg.port}, reading ${cfg.index} at ${cfg.url}`);
  if (cfg.deckardUrl) console.log(`Asking Deckard at ${cfg.deckardUrl} for scans`);
});

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.close(() => process.exit(0)));
