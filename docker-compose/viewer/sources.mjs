// Adding, editing and removing the sources in Deckard's discovery.yaml.
//
// THE FILE STAYS YOURS. The viewer finds a source's text in discovery.yaml and changes
// only that: every other line, comment and blank stays as it was, byte for byte. An
// edited source is written out afresh, so comments inside it are lost; an added one goes
// after the last source. Deckard watches the file and applies a source change within
// seconds, without a restart.
//
// SECRETS GO IN FILES, NEVER IN discovery.yaml. A secret typed into the form is written to
// secrets/<source>.<field>, readable by its owner and Deckard's group only, and referenced as {file: secrets/<source>.<field>}, which Deckard
// reads without interpolating. A secret left blank when editing keeps what the file has,
// whatever that is (${NAME}, {file: ...} or a value), and the viewer never sends a stored
// secret back to the page.
//
// NOTHING TYPED BECOMES A REFERENCE. Deckard reads ${NAME} in a config value as an
// environment variable, so a value containing "${" is refused: otherwise a source's URL
// field could be pointed at a host and its token field at ${ELASTIC_PASSWORD}. A
// reference the file already has, sent back unchanged, is kept as it is.
//
// A TEST OF AN EDITED SOURCE ASKS DECKARD FOR WHAT THE PAGE DOESN'T HAVE. A secret left
// blank, a field read from a file or an environment variable: the viewer can't send their
// values, so it sends the field as null (a secret, blank) and names the source as
// keep_secrets_from, and Deckard fills them from the source it has loaded. Deckard
// refuses to send a kept secret somewhere new: change a source's URL, CA or TLS check and
// its secret has to be typed again.

import { createHash } from "node:crypto";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Document, isMap, isSeq, parseDocument } from "./vendor/yaml.mjs";

export class SourcesError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

// A source's name is its identity: Deckard mints its source.id from it, and the viewer
// names its secret files after it.
export const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,62}$/i;
const MAX_VALUE = 64 * 1024;

export const hashOf = (text) => createHash("sha256").update(text).digest("hex");

const fileRef = (v) => v && typeof v === "object" && !Array.isArray(v) && typeof v.file === "string" && Object.keys(v).length === 1;
const envRef = (v) => typeof v === "string" && /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(v);

function parse(text) {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new SourcesError(`discovery.yaml isn't valid YAML: ${doc.errors[0].message}`, 409);
  const seq = doc.get("sources", true);
  if (!isSeq(seq) || seq.flow) {
    throw new SourcesError("discovery.yaml has no sources: list the viewer can edit; edit it by hand", 409);
  }
  return { doc, seq };
}

// The sources in text, as the page shows them: no secret's value, ever.
// secretKeys(vendor) is the set of that vendor's secret field names.
export function readSources(text, secretKeys) {
  const { seq } = parse(text);
  return seq.items.map((item) => {
    const raw = isMap(item) ? item.toJSON() : {};
    const secret = secretKeys(raw.vendor) ?? new Set();
    return {
      name: String(raw.name ?? ""),
      vendor: String(raw.vendor ?? ""),
      fields: (Array.isArray(raw.fields) ? raw.fields : []).map((f) => {
        const ref = fileRef(f?.value) ? "file" : envRef(f?.value) ? "env" : null;
        if (secret.has(f?.key)) return { key: f.key, secret: true, set: f.value != null && f.value !== "", ref };
        return { key: f?.key, secret: false, ref, value: fileRef(f?.value) ? null : f?.value == null ? "" : String(f.value), file: fileRef(f?.value) ? f.value.file : undefined };
      }),
      configs: (Array.isArray(raw.configs) ? raw.configs : []).map((c) => ({
        name: c?.name,
        query: fileRef(c?.query) ? null : c?.query ?? "",
        query_file: fileRef(c?.query) ? c.query.file : undefined,
        query_language: c?.query_language ?? "none",
        lookback_window_seconds: c?.lookback_window_seconds ?? 86400,
      })),
    };
  });
}

function findItem(seq, name) {
  const index = seq.items.findIndex((item) => isMap(item) && item.get("name") === name);
  if (index < 0) throw new SourcesError(`discovery.yaml has no source named ${name}`, 404);
  return { index, item: seq.items[index] };
}

// The text span of seq item `item`: from the start of its "- " line to the end of its last
// line, so replacing it leaves the lines around it as they were.
function span(text, item) {
  const lineStart = text.lastIndexOf("\n", item.range[0] - 1) + 1;
  const dash = text.indexOf("-", lineStart);
  let end = item.range[2];
  if (end > 0 && text[end - 1] !== "\n") {
    const nl = text.indexOf("\n", end);
    end = nl < 0 ? text.length : nl + 1;
  }
  return { start: lineStart, end, indent: dash - lineStart };
}

