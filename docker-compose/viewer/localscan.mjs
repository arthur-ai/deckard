// This machine's scan, from the viewer. The scan runs on the host, where osquery and the
// files it reads are; the viewer is a container that can't. So ./start.sh stays running
// beside the viewer and runs it, and the two talk through a folder they both mount
// (docker-compose/runner/, LOCAL_SCAN_RUNNER here):
//
//   heartbeat     touched by start.sh every 2 s while it runs; older than ALIVE_MS, and
//                 no one is there to scan
//   status.json   start.sh's latest run: {run, state, host, started_at, finished_at,
//                 message}, state running, succeeded or failed
//   request       written by the viewer to ask for a run: the run's id and nothing else.
//                 start.sh takes it, removes it, and runs scan-local.sh, the only thing
//                 it ever runs, so a request can at most cause a scan.
//
// A run the viewer asked for ends with the viewer asking Deckard to scan its local
// sources, which re-read the folder the run wrote; see followRun. A run start.sh made
// itself, at startup, needs no asking: start.sh starts Deckard after it, and Deckard
// scans when it starts.

import { randomBytes } from "node:crypto";
import { readFile, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

export const ALIVE_MS = 10_000;
const STATES = new Set(["running", "succeeded", "failed"]);
const RUN_ID = /^[A-Za-z0-9-]{1,64}$/;
const MESSAGE_MAX = 4000;

export class LocalScanError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

const str = (v, max = 200) => (typeof v === "string" && v.length <= max ? v : null);

// status.json as the page gets it: known fields of the expected types, nothing else.
export function shapeStatus(raw) {
  if (!raw || typeof raw !== "object" || !STATES.has(raw.state) || !RUN_ID.test(raw.run ?? "")) return null;
  return {
    run: raw.run,
    state: raw.state,
    host: str(raw.host),
    started_at: str(raw.started_at),
    finished_at: str(raw.finished_at),
    message: typeof raw.message === "string" ? raw.message.slice(-MESSAGE_MAX) : null,
  };
}

async function readText(path) {
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

// Where this machine's scan stands: {available, alive, status, requested}. available is
// false when the viewer has no runner folder, as with a viewer started some other way
// than ./start.sh's Compose file.
export async function runnerState(dir, now = Date.now()) {
  if (!dir) return { available: false, alive: false, status: null, requested: null };
  let alive = false;
  try {
    alive = now - (await stat(join(dir, "heartbeat"))).mtimeMs < ALIVE_MS;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  let status = null;
  try {
    status = shapeStatus(JSON.parse((await readText(join(dir, "status.json"))) ?? "null"));
  } catch {
    // Half-written, or not JSON: as if there were none. start.sh writes it whole.
  }
  const requested = ((await readText(join(dir, "request"))) ?? "").trim();
  return { available: true, alive, status, requested: RUN_ID.test(requested) ? requested : null };
}

// Asks start.sh for a run, and answers its id. A run already asked for or running is
// answered as is, so two clicks scan once.
export async function requestLocalScan(dir, now = Date.now()) {
  if (!dir) throw new LocalScanError("The viewer isn't set up to scan this machine: it needs LOCAL_SCAN_RUNNER", 503);
  const at = await runnerState(dir, now);
  if (!at.alive) {
    throw new LocalScanError("./start.sh isn't running, and it is what scans this machine. Run ./start.sh again", 409);
  }
  if (at.requested) return { run: at.requested, started: false };
  if (at.status?.state === "running") return { run: at.status.run, started: false };
  const run = `v${now.toString(36)}-${randomBytes(4).toString("hex")}`;
  const tmp = join(dir, ".request.tmp");
  try {
    await writeFile(tmp, `${run}\n`);
    await rename(tmp, join(dir, "request"));
  } catch (err) {
    throw new LocalScanError(`The viewer can't write to its runner folder (${err.code ?? err.message})`, 503);
  }
  return { run, started: true };
}

// Waits for run to end, then has Deckard scan every local source, which re-reads the
// folder the run wrote. Never throws: what happened is handed to done({run, at, error}).
// Gives up when the run doesn't end within timeoutMs, or start.sh stops first.
export async function followRun(dir, run, { askDeckard, done, intervalMs = 500, timeoutMs = 15 * 60_000, sleep, clock = Date.now }) {
  const wait = sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = clock() + timeoutMs;
  try {
    while (clock() < deadline) {
      const at = await runnerState(dir, clock());
      if (at.status?.run === run && at.status.state !== "running") {
        if (at.status.state === "failed") return done({ run, at: new Date(clock()).toISOString(), error: null, scanned: false });
        await askDeckard();
        return done({ run, at: new Date(clock()).toISOString(), error: null, scanned: true });
      }
      if (!at.alive) {
        return done({ run, at: new Date(clock()).toISOString(), error: "./start.sh stopped before the scan finished", scanned: false });
      }
      await wait(intervalMs);
    }
    done({ run, at: new Date(clock()).toISOString(), error: `the scan didn't finish within ${Math.round(timeoutMs / 60_000)} minutes`, scanned: false });
  } catch (err) {
    done({ run, at: new Date(clock()).toISOString(), error: err.message, scanned: false });
  }
}
