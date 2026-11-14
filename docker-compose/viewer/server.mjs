// Deckard's viewer: a page of the AI agents Deckard found and how its scans went, read from
// the Elasticsearch it sends to. No dependencies beyond Node itself.
//
//   GET /                 the page
//   GET /api/overview     every agent and every source, shaped for the page
//   GET /api/sightings    the scans one agent was reported in (?source_id=&external_id=)
//   GET /api/health       200 once Elasticsearch answers the viewer's user
//
// Configured from the environment: ES_URL, ES_USERNAME and ES_PASSWORD or ES_API_KEY,
// ES_INDEX (logs-arthur.discovery-*), PORT (7493), HOST (0.0.0.0).

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config, es, EsError, overview, sightings } from "./lib.mjs";

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

async function handle(req, res) {
  const url = new URL(req.url, "http://viewer");
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
  if (url.pathname === "/api/health") {
    // A search the viewer's user may run, so a wrong password or role fails the check.
    await es(cfg, `/${encodeURIComponent(cfg.index)}/_count`, { query: { match_none: {} } });
    return json(res, 200, { ok: true });
  }
  return json(res, 404, { error: "not found" });
}

const server = createServer((req, res) => {
  handle(req, res).catch((err) => {
    if (err instanceof EsError) return json(res, err.status, { error: err.message });
    console.error(err);
    json(res, 500, { error: "the viewer failed; docker compose logs viewer says why" });
  });
});

server.listen(cfg.port, cfg.host, () => {
  console.log(`Deckard viewer on port ${cfg.port}, reading ${cfg.index} at ${cfg.url}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => server.close(() => process.exit(0)));
