/**
 * Width: parity. The CLI, the library and the web checker must reach the same verdicts, and
 * the README must describe the checks the code actually runs.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { run } from "../../src/cli.js";
import { SERVER_CARD_SCHEMA_URL, SERVER_CARD_TYPE, AI_CATALOG_TYPE, checkDiscovery } from "../../src/discovery.js";
import { SPEC_REFS } from "../../src/refs.js";
import { cardValidator } from "../../src/validate.js";
import { validateCard as webValidateCard } from "../../worker/index.js";

const ROOT = join(import.meta.dirname, "..", "..");
const MCP = "https://wx.example.com/mcp";
const via = (app: Hono): typeof fetch => (input, init) => Promise.resolve(app.fetch(new Request(input, init)));

const good = {
  $schema: SERVER_CARD_SCHEMA_URL,
  name: "com.example/weather",
  version: "2.0.0",
  description: "Weather for agents.",
  remotes: [{ type: "streamable-http", url: MCP, supportedProtocolVersions: ["2025-11-25"] }],
};

/** A server that exercises every tier: card, hosting, catalog and an MCP endpoint. */
function fullServer() {
  const app = new Hono();
  app.get("/mcp/server-card", (c) => {
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Content-Type", SERVER_CARD_TYPE);
    return c.body(JSON.stringify(good));
  });
  app.get("/.well-known/ai-catalog.json", (c) => {
    c.header("Content-Type", AI_CATALOG_TYPE);
    return c.body(JSON.stringify({ specVersion: "1.0", entries: [{ identifier: "urn:air:wx.example.com:mcp:weather", type: SERVER_CARD_TYPE, url: "/mcp/server-card" }] }));
  });
  app.post("/mcp", async (c) => {
    const { id, method } = (await c.req.json()) as { id: number; method: string };
    if (method === "initialize") return c.json({ jsonrpc: "2.0", id, result: { protocolVersion: "2025-11-25", serverInfo: { name: "weather", version: "2.0.0" } } });
    return c.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Method not found" } });
  });
  return app;
}

test("validator parity: the web's precompiled validator and the library's agree, card by card", () => {
  const lib = cardValidator();
  const cards: [string, unknown][] = [
    ["valid", good],
    ["valid with optional fields", { ...good, title: "Weather", icons: [{ src: "https://wx.example.com/i.png" }], websiteUrl: "https://wx.example.com" }],
    ["missing $schema", { ...good, $schema: undefined }],
    ["wrong $schema", { ...good, $schema: "https://example.com/other.json" }],
    ["name without a slash", { ...good, name: "weather" }],
    ["empty version", { ...good, version: "" }],
    ["description over 100 characters", { ...good, description: "x".repeat(101) }],
    ["remotes not an array", { ...good, remotes: { type: "streamable-http", url: MCP } }],
    ["remote without a url", { ...good, remotes: [{ type: "streamable-http" }] }],
    ["not an object", ["a", "card"]],
    ["null", null],
  ];
  for (const [what, card] of cards) {
    assert.equal(webValidateCard(card) === null, lib(card) === null, `${what}: web ${webValidateCard(card) === null ? "valid" : "invalid"}, library ${lib(card) === null ? "valid" : "invalid"}`);
  }
});

test("CLI parity: the CLI's JSON verdicts are the library's", async () => {
  const app = fullServer();
  const lib = await checkDiscovery({ mcpUrl: MCP }, { fetch: via(app), validateCard: cardValidator() });
  const cli = await run([MCP, "--json", "--transport"], via(app));
  const cliReport = JSON.parse(cli.out) as { results: { id: string; status: string; level: string }[] };
  const pick = (rs: { id: string; status: string; level: string }[]) => rs.map((r) => `${r.id}=${r.level}/${r.status}`).sort();
  assert.deepEqual(pick(cliReport.results), pick(lib.results));
  assert.equal(cli.code, lib.mustFailures > 0 ? 1 : 0);
});

test("docs parity: the README's table, its count, SPEC_REFS and a full run name the same checks", async () => {
  const readme = readFileSync(join(ROOT, "README.md"), "utf8");
  const tableIds = [...readme.matchAll(/^\| `([a-z]+\.[a-z0-9-]+)` \|/gm)].map((m) => m[1]).sort();
  const refIds = Object.keys(SPEC_REFS).sort();
  assert.deepEqual(tableIds, refIds, "README table rows = SPEC_REFS");

  const count = Number(/All (\d+) checks/.exec(readme)?.[1]);
  assert.equal(count, refIds.length, `README says "All ${count} checks"`);

  const r = await checkDiscovery({ mcpUrl: MCP }, { fetch: via(fullServer()), validateCard: cardValidator() });
  assert.deepEqual([...new Set(r.results.map((x) => x.id))].sort(), refIds, "a full run emits exactly the documented checks");
});

test("every check cites a spec source with an https link", () => {
  for (const [id, ref] of Object.entries(SPEC_REFS)) {
    assert.ok(ref.label.trim().length > 0, `${id}: label`);
    assert.match(ref.url, /^https:\/\//, `${id}: url`);
  }
});