// A source as the YAML of one sources: item, indented to sit at column `indent`.
function render(source, indent) {
  const doc = new Document([source]);
  const fields = doc.getIn([0, "fields"], true);
  for (const field of fields?.items ?? []) field.flow = true;
  const text = doc.toString({ flowCollectionPadding: false, lineWidth: 0 });
  const pad = " ".repeat(indent);
  return text.replace(/\n$/, "").split("\n").map((line) => (line ? pad + line : line)).join("\n") + "\n";
}

// The sources: item named `name`, as plain data with its references as written.
export function itemOf(text, name) {
  const { seq } = parse(text);
  return findItem(seq, name).item.toJSON();
}

export function addSource(text, source) {
  const { seq } = parse(text);
  if (seq.items.some((item) => isMap(item) && item.get("name") === source.name)) {
    throw new SourcesError(`A source named ${source.name} already exists`, 409);
  }
  if (!seq.items.length) throw new SourcesError("discovery.yaml's sources: list is empty; add the first source by hand", 409);
  const last = span(text, seq.items[seq.items.length - 1]);
  const first = span(text, seq.items[0]);
  return text.slice(0, last.end) + "\n" + render(source, first.indent) + text.slice(last.end);
}

export function replaceSource(text, name, source) {
  const { seq } = parse(text);
  const { item } = findItem(seq, name);
  const s = span(text, item);
  return text.slice(0, s.start) + render(source, s.indent) + text.slice(s.end);
}

