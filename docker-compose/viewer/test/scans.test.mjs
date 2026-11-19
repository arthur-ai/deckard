// Scan now: the viewer's client for Deckard's control API, and the server's guards on the
// one request that does something.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { config, deckard, DeckardError, requestScan, scans } from "../lib.mjs";

const TOKEN = "t".repeat(64);

function fakeFetch(status, body) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  fn.calls = calls;
  return fn;
}

test("deckard() sends the token, from the environment or its file", async () => {
  // TOKEN and a newline: the tests run on a read-only filesystem in CI, so it's committed.
  const file = fileURLToPath(new URL("control-token", import.meta.url));
  for (const env of [{ DECKARD_CONTROL_TOKEN: TOKEN }, { DECKARD_CONTROL_TOKEN_FILE: file }]) {
    const f = fakeFetch(200, { scans: [] });
    await deckard(config({ DECKARD_URL: "http://deckard:7494/", ...env }), "GET", "/scans", null, f);
    assert.equal(f.calls[0].url, "http://deckard:7494/scans");
    assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  }
});

test("deckard() says what went wrong", async () => {
  const cfg = config({ DECKARD_URL: "http://deckard:7494", DECKARD_CONTROL_TOKEN: TOKEN });
  const fails = async (f, path, re) =>
    assert.rejects(deckard(cfg, "POST", path, {}, f), (e) => e instanceof DeckardError && re.test(e.message));
  await fails(fakeFetch(401, { error: "no" }), "/scans", /refused the viewer's control token/);
  await fails(fakeFetch(404, { error: "no" }), "/scans/run", /no scan configured/);
  await fails(fakeFetch(500, "<html>"), "/scans", /answered 500/);
  await fails(async () => { throw Object.assign(new Error("x"), { cause: { code: "ENOTFOUND" } }); }, "/scans", /can't be reached \(ENOTFOUND\)/);
  const none = config({ DECKARD_URL: "http://deckard:7494", DECKARD_CONTROL_TOKEN_FILE: "/no/such/file" });
  await assert.rejects(deckard(none, "GET", "/scans"), /isn't set up/);
});

test("scans() turns a Deckard that can't be asked into no buttons, not an error", async () => {
  const cfg = config({});
  const down = await scans(cfg, async () => { throw new DeckardError("can't be reached", 502); });
  assert.deepEqual(down, { available: false, reason: "can't be reached", scans: [] });
  const up = await scans(cfg, async () => ({ scans: [{ source_id: "s", status: "running" }] }));
  assert.equal(up.available, true);
  assert.equal(up.scans[0].status, "running");
});

test("requestScan() passes on only a source and config", async () => {
  const sent = [];
  const call = async (cfg, method, path, body) => { sent.push([method, path, body]); return { scans: [] }; };
  await requestScan(config({}), { source_id: "s", config_name: "c", extra: "x" }, call);
  await requestScan(config({}), { source_id: "s" }, call);
  assert.deepEqual(sent, [["POST", "/scans/run", { source_id: "s", config_name: "c" }], ["POST", "/scans/run", { source_id: "s" }]]);
  for (const bad of [null, {}, { source_id: "" }, { source_id: 1 }, { source_id: "x".repeat(201) }, { source_id: "s", config_name: "" }]) {
    await assert.rejects(requestScan(config({}), bad, call), (e) => e.status === 400);
  }
  assert.equal(sent.length, 2);
});

// The real server, with a fake Deckard behind it.
async function withServer(fn) {
  const asked = [];
  const fake = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      asked.push({ path: req.url, auth: req.headers.authorization, body });
      res.writeHead(req.url === "/scans/run" ? 202 : 200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ scans: [{ source_id: "s", config_name: "c", status: "waiting" }] }));
    });
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { PORT: String(port), HOST: "127.0.0.1", ES_URL: "http://127.0.0.1:9", DECKARD_URL: `http://127.0.0.1:${fake.address().port}`, DECKARD_CONTROL_TOKEN: TOKEN },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((r) => child.stdout.once("data", r));
  try {
    await fn(`http://127.0.0.1:${port}`, asked);
  } finally {
    child.kill();
    fake.close();
  }
}

// node's fetch won't set Host or Origin, so the guards are tested with node:http.
function request(base, { method = "POST", path = "/api/scans/run", headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(new URL(path, base), { method, headers }, (res) => {
      let text = "";
      res.on("data", (c) => { text += c; });
      res.on("end", () => resolve({ status: res.statusCode, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("the server asks Deckard only for a request from its own page", async () => {
  await withServer(async (base, asked) => {
    const host = new URL(base).host;
    const good = { Host: host, Origin: `http://${host}`, "Content-Type": "application/json" };
    const body = JSON.stringify({ source_id: "s", config_name: "c" });

    const ok = await request(base, { headers: good, body });
    assert.equal(ok.status, 202, ok.text);
    assert.equal(JSON.parse(ok.text).scans[0].status, "waiting");
    assert.deepEqual(asked.map((a) => [a.path, a.auth, JSON.parse(a.body)]), [["/scans/run", `Bearer ${TOKEN}`, { source_id: "s", config_name: "c" }]]);

    const refused = [
      { ...good, Origin: "http://evil.example" }, // another site
      { ...good, Origin: undefined }, // no Origin at all
      { ...good, "Content-Type": "text/plain" }, // a form or no-cors fetch
      { ...good, Host: "evil.example:7493", Origin: "http://evil.example:7493" }, // DNS rebinding
    ];
    for (const headers of refused) {
      for (const k of Object.keys(headers)) if (headers[k] === undefined) delete headers[k];
      const res = await request(base, { headers, body });
      assert.equal(res.status, 403, `${JSON.stringify(headers)}: ${res.text}`);
    }
    assert.equal((await request(base, { method: "GET", headers: good })).status, 405);
    assert.equal((await request(base, { headers: good, body: "x".repeat(5000) })).status, 413);
    assert.equal((await request(base, { headers: good, body: "{" })).status, 400);
    // Reads need a local Host too, so a rebinding site can't read the agents either.
    assert.equal((await request(base, { method: "GET", path: "/api/scans", headers: { Host: "evil.example" } })).status, 403);
    assert.equal((await request(base, { method: "GET", path: "/api/scans", headers: { Host: host } })).status, 200);
    assert.equal(asked.filter((a) => a.path === "/scans/run").length, 1);
  });
});
