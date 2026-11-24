/**
 * migrate: re-issue urn:air identifiers in the kind-less v0.9 form, keep deprecated stubs.
 * Nothing touches the network: the CLI reads files or an injected fetch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateCatalog } from "../src/migrate.js";
import { run } from "../src/cli.js";

const T = "application/mcp-server-card+json";
const catalog = (...ids: string[]) => ({
  specVersion: "0.9",
  entries: ids.map((identifier, i) => ({ identifier, type: T, url: `https://example.com/${i}.json` })),
});

test("pre-v0.9 order: the name is the last segment; a name wanted twice keeps its namespace", () => {
  const r = migrateCatalog(catalog(
    "urn:air:example.com:context:faf", "urn:air:example.com:memory:faf", "urn:air:example.com:agent:taf-git",
  ), { order: "namespace-name" });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.changes, [
    { from: "urn:air:example.com:context:faf", to: "urn:air:example.com:faf-context" },
    { from: "urn:air:example.com:memory:faf", to: "urn:air:example.com:faf-memory" },
    { from: "urn:air:example.com:agent:taf-git", to: "urn:air:example.com:taf-git" },
  ]);
});

test("v0.9 order: the name is the first segment, the kind is dropped", () => {
  const r = migrateCatalog(catalog("urn:air:example.com:code-review:skill", "urn:air:example.com:code-review:mcp"),
    { order: "name-kind" });
  assert.deepEqual(r.changes.map((c) => c.to), ["urn:air:example.com:code-review-skill", "urn:air:example.com:code-review-mcp"]);
});

test("two segments without an order is an error, never a guess", () => {
  const r = migrateCatalog(catalog("urn:air:example.com:hr:benefits-agent"));
  assert.equal(r.changes.length, 0);
  assert.match(r.errors[0], /--order namespace-name .* or --order name-kind/);
});

test("kind-less and non-urn:air identifiers are left as they are", () => {
  const r = migrateCatalog(catalog("urn:air:example.com:weather", "https://registry.example/ids/7bf4"));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.changes, []);
  assert.deepEqual(r.unchanged, ["urn:air:example.com:weather"]);
  assert.deepEqual(r.other, ["https://registry.example/ids/7bf4"]);
  assert.equal(r.stubs, 0);
});

test("each re-issued entry keeps a deprecated stub pointing at its new identifier", () => {
  const input = catalog("urn:air:example.com:agent:taf-git");
  const r = migrateCatalog(input, { order: "namespace-name" });
  const entries = r.catalog.entries as Record<string, unknown>[];
  assert.equal(entries.length, 2);
  assert.equal(entries[0].identifier, "urn:air:example.com:taf-git");
  assert.deepEqual(entries[1], {
    identifier: "urn:air:example.com:agent:taf-git", type: T, url: "https://example.com/0.json",
    lifecycle: "deprecated", supersededBy: "urn:air:example.com:taf-git",
  });
  assert.equal((input.entries[0] as Record<string, unknown>).identifier, "urn:air:example.com:agent:taf-git", "input not changed");
  assert.equal(migrateCatalog(input, { order: "namespace-name", stubs: false }).stubs, 0);
});

test("references to an old identifier elsewhere in the entries follow it", () => {
  const input = catalog("urn:air:example.com:mcp:weather", "urn:air:example.com:mcp:weather-v2");
  (input.entries[0] as Record<string, unknown>).supersededBy = "urn:air:example.com:mcp:weather-v2";
  const r = migrateCatalog(input, { order: "namespace-name", stubs: false });
  assert.equal(r.references, 1);
  assert.equal((r.catalog.entries as Record<string, unknown>[])[0].supersededBy, "urn:air:example.com:weather-v2");
});

test("a multi-version entry maps every version to the same new identifier", () => {
  const input = catalog("urn:air:example.com:mcp:weather", "urn:air:example.com:mcp:weather");
  Object.assign(input.entries[0], { version: "1.0.0" });
  Object.assign(input.entries[1], { version: "2.0.0" });
  const r = migrateCatalog(input, { order: "namespace-name" });
  assert.equal(r.changes.length, 1);
  assert.equal(r.stubs, 2);
});

test("--rename sets a new identifier; kinds, bad forms and collisions are refused", () => {
  const ids = ["urn:air:example.com:memory:grok", "urn:air:example.com:weather"];
  const ok = migrateCatalog(catalog(...ids), { order: "namespace-name", rename: { [ids[0]]: "urn:air:example.com:grok-memory" } });
  assert.deepEqual(ok.changes, [{ from: ids[0], to: "urn:air:example.com:grok-memory" }]);
  const kind = migrateCatalog(catalog(...ids), { order: "namespace-name", rename: { [ids[0]]: "urn:air:example.com:grok:memory" } });
  assert.match(kind.errors[0], /carries a kind/);
  const clash = migrateCatalog(catalog(...ids), { order: "namespace-name", rename: { [ids[0]]: ids[1] } });
  assert.match(clash.errors[0], /collides/);
  const missing = migrateCatalog(catalog(...ids), { order: "namespace-name", rename: { "urn:air:example.com:nope": "urn:air:example.com:x" } });
  assert.match(missing.errors[0], /not an identifier in this catalog/);
});

test("a generated name that collides with an existing identifier is an error", () => {
  const r = migrateCatalog(catalog("urn:air:example.com:mcp:weather", "urn:air:example.com:weather"), { order: "namespace-name" });
  assert.match(r.errors[0], /collides .* --rename/);
});

test("not a catalog", () => {
  assert.match(migrateCatalog([]).errors[0], /not an AI Catalog/);
});

test("CLI: dry run prints the mapping; --out writes; --json carries the catalog; errors exit 2", async () => {
  const dir = mkdtempSync(join(tmpdir(), "migrate-"));
  const src = join(dir, "ai-catalog.json");
  writeFileSync(src, JSON.stringify(catalog("urn:air:example.com:agent:taf-git")));

  const dry = await run(["migrate", src, "--order", "namespace-name"]);
  assert.equal(dry.code, 0);
  assert.match(dry.out, /urn:air:example\.com:agent:taf-git\s+→\s+urn:air:example\.com:taf-git/);
  assert.match(dry.out, /dry run/);

  const out = join(dir, "out.json");
  assert.equal((await run(["migrate", src, "--order", "namespace-name", "--out", out])).code, 0);
  assert.equal(JSON.parse(readFileSync(out, "utf8")).entries.length, 2);

  const j = JSON.parse((await run(["migrate", src, "--order", "namespace-name", "--json", "--no-stubs"])).out);
  assert.equal(j.catalog.entries.length, 1);

  assert.equal((await run(["migrate", src])).code, 2);
  assert.equal((await run(["migrate", src, "--order", "sideways"])).code, 2);
  assert.equal((await run(["migrate", src, "--rename", "nope"])).code, 2);
  assert.equal((await run(["migrate", join(dir, "missing.json")])).code, 2);
});

test("CLI: reads a catalog URL with GET", async () => {
  let method = "";
  const fake: typeof fetch = async (_u, init) => {
    method = (init?.method ?? "GET").toUpperCase();
    return new Response(JSON.stringify(catalog("urn:air:example.com:weather")), { headers: { "content-type": "application/ai-catalog+json" } });
  };
  const r = await run(["migrate", "https://example.com/.well-known/ai-catalog.json"], fake);
  assert.equal(r.code, 0);
  assert.equal(method, "GET");
  assert.match(r.out, /0 re-issued/);
});
