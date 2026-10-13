/**
 * The consistency tier (discovery.md § Consistency with Runtime Behavior): the card compared
 * with what the server says once connected. Fake servers answer through an injected `fetch`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { SERVER_CARD_SCHEMA_URL, checkDiscovery, type DiscoveryReport } from "../src/discovery.js";
import { cardValidator } from "../src/validate.js";

const MCP = "https://wx.example.com/mcp";
const via = (app: Hono): typeof fetch => (input, init) => Promise.resolve(app.fetch(new Request(input, init)));
const consistency = (r: DiscoveryReport) =>
  Object.fromEntries(r.results.filter((x) => x.tier === "consistency").map((x) => [x.id, x.status]));

const card = {
  $schema: SERVER_CARD_SCHEMA_URL,
  name: "com.example/weather",
  title: "Weather",
  version: "2.0.0",
  description: "Weather for agents.",
  remotes: [{ type: "streamable-http", url: MCP, supportedProtocolVersions: ["2025-06-18", "2025-11-25"] }],
};

/** A server whose initialize answers with the given result; records whether its session was closed. */
function server(result: Record<string, unknown>, opts: { sse?: boolean; status?: number } = {}) {
  const app = new Hono();
  const seen = { deleted: false };
  app.get("/mcp/server-card", (c) => c.json(card));
  app.post("/mcp", async (c) => {
    if (opts.status) return c.text("no", opts.status as 401);
    const msg = (await c.req.json()) as { id: number; method: string };
    if (msg.method !== "initialize") return c.text("", 403);
    c.header("Mcp-Session-Id", "s-1");
    const reply = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result });
    if (opts.sse) {
      c.header("Content-Type", "text/event-stream");
      return c.body(`event: message\ndata: ${reply}\n\n`);
    }
    return c.body(reply, 200, { "Content-Type": "application/json" });
  });
  app.delete("/mcp", (c) => {
    seen.deleted = c.req.header("Mcp-Session-Id") === "s-1";
    return c.body(null, 204);
  });
  return { app, seen };
}

const run = (app: Hono, f?: typeof fetch) =>
  checkDiscovery({ mcpUrl: MCP }, { fetch: f ?? via(app), validateCard: cardValidator() });

test("a server that matches its card passes, and its session is closed afterwards", async () => {
  const { app, seen } = server({ protocolVersion: "2025-11-25", serverInfo: { name: "weather", title: "Weather", version: "2.0.0" } });
  const r = await run(app);
  assert.deepEqual(consistency(r), {
    "consistency.transport": "pass",
    "consistency.protocol-version": "pass",
    "consistency.version": "pass",
    "consistency.title": "pass",
  });
  assert.equal(seen.deleted, true);
});

test("a server that contradicts its card fails the SHOULDs, never a MUST", async () => {
  const { app } = server({ protocolVersion: "2026-07-28", serverInfo: { name: "weather", title: "Weather Pro", version: "3.1.0" } });
  const r = await run(app);
  assert.deepEqual(consistency(r), {
    "consistency.transport": "pass",
    "consistency.protocol-version": "fail",
    "consistency.version": "fail",
    "consistency.title": "fail",
  });
  const detail = r.results.find((x) => x.id === "consistency.version")?.detail;
  assert.equal(detail, "card 2.0.0 vs server 3.1.0");
  assert.ok(r.results.filter((x) => x.tier === "consistency").every((x) => x.level === "should"));
});

test("an initialize answered as an event stream is read the same way", async () => {
  const { app } = server({ protocolVersion: "2025-06-18", serverInfo: { name: "weather", version: "2.0.0" } }, { sse: true });
  const r = await run(app);
  assert.equal(consistency(r)["consistency.protocol-version"], "pass");
  assert.equal(consistency(r)["consistency.version"], "pass");
  assert.equal(consistency(r)["consistency.title"], "skip", "the server gives no title");
});

test("a server that needs authorization is skipped, not failed", async () => {
  const { app } = server({}, { status: 401 });
  const r = await run(app);
  assert.ok(Object.values(consistency(r)).every((s) => s === "skip"));
  assert.equal(r.results.find((x) => x.id === "consistency.transport")?.detail, "needs authorization (401)");
});

test("a read-only run sends no initialize and skips the tier", async () => {
  const { app, seen } = server({ protocolVersion: "2025-11-25", serverInfo: { version: "2.0.0" } });
  const methods: string[] = [];
  const readOnly: typeof fetch = (input, init = {}) => {
    const m = (init.method ?? "GET").toUpperCase();
    methods.push(m);
    if (m === "POST") return Promise.reject(new Error("read-only"));
    return via(app)(input, init);
  };
  const r = await run(app, readOnly);
  assert.ok(Object.values(consistency(r)).every((s) => s === "skip"));
  assert.ok(!methods.includes("DELETE"));
  assert.equal(seen.deleted, false);
});
