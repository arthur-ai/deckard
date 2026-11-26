// This machine's scan from the page: the folder the viewer shares with ./start.sh, and the
// server's route over it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ALIVE_MS, followRun, requestLocalScan, runnerState, shapeStatus } from "../localscan.mjs";
import { request, withServer } from "./server.mjs";

const folder = () => mkdtempSync(join(tmpdir(), "runner-"));
const beat = (dir, at = Date.now()) => {
  writeFileSync(join(dir, "heartbeat"), "");
  utimesSync(join(dir, "heartbeat"), at / 1000, at / 1000);
};
const status = (dir, s) => writeFileSync(join(dir, "status.json"), JSON.stringify(s));

test("runnerState() says whether start.sh is there, and what its last run did", async () => {
  assert.deepEqual(await runnerState(null), { available: false, alive: false, status: null, requested: null });
  const dir = folder();
  assert.deepEqual(await runnerState(dir), { available: true, alive: false, status: null, requested: null });

  const now = Date.now();
  beat(dir, now - ALIVE_MS - 1000);
  assert.equal((await runnerState(dir, now)).alive, false);
  beat(dir, now);
  assert.equal((await runnerState(dir, now)).alive, true);

  status(dir, { run: "start", state: "failed", host: "laptop", started_at: "a", finished_at: "b", message: "osquery is not installed", extra: 1 });
  assert.deepEqual((await runnerState(dir, now)).status,
    { run: "start", state: "failed", host: "laptop", started_at: "a", finished_at: "b", message: "osquery is not installed" });
  writeFileSync(join(dir, "status.json"), '{"run": "start", "sta');
  assert.equal((await runnerState(dir, now)).status, null);
});

test("shapeStatus() keeps only a run start.sh could have written", () => {
  assert.equal(shapeStatus({ run: "x", state: "exploded" }), null);
  assert.equal(shapeStatus({ run: "../x", state: "running" }), null);
  assert.equal(shapeStatus(null), null);
  assert.equal(shapeStatus({ run: "x", state: "running", host: 5 }).host, null);
  assert.equal(shapeStatus({ run: "x", state: "failed", message: "y".repeat(10000) }).message.length, 4000);
});

test("requestLocalScan() asks start.sh once, and only while it runs", async () => {
  await assert.rejects(requestLocalScan(null), (e) => e.status === 503);
  const dir = folder();
  await assert.rejects(requestLocalScan(dir), (e) => e.status === 409 && /start\.sh/.test(e.message));

  beat(dir);
  const first = await requestLocalScan(dir);
  assert.equal(first.started, true);
  assert.equal(readFileSync(join(dir, "request"), "utf8").trim(), first.run);
  // Asked again before start.sh takes it: the same run.
  assert.deepEqual(await requestLocalScan(dir), { run: first.run, started: false });

  // Taken and running: still the same run.
  rmSync(join(dir, "request"));
  status(dir, { run: first.run, state: "running" });
  assert.deepEqual(await requestLocalScan(dir), { run: first.run, started: false });

  // Ended: a new one.
  status(dir, { run: first.run, state: "succeeded" });
  const second = await requestLocalScan(dir);
  assert.equal(second.started, true);
  assert.notEqual(second.run, first.run);
});

// Steps followRun with a fake clock: each sleep runs step(i) first, as start.sh would.
async function follow(dir, run, step, opts = {}) {
  let now = Date.now();
  let i = 0;
  let asked = 0;
  let out = null;
  await followRun(dir, run, {
    askDeckard: async () => { asked += 1; if (opts.deckardFails) throw new Error("Deckard can't be reached"); },
    done: (x) => { out = x; },
    clock: () => now,
    sleep: async (ms) => { now += ms; beat(dir, now); step(i++); },
    timeoutMs: opts.timeoutMs ?? 60_000,
  });
  return { ...out, asked };
}

