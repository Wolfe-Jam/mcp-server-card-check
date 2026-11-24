/**
 * migrate: re-issue urn:air identifiers that read differently before and after AI Catalog v0.9.
 * Nothing touches the network: the CLI reads files or an injected fetch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateCatalog } from "../src/migrate.js";

const LIFECYCLE_EXT = "https://ai-catalog.org/extensions/lifecycle";
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

test("v0.9 order: valid v0.9 ids keep their kind; only a rename changes them", () => {
  const ids = ["urn:air:example.com:code-review:skill", "urn:air:example.com:code-review:mcp"];
  const r = migrateCatalog(catalog(...ids), { order: "name-kind" });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.changes, []);
  assert.deepEqual(r.unchanged, ids.map((id) => ({ id, reason: "valid-v0.9" })));
  const named = migrateCatalog(catalog(...ids), { order: "name-kind", rename: { [ids[0]]: "urn:air:example.com:review/code:skill" } });
  assert.deepEqual(named.changes, [{ from: ids[0], to: "urn:air:example.com:review/code:skill" }]);
});

test("a second run keeps a kind chosen in the first (the id is already re-issued)", () => {
  const map = { "urn:air:example.com:mcp:weather": "urn:air:example.com:weather:mcp" };
  const once = migrateCatalog(catalog("urn:air:example.com:mcp:weather"), { order: "namespace-name", map });
  assert.equal(once.changes[0].to, "urn:air:example.com:weather:mcp");
  for (const opts of [{ order: "namespace-name" as const, map }, { order: "namespace-name" as const }, { order: "name-kind" as const }]) {
    const twice = migrateCatalog(once.catalog, opts);
    assert.deepEqual(twice.errors, []);
    assert.deepEqual(twice.changes, [], JSON.stringify(opts));
    assert.deepEqual(twice.catalog, once.catalog);
  }
});

test("a second run keeps a chosen kind whatever key recorded the former id", () => {
  const old = "urn:air:example.com:mcp:weather";
  const once = migrateCatalog(catalog(old), { rename: { [old]: "urn:air:example.com:weather:mcp" }, formerKey: "https://example.com/ext/former", stubsUntil: "2027-03-01", today: "2026-11-24" });
  assert.equal(once.changes.length, 1);
  for (const opts of [{ order: "namespace-name" as const }, { order: "namespace-name" as const, stubsUntil: "2027-03-01", today: "2026-11-24" }]) {
    const twice = migrateCatalog(once.catalog, opts);
    assert.deepEqual(twice.errors, []);
    assert.deepEqual(twice.changes, []);
    assert.deepEqual(twice.unchanged, [{ id: "urn:air:example.com:weather:mcp", reason: "already-reissued" }]);
    assert.deepEqual(twice.catalog, once.catalog);
  }
  // Repeating the same --rename on the output is done, not an error.
  const again = migrateCatalog(once.catalog, { rename: { [old]: "urn:air:example.com:weather:mcp" } });
  assert.deepEqual(again.errors, []);
  assert.deepEqual(again.changes, []);
});

test("a list of related live ids is not a former-id record", () => {
  const input = catalog("urn:air:example.com:mcp:weather", "urn:air:example.com:bot");
  Object.assign(input.entries[0], { extensions: { "com.example.related": ["urn:air:example.com:bot"] } });
  const r = migrateCatalog(input, { order: "namespace-name" });
  assert.deepEqual(r.changes, [{ from: "urn:air:example.com:mcp:weather", to: "urn:air:example.com:weather" }]);
});

test("a repeated --rename is reported as already applied", () => {
  const old = "urn:air:example.com:mcp:weather";
  const once = migrateCatalog(catalog(old), { rename: { [old]: "urn:air:example.com:weather" } });
  const again = migrateCatalog(once.catalog, { rename: { [old]: "urn:air:example.com:weather" } });
  assert.deepEqual(again.appliedRenames, [{ from: old, to: "urn:air:example.com:weather" }]);
  assert.deepEqual(again.changes, []);
});

test("a second run is byte-identical, entries with inline data included", () => {
  const input = { specVersion: "0.9", entries: [
    { identifier: "urn:air:example.com:mcp:weather", type: T, data: { a: 1 }, description: "after data" },
  ] };
  const once = migrateCatalog(input, { order: "namespace-name" });
  assert.deepEqual(Object.keys((once.catalog.entries as Record<string, unknown>[])[0]).slice(0, 4), ["identifier", "type", "data", "description"]);
  const twice = migrateCatalog(once.catalog, { order: "namespace-name" });
  assert.equal(JSON.stringify(twice.catalog), JSON.stringify(once.catalog));
});

test("a --publisher that matches nothing is an error; the result names the publishers re-issued", () => {
  const c = catalog("urn:air:example.com:mcp:weather");
  assert.match(migrateCatalog(c, { order: "namespace-name", publishers: ["exmaple.com"] }).errors[0], /matches no urn:air identifier/);
  assert.deepEqual(migrateCatalog(c, { order: "namespace-name" }).publishers, ["example.com"]);
});

test("other publishers' entries are reported, not rewritten", () => {
  const input = catalog("urn:air:example.com:mcp:weather", "urn:air:other.org:skill:review");
  Object.assign(input.entries[1], { related: "urn:air:example.com:mcp:weather" });
  const r = migrateCatalog(input, { order: "namespace-name", publishers: ["example.com"] });
  assert.deepEqual((r.catalog.entries as Record<string, unknown>[])[1], input.entries[1]);
  assert.match(r.warnings.join(" "), /other publisher's entry names an old identifier/);
});

test("the publisher keeps the case it was written in", () => {
  const r = migrateCatalog(catalog("urn:air:Example.COM:mcp:weather"), { order: "namespace-name" });
  assert.equal(r.changes[0].to, "urn:air:Example.COM:weather");
});

test("other publishers' ids are left as they are; a mixed catalog needs --publisher", () => {
  const ids = ["urn:air:example.com:mcp:weather", "urn:air:other.org:skill:review"];
  const refused = migrateCatalog(catalog(...ids), { order: "namespace-name" });
  assert.match(refused.errors[0], /2 publishers \(example\.com, other\.org\): pass --publisher/);
  const r = migrateCatalog(catalog(...ids), { order: "namespace-name", publishers: ["example.com"] });
  assert.deepEqual(r.changes, [{ from: ids[0], to: "urn:air:example.com:weather" }]);
  assert.deepEqual(r.otherPublishers, [ids[1]]);
  const theirs = migrateCatalog(catalog(...ids), { order: "namespace-name", publishers: ["example.com"], rename: { [ids[1]]: "urn:air:other.org:review" } });
  assert.match(theirs.errors[0], /belongs to other\.org/);
});

test("inline data is never rewritten, digest or not, nested catalogs included", () => {
  const input = { specVersion: "0.9", entries: [
    { identifier: "urn:air:example.com:catalog:sub", type: "application/ai-catalog+json", data: { specVersion: "0.9", entries: [
      { identifier: "urn:air:example.com:mcp:weather", type: T, data: { a: "urn:air:example.com:mcp:weather" }, digest: "sha-256:x" }] } },
    { identifier: "urn:air:example.com:mcp:weather", type: T, url: "https://example.com/w" },
  ] };
  const r = migrateCatalog(input, { order: "namespace-name" });
  const e0 = (r.catalog.entries as Record<string, unknown>[])[0];
  assert.deepEqual(e0.data, input.entries[0].data);
  assert.match(r.warnings.join(" "), /inline data is never rewritten/);
});

test("former-key must be a URL or reverse-DNS; stub dates must be real and in the future", () => {
  const c = catalog("urn:air:example.com:mcp:weather");
  assert.match(migrateCatalog(c, { order: "namespace-name", formerKey: "former ids" }).errors[0], /URL or reverse-DNS/);
  assert.deepEqual(migrateCatalog(c, { order: "namespace-name", formerKey: "https://example.com/ext/former" }).errors, []);
  for (const d of ["2027-13-45", "2026-01-01", "2027-03-01T00:00Z"]) {
    assert.match(migrateCatalog(c, { order: "namespace-name", stubsUntil: d, today: "2026-11-24" }).errors[0], /future end-of-life date/, d);
  }
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
  assert.deepEqual(r.unchanged, [{ id: "urn:air:example.com:weather", reason: "one-segment" }]);
  assert.deepEqual(r.other, ["https://registry.example/ids/7bf4"]);
  assert.equal(r.stubCount, 0);
});

test("the new entry records its former identifier in a namespaced extension; no stubs by default", () => {
  const input = catalog("urn:air:example.com:agent:taf-git");
  const r = migrateCatalog(input, { order: "namespace-name" });
  const entries = r.catalog.entries as Record<string, unknown>[];
  assert.equal(entries.length, 1);
  assert.equal(r.stubCount, 0);
  assert.equal(entries[0].identifier, "urn:air:example.com:taf-git");
  assert.deepEqual(entries[0].extensions, { "com.example.former-identifiers": ["urn:air:example.com:agent:taf-git"] });
  assert.equal((input.entries[0] as Record<string, unknown>).identifier, "urn:air:example.com:agent:taf-git", "input not changed");
  const own = migrateCatalog(input, { order: "namespace-name", formerKey: "https://example.com/ext/former" });
  assert.deepEqual((own.catalog.entries as Record<string, unknown>[])[0].extensions, { "https://example.com/ext/former": ["urn:air:example.com:agent:taf-git"] });
});

test("stubsUntil keeps the old entry, marked with the lifecycle extension proposed in ai-catalog PR #97", () => {
  const r = migrateCatalog(catalog("urn:air:example.com:agent:taf-git"),
    { order: "namespace-name", stubsUntil: "2027-03-01", today: "2026-11-24" });
  const entries = r.catalog.entries as Record<string, unknown>[];
  assert.equal(r.stubCount, 1);
  assert.deepEqual(entries[1], {
    identifier: "urn:air:example.com:agent:taf-git", type: T, url: "https://example.com/0.json",
    extensions: { [LIFECYCLE_EXT]: { status: "deprecated", deprecated: {
      replacedBy: "urn:air:example.com:taf-git", deprecationDate: "2026-11-24", endOfLifeDate: "2027-03-01" } } },
  });
  assert.match(migrateCatalog(catalog("urn:air:example.com:a:b"), { order: "namespace-name", stubsUntil: "soon" }).errors[0], /future end-of-life date/);
});

test("running again on its own output changes nothing", () => {
  const once = migrateCatalog(catalog("urn:air:example.com:context:faf", "urn:air:example.com:memory:faf"),
    { order: "namespace-name", stubsUntil: "2027-03-01" });
  const twice = migrateCatalog(once.catalog, { order: "namespace-name", stubsUntil: "2027-03-01" });
  assert.deepEqual(twice.errors, []);
  assert.deepEqual(twice.changes, []);
  assert.deepEqual(twice.skippedStubs, ["urn:air:example.com:context:faf", "urn:air:example.com:memory:faf"]);
  assert.deepEqual(twice.catalog, once.catalog);
});

test("names depend on the other identifiers in the catalog; a shared rename map keeps catalogs alike", () => {
  const alone = migrateCatalog(catalog("urn:air:example.com:agent:fafa"), { order: "namespace-name" });
  const both = migrateCatalog(catalog("urn:air:example.com:agent:fafa", "urn:air:example.com:a2a:fafa"), { order: "namespace-name" });
  assert.equal(alone.changes[0].to, "urn:air:example.com:fafa");
  assert.equal(both.changes[0].to, "urn:air:example.com:fafa-agent");
  const map = { "urn:air:example.com:agent:fafa": "urn:air:example.com:fafa-agent", "urn:air:example.com:agent:elsewhere": "urn:air:example.com:elsewhere" };
  const shared = migrateCatalog(catalog("urn:air:example.com:agent:fafa"), { order: "namespace-name", map });
  assert.deepEqual(shared.errors, [], "map entries for other catalogs are skipped");
  assert.equal(shared.changes[0].to, "urn:air:example.com:fafa-agent");
  const wins = migrateCatalog(catalog("urn:air:example.com:agent:fafa"),
    { order: "namespace-name", map, rename: { "urn:air:example.com:agent:fafa": "urn:air:example.com:fafa-a" } });
  assert.equal(wins.changes[0].to, "urn:air:example.com:fafa-a", "rename wins over map");
});

test("signed Trust Manifests are left whole, with a warning; so is a signed catalog", () => {
  const input = catalog("urn:air:example.com:mcp:weather");
  Object.assign(input.entries[0], { trustManifests: [
    { contributor: "https://example.com", subject: { identifier: "urn:air:example.com:mcp:weather" }, signature: { signer: "https://example.com" } },
    { contributor: "https://example.com", subject: { identifier: "urn:air:example.com:mcp:weather" } },
  ] });
  const r = migrateCatalog({ ...input, signature: { signer: "https://example.com" } }, { order: "namespace-name" });
  const tm = (r.catalog.entries as Record<string, unknown>[])[0].trustManifests as Record<string, Record<string, unknown>>[];
  assert.equal(tm[0].subject.identifier, "urn:air:example.com:mcp:weather", "signed: untouched");
  assert.equal(tm[1].subject.identifier, "urn:air:example.com:weather", "unsigned: follows");
  assert.equal(r.warnings.length, 2);
  assert.match(r.warnings[0], /re-sign/);
  assert.match(r.warnings[1], /catalog is signed/);
});

test("references to an old identifier elsewhere in the entries follow it", () => {
  const input = catalog("urn:air:example.com:mcp:weather", "urn:air:example.com:mcp:weather-v2");
  (input.entries[0] as Record<string, unknown>).supersededBy = "urn:air:example.com:mcp:weather-v2";
  const r = migrateCatalog(input, { order: "namespace-name" });
  assert.equal(r.references, 1);
  assert.equal((r.catalog.entries as Record<string, unknown>[])[0].supersededBy, "urn:air:example.com:weather-v2");
});

test("a multi-version entry maps every version to the same new identifier", () => {
  const input = catalog("urn:air:example.com:mcp:weather", "urn:air:example.com:mcp:weather");
  Object.assign(input.entries[0], { version: "1.0.0" });
  Object.assign(input.entries[1], { version: "2.0.0" });
  const r = migrateCatalog(input, { order: "namespace-name", stubsUntil: "2027-03-01" });
  assert.equal(r.changes.length, 1);
  assert.equal(r.stubCount, 2);
});

test("inline data is left whole, with or without a digest; the warning counts both", () => {
  const input = { specVersion: "0.9", entries: [
    { identifier: "urn:air:example.com:mcp:weather", type: T, data: { ref: "urn:air:example.com:mcp:weather" }, digest: "sha-256:abc" },
    { identifier: "urn:air:example.com:mcp:news", type: T, data: { ref: "urn:air:example.com:mcp:weather" } },
  ] };
  const r = migrateCatalog(input, { order: "namespace-name" });
  const [a, b] = r.catalog.entries as Record<string, Record<string, unknown>>[];
  assert.equal(a.identifier, "urn:air:example.com:weather", "the identifier itself still changes");
  assert.equal(a.data.ref, "urn:air:example.com:mcp:weather", "digested data untouched");
  assert.equal(b.data.ref, "urn:air:example.com:mcp:weather", "undigested data untouched too (data is opaque)");
  assert.equal(r.warnings.length, 1);
  assert.match(r.warnings[0], /^2 entries' inline data name an old identifier/);
});

test("ids named outside the entries are reported, not changed", () => {
  const input = { ...catalog("urn:air:example.com:mcp:weather"),
    extensions: { "com.example.featured": "urn:air:example.com:mcp:weather" } };
  const r = migrateCatalog(input, { order: "namespace-name" });
  assert.deepEqual(r.catalog.extensions, input.extensions);
  assert.match(r.warnings[0], /outside the entries/);
});

test("a deprecated entry is a stub only when its successor lists it as a former id", () => {
  const real = { specVersion: "0.9", entries: [
    { identifier: "urn:air:example.com:mcp:weather", type: T, url: "https://example.com/w",
      extensions: { [LIFECYCLE_EXT]: { status: "deprecated", deprecated: { replacedBy: "urn:air:example.com:mcp:weather-v2" } } } },
    { identifier: "urn:air:example.com:mcp:weather-v2", type: T, url: "https://example.com/w2" },
  ] };
  const r = migrateCatalog(real, { order: "namespace-name" });
  assert.deepEqual(r.skippedStubs, [], "a genuinely deprecated entry is not mistaken for a stub");
  assert.equal(r.changes.length, 2);
  const e = (r.catalog.entries as Record<string, Record<string, Record<string, Record<string, unknown>>>>[])[0];
  assert.equal(e.extensions[LIFECYCLE_EXT].deprecated.replacedBy, "urn:air:example.com:weather-v2", "its successor reference follows");
});

test("rename sets a new identifier, a kind included; bad forms, other publishers and collisions are refused", () => {
  const ids = ["urn:air:example.com:memory:grok", "urn:air:example.com:weather", "https://registry.example/ids/7bf4", "urn:air:localhost:mcp:x"];
  const ok = migrateCatalog(catalog(...ids), { order: "namespace-name", rename: { [ids[0]]: "urn:air:example.com:grok-memory" } });
  assert.deepEqual(ok.changes, [{ from: ids[0], to: "urn:air:example.com:grok-memory" }]);
  assert.deepEqual(ok.other, [ids[2], ids[3]]);
  const kind = migrateCatalog(catalog(...ids), { order: "namespace-name", rename: { [ids[0]]: "urn:air:example.com:grok:memory" } });
  assert.deepEqual(kind.errors, []);
  assert.equal(kind.changes[0].to, "urn:air:example.com:grok:memory");
  const slash = migrateCatalog(catalog(...ids), { order: "namespace-name", rename: { [ids[0]]: "urn:air:example.com:memory/grok" } });
  assert.equal(slash.changes[0].to, "urn:air:example.com:memory/grok");
  const bad = migrateCatalog(catalog(...ids), { order: "namespace-name", rename: { [ids[0]]: "urn:air:example.com:a:b:c" } });
  assert.match(bad.errors[0], /not urn:air/);
  const pub = migrateCatalog(catalog(...ids), { order: "namespace-name", rename: { [ids[0]]: "urn:air:evil.org:grok" } });
  assert.match(pub.errors[0], /changes the publisher/);
  const clash = migrateCatalog(catalog(...ids), { order: "namespace-name", rename: { [ids[0]]: ids[1] } });
  assert.match(clash.errors[0], /collides/);
  const missing = migrateCatalog(catalog(...ids), { order: "namespace-name", rename: { "urn:air:example.com:nope": "urn:air:example.com:x" } });
  assert.match(missing.errors[0], /not an identifier in this catalog/);
  const notUrn = migrateCatalog(catalog(...ids), { order: "namespace-name", rename: { [ids[2]]: "urn:air:example.com:x" } });
  assert.match(notUrn.errors[0], /re-issues only those/);
});

test("name-kind refuses three segments after the publisher instead of dropping two", () => {
  const r = migrateCatalog(catalog("urn:air:example.com:a:b:c"), { order: "name-kind" });
  assert.match(r.errors[0], /more than v0\.9's \{name\}:\{kind\}/);
});

test("a generated name that collides with an existing identifier is an error", () => {
  const r = migrateCatalog(catalog("urn:air:example.com:mcp:weather", "urn:air:example.com:weather"), { order: "namespace-name" });
  assert.match(r.errors[0], /collides .* --rename/);
});

test("not a catalog", () => {
  assert.match(migrateCatalog([]).errors[0], /not an AI Catalog/);
});

test("CLI: dry run prints the mapping; --out writes; --map and --stubs-until; errors exit 2", async () => {
  const dir = mkdtempSync(join(tmpdir(), "migrate-"));
  const src = join(dir, "ai-catalog.json");
  writeFileSync(src, JSON.stringify(catalog("urn:air:example.com:agent:taf-git", "urn:air:example.com:memory:grok")));

  const dry = await run(["migrate", src, "--order", "namespace-name"]);
  assert.equal(dry.code, 0);
  assert.match(dry.out, /urn:air:example\.com:agent:taf-git\s+→\s+urn:air:example\.com:taf-git/);
  assert.match(dry.out, /2 re-issued \(former ids kept in extensions\) · dry run/);

  const map = join(dir, "map.json");
  writeFileSync(map, JSON.stringify({ "urn:air:example.com:memory:grok": "urn:air:example.com:grok-memory", "urn:air:example.com:not:here": "urn:air:example.com:x" }));
  const out = join(dir, "out.json");
  const w = await run(["migrate", src, "--order", "namespace-name", "--map", map, "--stubs-until", "2027-03-01", "--out", out]);
  assert.equal(w.code, 0);
  assert.match(w.out, /2 deprecated stubs until 2027-03-01/);
  const written = JSON.parse(readFileSync(out, "utf8"));
  assert.equal(written.entries.length, 4);
  assert.equal(written.entries[1].identifier, "urn:air:example.com:grok-memory");

  const j = JSON.parse((await run(["migrate", src, "--order", "namespace-name", "--json"])).out);
  assert.equal(j.catalog.entries.length, 2);

  assert.equal((await run(["migrate", src])).code, 2);
  assert.equal((await run(["migrate", src, "--order", "sideways"])).code, 2);
  assert.equal((await run(["migrate", src, "--rename", "nope"])).code, 2);
  assert.equal((await run(["migrate", join(dir, "missing.json")])).code, 2);
  assert.equal((await run(["migrate", src, "--map", join(dir, "missing.json")])).code, 2);
  writeFileSync(map, "[1]");
  assert.equal((await run(["migrate", src, "--map", map])).code, 2);
  assert.equal((await run(["migrate", src, "--order", "namespace-name", "--out", join(dir, "no/such/dir.json")])).code, 2);
  for (const args of [["--json", "--order", "sideways"], ["--json", "--bogus"], ["--json", join(dir, "missing.json")], ["--json"]]) {
    const e = await run(["migrate", ...(args.length > 1 && !args[1].startsWith("--") ? [] : [src]), ...args]);
    assert.equal(e.code, 2, args.join(" "));
    assert.ok(Array.isArray(JSON.parse(e.out).errors), args.join(" "));
  }
  const je = await run(["migrate", src, "--json"]);
  assert.equal(je.code, 2);
  assert.match(JSON.parse(je.out).errors[0], /--order/);
  const jd = JSON.parse((await run(["migrate", src, "--order", "namespace-name", "--json"])).out);
  assert.equal(jd.dryRun, true);
  assert.equal(jd.written, false);
  assert.match((await run(["migrate", "-V"])).out, /^server-card-check \d/);
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
