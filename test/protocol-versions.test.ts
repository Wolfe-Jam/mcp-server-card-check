/**
 * card.protocol-versions: supportedProtocolVersions should name released MCP
 * versions. The 2026-10-12 census found one gateway declaring "2025-03-12" and
 * "2025-06-15" on 1,791 schema-valid cards; the schema accepts any string.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { checkDiscovery, unknownProtocolVersions, SERVER_CARD_SCHEMA_URL } from "../src/discovery.js";

const via = (app: Hono): typeof fetch => (input, init) => Promise.resolve(app.fetch(new Request(input, init)));
const cardWith = (versions?: unknown) => ({
  $schema: SERVER_CARD_SCHEMA_URL,
  name: "com.example/weather",
  version: "2.0.0",
  description: "Weather for agents.",
  remotes: [{ type: "streamable-http", url: "https://wx.example.com/mcp", ...(versions === undefined ? {} : { supportedProtocolVersions: versions }) }],
});
const run = async (versions?: unknown) => {
  const app = new Hono();
  app.get("/mcp/server-card", (c) => c.json(cardWith(versions)));
  const r = await checkDiscovery({ mcpUrl: "https://wx.example.com/mcp" }, { fetch: via(app) });
  return r.results.find((x) => x.id === "card.protocol-versions")!;
};

test("released versions pass", async () => {
  assert.equal((await run(["2025-06-18", "2025-11-25", "2026-07-28"])).status, "pass");
});

test("near-miss dates that were never released fail, naming them", async () => {
  const r = await run(["2025-03-12", "2025-06-15"]);
  assert.equal(r.status, "fail");
  assert.equal(r.level, "should");
  assert.match(r.detail ?? "", /2025-03-12, 2025-06-15/);
});

test("non-date strings fail; dates newer than the newest release pass", () => {
  assert.deepEqual(unknownProtocolVersions(["latest", "2025-06-18", "draft"]), ["latest", "draft"]);
  assert.deepEqual(unknownProtocolVersions(["2027-03-01"]), []);
});

test("no supportedProtocolVersions is a skip, not a failure", async () => {
  assert.equal((await run()).status, "skip");
});