export function removeSource(text, name) {
  const { seq } = parse(text);
  const { item } = findItem(seq, name);
  if (seq.items.length === 1) throw new SourcesError("Deckard needs at least one source; add another before removing this one", 409);
  const s = span(text, item);
  // The comment lines right above it describe it, so they go with it.
  let start = s.start;
  for (;;) {
    const prevEnd = start - 1;
    if (prevEnd <= 0) break;
    const prevStart = text.lastIndexOf("\n", prevEnd - 1) + 1;
    const line = text.slice(prevStart, prevEnd);
    if (!/^\s*#/.test(line) || line.search(/\S/) !== s.indent) break;
    start = prevStart;
  }
  // And one blank line, so the sources around it stay spaced as they were.
  let end = s.end;
  if (text.slice(end).startsWith("\n")) end += 1;
  else if (start > 1 && text.slice(start - 2, start) === "\n\n") start -= 1;
  return { text: text.slice(0, start) + text.slice(end), item: item.toJSON() };
}

// Checks a form's source and turns it into a sources: item, writing nothing: returns the
// item, the secret files to write, the source as the engine tests it (values, not
// references), and keeps: whether that test needs values from the configured source.
// `existing` is the item it replaces, if any.
export function buildSource(form, { secretKeys, existing = null }) {
  if (!form || typeof form !== "object") throw new SourcesError("The source must be an object");
  const name = form.name;
  if (typeof name !== "string" || !NAME_RE.test(name)) {
    throw new SourcesError("A source's name is letters, digits, dots, dashes and underscores, starting with a letter or digit");
  }
  if (typeof form.vendor !== "string" || !form.vendor) throw new SourcesError("Pick what kind of source this is");
  if (existing && (existing.name !== name || existing.vendor !== form.vendor)) {
    throw new SourcesError("A source's name and kind can't change: Deckard identifies it by them. Add a new source instead");
  }
  const secret = secretKeys(form.vendor);
  if (!secret) throw new SourcesError(`Deckard can't scan ${form.vendor} sources`);
  const given = form.fields && typeof form.fields === "object" ? form.fields : {};
  const before = new Map((existing?.fields ?? []).map((f) => [f.key, f.value]));

  const fields = [];
  const files = [];
  const testFields = [];
  let keeps = false;
  const keep = (key) => {
    testFields.push({ key, value: null });
    keeps = true;
  };
  const keys = [...new Set([...Object.keys(given), ...before.keys()])];
  for (const key of keys) {
    if (typeof key !== "string" || !/^[a-z0-9_]{1,64}$/i.test(key)) throw new SourcesError(`${key} isn't a field name`);
    const value = given[key];
    if (value != null && (typeof value !== "string" || value.length > MAX_VALUE)) throw new SourcesError(`${key} must be text`);
    const typed = value != null && value.trim() !== "";
    if (secret.has(key)) {
      if (typed) {
        const path = `secrets/${name}.${key}`;
        files.push({ path, content: value });
        fields.push({ key, value: { file: path } });
        testFields.push({ key, value });
      } else if (before.has(key) && before.get(key) != null && before.get(key) !== "") {
        fields.push({ key, value: before.get(key) });
        keeps = true;
      }
      continue;
    }
    if (typed && value.includes("${")) {
      // The reference the file has, as the page was shown it: kept, not typed.
      if (envRef(before.get(key)) && value.trim() === String(before.get(key)).trim()) {
        fields.push({ key, value: before.get(key) });
        keep(key);
        continue;
      }
      throw new SourcesError(`${key}: Deckard would read "\${" as an environment variable; remove it`);
    }
    if (typed) {
      fields.push({ key, value: value.trim() });
      testFields.push({ key, value: value.trim() });
    } else if (value == null && before.has(key)) {
      // Not in the form at all, or read from a file: kept as it is.
      fields.push({ key, value: before.get(key) });
      if (fileRef(before.get(key)) || envRef(before.get(key))) keep(key);
      else testFields.push({ key, value: before.get(key) });
    }
  }

  const configs = (Array.isArray(form.configs) && form.configs.length ? form.configs : [{}]).map((c, i) => {
    const prior = (existing?.configs ?? []).find((x) => x?.name === c.name);
    const config = {
      name: typeof c.name === "string" && NAME_RE.test(c.name) ? c.name : i === 0 ? "default" : null,
      query: c.query == null ? prior?.query ?? "" : String(c.query),
      query_language: typeof c.query_language === "string" ? c.query_language : prior?.query_language ?? "none",
      lookback_window_seconds: Number.isInteger(c.lookback_window_seconds) ? c.lookback_window_seconds : prior?.lookback_window_seconds ?? 86400,
    };
    if (!config.name) throw new SourcesError("Each config needs a name");
    if (config.query_language !== "none" && typeof config.query === "string" && !config.query.trim()) {
      throw new SourcesError(`config ${config.name}: a ${config.query_language} source needs a query that lists its agents`);
    }
    if (typeof config.query === "string" && config.query.includes("${")) {
      throw new SourcesError(`config ${config.name}: Deckard would read "\${" in its query as an environment variable`);
    }
    return config;
  });

  const item = { name, vendor: form.vendor, fields, configs };
  const test = {
    name,
    vendor: form.vendor,
    fields: testFields,
    configs: configs.map((c) => ({ ...c, query: fileRef(c.query) ? "" : c.query })),
  };
  return { item, files, test, keeps };
}

// Reads and writes the real files, one change at a time.
export class SourcesFile {
  constructor(configPath, secretsDir) {
    this.configPath = configPath;
    this.secretsDir = secretsDir;
    this.queue = Promise.resolve();
  }

  async read() {
    try {
      const text = await readFile(this.configPath, "utf8");
      return { text, hash: hashOf(text) };
    } catch (err) {
      throw new SourcesError(`The viewer can't read discovery.yaml (${err.code || err.message})`, 503);
    }
  }

  // Runs change(text) -> {text, files, removeFiles} against the file as it is, if it is
  // still the version the page was showing (baseHash), and writes the result in place.
  update(baseHash, change) {
    const run = async () => {
      const { text, hash } = await this.read();
      if (baseHash !== hash) throw new SourcesError("discovery.yaml changed since this page loaded it; reload and try again", 409);
      const out = await change(text);
      try {
        for (const f of out.files ?? []) {
          await writeFile(join(this.secretsDir, f.path.replace(/^secrets\//, "")), f.content, { mode: 0o640 });
        }
        // In place, not by rename: Deckard's container has this very file mounted, and a
        // renamed-over file would leave it reading the old one.
        await writeFile(this.configPath, out.text);
        for (const path of out.removeFiles ?? []) {
          await rm(join(this.secretsDir, path.replace(/^secrets\//, "")), { force: true });
        }
      } catch (err) {
        throw new SourcesError(
          `The viewer can't write ${err.path?.endsWith("discovery.yaml") ? "discovery.yaml" : "a secret file"} (${err.code || err.message}). It writes as user ID ${process.getuid?.() ?? "?"}: set VIEWER_UID in .env to the owner of discovery.yaml and secrets/, then docker compose up -d viewer`,
          503,
        );
      }
      return { hash: hashOf(out.text) };
    };
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => {});
    return result;
  }
}

// The secret files a removed item referenced that the viewer wrote, and so may delete.
export function ownSecretFiles(item) {
  return (item?.fields ?? [])
    .map((f) => (fileRef(f.value) ? f.value.file : null))
    .filter((path) => path && NAME_RE.test(item.name) && /^[a-z0-9_]{1,64}$/i.test(path.slice(`secrets/${item.name}.`.length)) && path.startsWith(`secrets/${item.name}.`));
}
