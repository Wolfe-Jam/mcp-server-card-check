/**
 * The browser entry: the same verdicts as the library, no runtime schema compile, no static
 * Node imports, and a read-only run (a fetch that refuses POST) that never throws.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { Hono } from "hono";
import { checkDiscovery, validateCard, SPEC_REFS, SERVER_CARD_SCHEMA_URL, SERVER_CARD_TYPE } from "../src/browser.js";
import { cardValidator } from "../src/validate.js";

const MCP = "https://wx.example.com/mcp";
const good = {
  $schema: SERVER_CARD_SCHEMA_URL,
  name: "com.example/weather",
  version: "2.0.0",
  description: "Weather for agents.",
  remotes: [{ type: "streamable-http", url: MCP, supportedProtocolVersions: ["2025-11-25"] }],
};

test("validateCard agrees with the library's validator", () => {
  const lib = cardValidator();
  for (const card of [good, { ...good, name: "weather" }, { ...good, version: "" }, null, ["x"], { ...good, remotes: {} }]) {
    assert.equal(validateCard(card) === null, lib(card) === null, JSON.stringify(card)?.slice(0, 60));
  }
});

test("the browser entry has no static node: imports and no runtime code generation", () => {
  for (const f of ["browser.ts", "discovery.ts", "refs.ts"]) {
    const src = readFileSync(join(import.meta.dirname, "..", "src", f), "utf8");
    assert.doesNotMatch(src, /^import[^;]*from\s+["']node:/m, `${f} imports a node: module statically`);
  }
  const standalone = readFileSync(join(import.meta.dirname, "..", "src", "validator-standalone.cjs"), "utf8");
  assert.doesNotMatch(standalone, /new Function|eval\(/, "the precompiled validator must not generate code");
});

test("a read-only run (POST refused, no rawStatus) checks the card and skips transport", async () => {
  const app = new Hono();
  app.get("/mcp/server-card", (c) => {
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Content-Type", SERVER_CARD_TYPE);
    return c.body(JSON.stringify(good));
  });
  const readOnly: typeof fetch = (input, init) => {
    if ((init?.method ?? "GET").toUpperCase() === "POST") return Promise.reject(new Error("read-only"));
    return Promise.resolve(app.fetch(new Request(input, init)));
  };
  const r = await checkDiscovery({ mcpUrl: MCP }, { fetch: readOnly, validateCard, rawStatus: async () => null });
  const by = (id: string) => r.results.find((x) => x.id === id)?.status;
  assert.equal(by("card.schema-valid"), "pass");
  for (const x of r.results) assert.ok(SPEC_REFS[x.id]?.url.startsWith("https://"), `${x.id} has a spec link`);
  for (const x of r.results.filter((x) => x.tier === "transport" || x.tier === "consistency")) {
    assert.notEqual(x.status, "pass", `${x.id} cannot pass without POST`);
  }
});
