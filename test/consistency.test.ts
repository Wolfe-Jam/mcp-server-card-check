/**
 * The consistency tier (discovery.md § Consistency with Runtime Behavior): the card compared
 * with what the server says once connected, via server/discover or, for a legacy server,
 * initialize. Fake servers answer through an injected `fetch`.
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
const detail = (r: DiscoveryReport, id: string) => r.results.find((x) => x.id === id)?.detail ?? "";

const baseCard = {
  $schema: SERVER_CARD_SCHEMA_URL,
  name: "com.example/weather",
  title: "Weather",
  version: "2.0.0",
  description: "Weather for agents.",
  remotes: [{ type: "streamable-http", url: MCP, supportedProtocolVersions: ["2025-11-25", "2026-07-28"] }],
};

interface Info { name?: string; version?: string; title?: string; description?: string }

/**
 * A server that answers server/discover (modern) or only initialize (legacy: server/discover
 * gets JSON-RPC "method not found"). Records whether a legacy session was closed.
 */
function server(
  info: Info,
  opts: { legacy?: boolean; versions?: string[]; sse?: boolean; status?: number; card?: object } = {},
) {
  const app = new Hono();
  const seen = { deleted: false, methods: [] as string[] };
  app.get("/mcp/server-card", (c) => c.json(opts.card ?? baseCard));
  app.post("/mcp", async (c) => {
    if (opts.status) return c.text("no", opts.status as 401);
    const msg = (await c.req.json()) as { id: number; method: string };
    seen.methods.push(msg.method);
    // A conforming 2026-07-28 server rejects a request whose Mcp-Method header is missing or wrong.
    if (msg.method === "server/discover" && !opts.legacy && c.req.header("mcp-method") !== msg.method) {
      return c.json({ jsonrpc: "2.0", id: msg.id, error: { code: -32020, message: "Header mismatch" } }, 400);
    }
    let reply: object;
    if (msg.method === "server/discover" && !opts.legacy) {
      reply = { jsonrpc: "2.0", id: msg.id, result: { supportedVersions: opts.versions ?? ["2025-11-25", "2026-07-28"], _meta: { "io.modelcontextprotocol/serverInfo": info } } };
    } else if (msg.method === "initialize" && opts.legacy) {
      c.header("Mcp-Session-Id", "s-1");
      reply = { jsonrpc: "2.0", id: msg.id, result: { protocolVersion: (opts.versions ?? ["2025-11-25"])[0], serverInfo: info } };
    } else {
      reply = { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } };
    }
    if (opts.sse) {
      c.header("Content-Type", "text/event-stream");
      return c.body(`event: message\ndata: ${JSON.stringify(reply)}\n\n`);
    }
    return c.body(JSON.stringify(reply), 200, { "Content-Type": "application/json" });
  });
  app.delete("/mcp", (c) => {
    seen.deleted = c.req.header("Mcp-Session-Id") === "s-1";
    return c.body(null, 204);
  });
  return { app, seen };
}

const run = (app: Hono, f?: typeof fetch) =>
  checkDiscovery({ mcpUrl: MCP }, { fetch: f ?? via(app), validateCard: cardValidator() });

test("a server that matches its card passes, read via server/discover", async () => {
  const { app, seen } = server({ name: "weather", title: "Weather", version: "2.0.0", description: "Weather for agents." });
  const r = await run(app);
  assert.deepEqual(consistency(r), {
    "consistency.transport": "pass",
    "consistency.protocol-version": "pass",
    "consistency.version": "pass",
    "consistency.name": "skip", // "weather" is a short name: it can't contradict the card's
    "consistency.title": "pass",
    "consistency.description": "pass",
  });
  assert.deepEqual(seen.methods.filter((m) => m !== "ping"), ["server/discover"]);
});

test("a server that contradicts its card fails the SHOULDs, never a MUST", async () => {
  const { app } = server(
    { name: "org.other/weather", title: "Weather Pro", version: "3.1.0", description: "Something else." },
    { versions: ["2026-07-28"] },
  );
  const r = await run(app);
  assert.deepEqual(consistency(r), {
    "consistency.transport": "pass",
    "consistency.protocol-version": "fail",
    "consistency.version": "fail",
    "consistency.name": "fail",
    "consistency.title": "fail",
    "consistency.description": "fail",
  });
  assert.match(detail(r, "consistency.protocol-version"), /card lists 2025-11-25, which the server doesn't support/);
  assert.match(detail(r, "consistency.version"), /card "2\.0\.0" vs server "3\.1\.0" \(via server\/discover\)/);
  assert.ok(r.results.filter((x) => x.tier === "consistency").every((x) => x.level === "should"));
});

test("a reverse-DNS serverInfo.name that equals the card's passes", async () => {
  const { app } = server({ name: "com.example/weather", version: "2.0.0" });
  assert.equal(consistency(await run(app))["consistency.name"], "pass");
});

test("a legacy server is read via initialize, and its session is closed", async () => {
  const { app, seen } = server({ name: "weather", title: "Weather", version: "2.0.0" }, { legacy: true });
  const r = await run(app);
  assert.equal(consistency(r)["consistency.protocol-version"], "pass"); // agreed 2025-11-25, which the card lists
  assert.equal(consistency(r)["consistency.version"], "pass");
  assert.match(detail(r, "consistency.description"), /via initialize/); // skipped: the server gives no description
  assert.deepEqual(seen.methods.filter((m) => m !== "ping"), ["server/discover", "initialize"]);
  assert.equal(seen.deleted, true);
});

test("an initialize answered as an event stream is read the same way", async () => {
  const { app } = server({ name: "weather", version: "2.0.0" }, { legacy: true, sse: true });
  const r = await run(app);
  assert.equal(consistency(r)["consistency.version"], "pass");
  assert.equal(consistency(r)["consistency.title"], "skip", "the server gives no title");
});

test("a card remote that says another transport fails consistency.transport", async () => {
  const card = { ...baseCard, remotes: [{ type: "sse", url: MCP }] };
  const { app } = server({ version: "2.0.0" }, { card });
  const r = await run(app);
  assert.equal(consistency(r)["consistency.transport"], "fail");
  assert.equal(consistency(r)["consistency.protocol-version"], "skip");
});

test("a server that needs authorization is skipped, not failed", async () => {
  const { app } = server({}, { status: 401 });
  const r = await run(app);
  assert.ok(Object.values(consistency(r)).every((s) => s === "skip"));
  assert.equal(detail(r, "consistency.transport"), "needs authorization (401)");
});

test("a read-only run sends no POST or DELETE and skips the tier", async () => {
  const { app, seen } = server({ version: "2.0.0" }, { legacy: true });
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

test("card.version-semver: semver passes; v-prefixed and words fail", async () => {
  for (const [version, want] of [["2.0.0", "pass"], ["1.0.0-beta.2+build.5", "pass"], ["v2", "fail"], ["latest", "fail"]] as const) {
    const { app } = server({}, { card: { ...baseCard, version } });
    const r = await run(app);
    assert.equal(r.results.find((x) => x.id === "card.version-semver")?.status, want, version);
  }
});
