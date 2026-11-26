// Scan now: the viewer's client for Deckard's control API, and the server's guards on the
// one request that does something.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyConfig, config, deckard, DeckardError, requestScan, scans } from "../lib.mjs";

import { request, TOKEN, withServer } from "./server.mjs";

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

test("applyConfig() asks Deckard to apply the file, and answers null if it can't", async () => {
  const cfg = config({});
  const sent = [];
  const now = await applyConfig(cfg, async (c, method, path) => {
    sent.push([method, path]);
    return { config: { error: null }, scans: [{ source_name: "new", status: "running" }] };
  });
  assert.deepEqual(sent, [["POST", "/config/reload"]]);
  assert.equal(now.scans[0].status, "running");
  assert.equal(await applyConfig(cfg, async () => { throw new DeckardError("Deckard answered 404", 502); }), null);
});

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
    assert.equal((await request(base, { headers: good, body: "x".repeat(300 * 1024) })).status, 413);
    assert.equal((await request(base, { headers: good, body: "{" })).status, 400);
    // Reads need a local Host too, so a rebinding site can't read the agents either.
    assert.equal((await request(base, { method: "GET", path: "/api/scans", headers: { Host: "evil.example" } })).status, 403);
    assert.equal((await request(base, { method: "GET", path: "/api/scans", headers: { Host: host } })).status, 200);
    assert.equal(asked.filter((a) => a.path === "/scans/run").length, 1);
    // Changing sources is guarded the same way.
    for (const action of ["add", "update", "remove", "test"]) {
      const path = `/api/sources/${action}`;
      assert.equal((await request(base, { path, headers: { ...good, Origin: "http://evil.example" }, body: "{}" })).status, 403);
      assert.equal((await request(base, { path, headers: { ...good, "Content-Type": "text/plain" }, body: "{}" })).status, 403);
      assert.equal((await request(base, { path, method: "GET", headers: good })).status, 405);
    }
    // And without SOURCES_CONFIG, says it isn't set up.
    const off = await request(base, { path: "/api/sources/remove", headers: good, body: '{"name":"x"}' });
    assert.equal(off.status, 503);
    assert.match(off.text, /SOURCES_CONFIG/);
  });
});

test("adding a source has Deckard apply it at once, and answers with it scanning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "viewer-"));
  const file = join(dir, "discovery.yaml");
  writeFileSync(file, readFileSync(new URL("discovery.fixture.yaml", import.meta.url)));
  mkdirSync(join(dir, "secrets"));
  const answer = (path) => ({
    "/source-types": { source_types: [{ vendor: "wiz", fields: [{ name: "client_secret", is_sensitive: true }] }] },
    "/sources/test": { ok: true },
    "/config": { error: null },
    "/config/reload": { config: { error: null, restart_required: [] }, scans: [{ source_id: "w", source_name: "wiz-prod", config_name: "default", status: "running" }] },
  })[path];
  await withServer(async (base, asked) => {
    const host = new URL(base).host;
    const headers = { Host: host, Origin: `http://${host}`, "Content-Type": "application/json" };
    const { hash } = JSON.parse((await request(base, { method: "GET", path: "/api/sources", headers })).text);
    const source = {
      name: "wiz-prod",
      vendor: "wiz",
      fields: { client_id: "abc", client_secret: "s3cret" },
      configs: [{ name: "default", query: "", query_language: "none", lookback_window_seconds: 86400 }],
    };
    const res = await request(base, { path: "/api/sources/add", headers, body: JSON.stringify({ base_hash: hash, source }) });

    assert.equal(res.status, 200, res.text);
    const out = JSON.parse(res.text);
    assert.deepEqual(out.scans.map((x) => [x.source_name, x.status]), [["wiz-prod", "running"]]);
    assert.equal(out.deckard.error, null);
    assert.match(readFileSync(file, "utf8"), /- name: wiz-prod/);
    // Applied after the file was written, and only then.
    const paths = asked.map((a) => a.path);
    assert.equal(paths.at(-1), "/config/reload");
    assert.equal(paths.filter((p) => p === "/config/reload").length, 1);
  }, { env: { SOURCES_CONFIG: file, SOURCES_SECRETS: join(dir, "secrets") }, answer });
});

test("a Deckard without /config/reload still saves the source, and answers null scans", async () => {
  const dir = mkdtempSync(join(tmpdir(), "viewer-"));
  const file = join(dir, "discovery.yaml");
  writeFileSync(file, readFileSync(new URL("discovery.fixture.yaml", import.meta.url)));
  mkdirSync(join(dir, "secrets"));
  const answer = (path) => ({
    "/source-types": { source_types: [{ vendor: "wiz", fields: [] }] },
    "/sources/test": { ok: true },
    "/config": { error: null },
  })[path];
  await withServer(async (base, asked) => {
    const host = new URL(base).host;
    const headers = { Host: host, Origin: `http://${host}`, "Content-Type": "application/json" };
    const { hash } = JSON.parse((await request(base, { method: "GET", path: "/api/sources", headers })).text);
    const source = { name: "wiz-prod", vendor: "wiz", fields: { client_id: "abc" }, configs: [{ name: "default" }] };
    const res = await request(base, { path: "/api/sources/add", headers, body: JSON.stringify({ base_hash: hash, source }) });

    assert.equal(res.status, 200, res.text);
    const out = JSON.parse(res.text);
    assert.equal(out.scans, null);
    assert.equal(out.deckard, null);
    assert.ok(out.hash);
    assert.match(readFileSync(file, "utf8"), /- name: wiz-prod/);
    assert.equal(asked.at(-1).path, "/config/reload");
  }, { env: { SOURCES_CONFIG: file, SOURCES_SECRETS: join(dir, "secrets") }, answer });
});
