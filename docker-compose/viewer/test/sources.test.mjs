// Adding, editing and removing sources in discovery.yaml: only the source's own text
// changes, secrets go to files, and nothing typed becomes a reference.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "../vendor/yaml.mjs";
import { addSource, buildSource, itemOf, ownSecretFiles, readSources, removeSource, replaceSource } from "../sources.mjs";

// Deckard's shipped discovery.yaml, comments and all.
const SHIPPED = readFileSync(new URL("discovery.fixture.yaml", import.meta.url), "utf8");
const secretKeys = (vendor) => ({ local: new Set(), wiz: new Set(["client_secret"]), jamf_pro: new Set(["client_id", "client_secret"]) })[vendor] ?? null;
const wizForm = (fields = {}) => ({
  name: "wiz-prod",
  vendor: "wiz",
  fields: { api_endpoint_url: "https://api.us1.app.wiz.io/graphql", auth_environment: "commercial", client_id: "abc", client_secret: "s3cret", entity_types: "", ...fields },
  configs: [{ name: "default", query: "", query_language: "none", lookback_window_seconds: 86400 }],
});

test("adding a source leaves every other line as it was", () => {
  const { item } = buildSource(wizForm(), { secretKeys });
  const added = addSource(SHIPPED, item);
  // Everything shipped is still there, in order, with the new source after the last one.
  const removedAgain = removeSource(added, "wiz-prod");
  assert.equal(removedAgain.text, SHIPPED);
  assert.deepEqual(parse(added).sources.map((s) => s.name), ["this-machine", "wiz-prod"]);
  assert.match(added, /^ {2}- name: wiz-prod\n {4}vendor: wiz\n/m);
  assert.match(added, / {6}- \{key: client_secret, value: \{file: secrets\/wiz-prod\.client_secret\}\}/);
});

test("a secret goes to a file, never into discovery.yaml or back to the page", () => {
  const built = buildSource(wizForm(), { secretKeys });
  assert.deepEqual(built.files, [{ path: "secrets/wiz-prod.client_secret", content: "s3cret" }]);
  const added = addSource(SHIPPED, built.item);
  assert.ok(!added.includes("s3cret"));
  const shown = readSources(added, secretKeys).find((s) => s.name === "wiz-prod");
  assert.deepEqual(shown.fields.find((f) => f.key === "client_secret"), { key: "client_secret", secret: true, set: true, ref: "file" });
  assert.ok(!JSON.stringify(shown).includes("s3cret"));
  // The engine tests it with the value itself.
  assert.deepEqual(built.test.fields.find((f) => f.key === "client_secret"), { key: "client_secret", value: "s3cret" });
});

test("a secret left blank when editing keeps what the file has", () => {
  const withEnv = SHIPPED.replace(
    "  - name: this-machine",
    "  - name: macs\n    vendor: jamf_pro\n    fields:\n      - {key: base_url, value: https://acme.jamfcloud.com}\n      - {key: client_id, value: \"${JAMF_CLIENT_ID}\"}\n      - {key: client_secret, value: \"${JAMF_CLIENT_SECRET}\"}\n    configs:\n      - {name: all, query: \"\", query_language: none, lookback_window_seconds: 86400}\n  - name: this-machine",
  );
  const existing = itemOf(withEnv, "macs");
  const built = buildSource(
    { name: "macs", vendor: "jamf_pro", fields: { base_url: "https://acme2.jamfcloud.com", client_id: "", client_secret: "" }, configs: [{ name: "all", query_language: "none", lookback_window_seconds: 3600 }] },
    { secretKeys, existing },
  );
  assert.deepEqual(built.files, []);
  const edited = parse(replaceSource(withEnv, "macs", built.item)).sources[0];
  assert.deepEqual(edited.fields, [
    { key: "base_url", value: "https://acme2.jamfcloud.com" },
    { key: "client_id", value: "${JAMF_CLIENT_ID}" },
    { key: "client_secret", value: "${JAMF_CLIENT_SECRET}" },
  ]);
  assert.equal(edited.configs[0].lookback_window_seconds, 3600);
  // Only the edited source changed.
  assert.ok(replaceSource(withEnv, "macs", built.item).endsWith(withEnv.slice(withEnv.indexOf("  - name: this-machine"))));
});

test("nothing typed can become a reference to Deckard's environment", () => {
  for (const value of ["${ELASTIC_PASSWORD}", "https://x/${HOME}"]) {
    assert.throws(() => buildSource(wizForm({ api_endpoint_url: value }), { secretKeys }), /environment variable/);
  }
  // A secret holding it is written to a file, which Deckard never interpolates.
  const built = buildSource(wizForm({ client_secret: "${ELASTIC_PASSWORD}" }), { secretKeys });
  assert.equal(built.files[0].content, "${ELASTIC_PASSWORD}");
  assert.throws(() => buildSource({ ...wizForm(), configs: [{ name: "c", query: "${X}" }] }, { secretKeys }), /environment variable/);
});

test("names and kinds are checked", () => {
  for (const name of ["", "../etc", "a b", "-x", "x".repeat(64)]) {
    assert.throws(() => buildSource({ ...wizForm(), name }, { secretKeys }), /name/);
  }
  assert.throws(() => buildSource({ ...wizForm(), vendor: "nope" }, { secretKeys }), /can't scan/);
  const existing = itemOf(SHIPPED, "this-machine");
  assert.throws(() => buildSource({ ...wizForm(), name: "this-machine" }, { secretKeys, existing }), /can't change/);
  const { item } = buildSource(wizForm(), { secretKeys });
  assert.throws(() => addSource(addSource(SHIPPED, item), item), /already exists/);
});

test("removing a source takes its comment and its own secret files, and never the last one", () => {
  const removed = removeSource(addSource(SHIPPED, buildSource(wizForm(), { secretKeys }).item), "this-machine");
  assert.ok(!removed.text.includes("This machine: the scan"));
  assert.ok(!removed.text.includes("name: this-machine"));
  assert.throws(() => removeSource(removed.text, "wiz-prod"), /at least one source/);
  const wiz = removeSource(addSource(SHIPPED, buildSource(wizForm(), { secretKeys }).item), "wiz-prod");
  assert.deepEqual(ownSecretFiles(wiz.item), ["secrets/wiz-prod.client_secret"]);
  // A file the viewer didn't name after the source is someone else's.
  assert.deepEqual(ownSecretFiles({ name: "a", fields: [{ key: "k", value: { file: "secrets/gcp.json" } }] }), []);
});
