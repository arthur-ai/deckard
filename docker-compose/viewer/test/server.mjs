// The real server.mjs, run as a child with a fake Deckard behind it, and a client that can
// set the Host and Origin headers node's fetch won't.

import { spawn } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";

export const TOKEN = "t".repeat(64);
const waiting = () => ({ scans: [{ source_id: "s", config_name: "c", status: "waiting" }] });

// The real server, with a fake Deckard behind it that answers each path with answer(path).
export async function withServer(fn, { env = {}, answer = waiting } = {}) {
  const asked = [];
  const fake = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      asked.push({ path: req.url, auth: req.headers.authorization, body });
      const out = answer(req.url);
      res.writeHead(out ? (req.url === "/scans/run" ? 202 : 200) : 404, { "Content-Type": "application/json" });
      res.end(JSON.stringify(out ?? { error: "not found" }));
    });
  });
  await new Promise((r) => fake.listen(0, "127.0.0.1", r));
  const port = 20000 + Math.floor(Math.random() * 20000);
  const child = spawn(process.execPath, ["server.mjs"], {
    cwd: new URL("..", import.meta.url).pathname,
    env: { PORT: String(port), HOST: "127.0.0.1", ES_URL: "http://127.0.0.1:9", DECKARD_URL: `http://127.0.0.1:${fake.address().port}`, DECKARD_CONTROL_TOKEN: TOKEN, ...env },
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
export function request(base, { method = "POST", path = "/api/scans/run", headers = {}, body } = {}) {
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

