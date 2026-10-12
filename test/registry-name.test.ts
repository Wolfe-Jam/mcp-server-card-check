/**
 * card.registry-name: when the caller supplies the MCP Registry name, the
 * card's `name` should match it. The 2026-10-12 census found 1,791 cards
 * named `io.pipeworx/<pack>` for registry entries `io.github.pipeworx-io/<pack>`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { checkDiscovery, SERVER_CARD_SCHEMA_URL } from "../src/discovery.js";

const via = (app: Hono): typeof fetch => (input, init) => Promise.resolve(app.fetch(new Request(input, init)));
const app = new Hono();
app.get("/mcp/server-card", (c) =>
  c.json({ $schema: SERVER_CARD_SCHEMA_URL, name: "io.example/weather", version: "1.0.0", description: "Weather.",
    remotes: [{ type: "streamable-http", url: "https://wx.example.com/mcp" }] }),
);
const result = async (registryName?: string) =>
  (await checkDiscovery({ mcpUrl: "https://wx.example.com/mcp", registryName }, { fetch: via(app) }))
    .results.find((x) => x.id === "card.registry-name")!;

test("a matching registry name passes", async () => {
  assert.equal((await result("io.example/weather")).status, "pass");
});

test("a different registry name fails as a SHOULD, naming both", async () => {
  const r = await result("io.github.example-org/weather");
  assert.equal(r.status, "fail");
  assert.equal(r.level, "should");
  assert.match(r.detail ?? "", /io\.example\/weather.*io\.github\.example-org\/weather/);
});

test("without a registry name the check is skipped", async () => {
  assert.equal((await result()).status, "skip");
});