test("followRun() asks Deckard to read a scan that succeeded, and not one that failed", async () => {
  const dir = folder();
  beat(dir);
  writeFileSync(join(dir, "request"), "r1\n");
  const ok = await follow(dir, "r1", (i) => {
    if (i === 0) { rmSync(join(dir, "request")); status(dir, { run: "r1", state: "running" }); }
    if (i === 2) status(dir, { run: "r1", state: "succeeded" });
  });
  assert.deepEqual([ok.scanned, ok.error, ok.asked], [true, null, 1]);

  const failed = await follow(dir, "r2", (i) => { if (i === 0) status(dir, { run: "r2", state: "failed", message: "no" }); });
  assert.deepEqual([failed.scanned, failed.error, failed.asked], [false, null, 0]);

  const down = await follow(dir, "r3", () => status(dir, { run: "r3", state: "succeeded" }), { deckardFails: true });
  assert.deepEqual([down.scanned, down.error], [false, "Deckard can't be reached"]);
});

test("followRun() gives up when start.sh stops, or the scan never ends", async () => {
  const dir = folder();
  beat(dir);
  let now = Date.now();
  let out = null;
  await followRun(dir, "r1", {
    askDeckard: async () => assert.fail("nothing to read"),
    done: (x) => { out = x; },
    clock: () => now,
    // No heartbeat: start.sh was stopped.
    sleep: async (ms) => { now += ms + ALIVE_MS; },
  });
  assert.match(out.error, /stopped/);

  status(dir, { run: "r2", state: "running" });
  const stuck = await follow(dir, "r2", () => {}, { timeoutMs: 5_000 });
  assert.match(stuck.error, /didn't finish/);
});

test("the server scans this machine only for its own page, then has Deckard read it", async () => {
  const dir = folder();
  beat(dir);
  const answer = (path) => ({
    "/scans": { scans: [
      { source_id: "m", source_name: "this-machine", vendor: "local", config_name: "inventory", status: "scheduled" },
      { source_id: "w", source_name: "wiz-prod", vendor: "wiz", config_name: "default", status: "scheduled" },
    ] },
    "/scans/run": { scans: [] },
  })[path];
  await withServer(async (base, asked) => {
    const host = new URL(base).host;
    const good = { Host: host, Origin: `http://${host}`, "Content-Type": "application/json" };
    const path = "/api/local-scan";

    for (const headers of [{ ...good, Origin: "http://evil.example" }, { ...good, "Content-Type": "text/plain" }]) {
      assert.equal((await request(base, { path, headers, body: "{}" })).status, 403);
    }
    const idle = JSON.parse((await request(base, { path, method: "GET", headers: { Host: host } })).text);
    assert.deepEqual([idle.available, idle.alive, idle.handoff], [true, true, null]);

    const res = await request(base, { path, headers: good, body: "{}" });
    assert.equal(res.status, 202, res.text);
    const { asked: run } = JSON.parse(res.text);
    assert.equal(readFileSync(join(dir, "request"), "utf8").trim(), run);

    // start.sh takes the request and scans.
    rmSync(join(dir, "request"));
    status(dir, { run, state: "succeeded" });
    let after;
    for (let i = 0; i < 40; i++) {
      beat(dir);
      after = JSON.parse((await request(base, { path, method: "GET", headers: { Host: host } })).text);
      if (after.handoff) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    assert.deepEqual([after.handoff?.run, after.handoff?.scanned, after.handoff?.error], [run, true, null]);
    // Only the local source, and only once.
    const runs = asked.filter((a) => a.path === "/scans/run").map((a) => JSON.parse(a.body));
    assert.deepEqual(runs, [{ source_id: "m", config_name: "inventory" }]);
  }, { env: { LOCAL_SCAN_RUNNER: dir }, answer });
});

test("without a runner folder, the route says so", async () => {
  await withServer(async (base) => {
    const host = new URL(base).host;
    const good = { Host: host, Origin: `http://${host}`, "Content-Type": "application/json" };
    const get = JSON.parse((await request(base, { path: "/api/local-scan", method: "GET", headers: { Host: host } })).text);
    assert.equal(get.available, false);
    const post = await request(base, { path: "/api/local-scan", headers: good, body: "{}" });
    assert.equal(post.status, 503);
    assert.match(post.text, /LOCAL_SCAN_RUNNER/);
  });
});
