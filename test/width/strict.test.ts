/**
 * Width: strict fake servers. Each one behaves as strictly as a conforming server (rejecting
 * what the spec says to reject) AND watches the checker as a client, recording every request
 * that breaks a client MUST. The checker must get the right verdicts and commit no violations.
 *
 * Client rules enforced (2026-07-28 streamable-http § Protocol Version Header / § Server
 * Validation; 2025-11-25 transports § Sending Messages / § Session Management / § Protocol
 * Version Header):
 *  - every POST: Content-Type application/json; Accept lists application/json and text/event-stream
 *  - 2026-07-28: MCP-Protocol-Version and Mcp-Method present and equal to the body
 *  - 2025-11-25: after initialize, every request carries Mcp-Session-Id and MCP-Protocol-Version
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { SERVER_CARD_SCHEMA_URL, SERVER_CARD_TYPE, checkDiscovery, type DiscoveryReport } from "../../src/discovery.js";
import { cardValidator } from "../../src/validate.js";

const MCP = "https://wx.example.com/mcp";
const META_VERSION = "io.modelcontextprotocol/protocolVersion";
const via = (app: Hono): typeof fetch => (input, init) => Promise.resolve(app.fetch(new Request(input, init)));
const status = (r: DiscoveryReport, id: string) => r.results.find((x) => x.id === id)?.status;
const failed = (r: DiscoveryReport) => r.results.filter((x) => x.status === "fail").map((x) => x.id).sort();
const detail = (r: DiscoveryReport, id: string) => r.results.find((x) => x.id === id)?.detail ?? "";

type Legacy = "none" | "400" | "404-html" | "405" | "200-error" | "no-supported-versions";

/**
 * A strict server. `legacy: "none"` = a 2026-07-28 server with server/discover (and initialize).
 * Any other value = a 2025-11-25 server whose answer to server/discover is that shape.
 */
function strictServer(opts: { legacy?: Legacy; versions?: string[] } = {}) {
  const legacy = opts.legacy ?? "none";
  const app = new Hono();
  const violations: string[] = [];
  const answered: string[] = []; // methods this server answered with a result
  const sessions = new Map<string, string>(); // session id → negotiated version
  const card = {
    $schema: SERVER_CARD_SCHEMA_URL,
    name: "com.example/weather",
    title: "Weather",
    version: "2.0.0",
    description: "Weather for agents.",
    remotes: [{ type: "streamable-http", url: MCP, supportedProtocolVersions: opts.versions ?? (legacy === "none" ? ["2025-11-25", "2026-07-28"] : ["2025-11-25"]) }],
  };
  const info = { name: "com.example/weather", title: "Weather", version: "2.0.0", description: "Weather for agents." };
  const corsHeaders = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET",
    "Access-Control-Allow-Headers": "Content-Type, If-None-Match",
    "Access-Control-Expose-Headers": "ETag",
  };

  app.get("/mcp/server-card", (c) => {
    for (const [k, v] of Object.entries(corsHeaders)) c.header(k, v);
    c.header("Cache-Control", "public, max-age=3600");
    c.header("ETag", 'W/"card-v1"');
    const accept = c.req.header("accept");
    if (accept && !/application\/mcp-server-card\+json|\*\/\*/.test(accept)) return c.body(null, 406);
    if (c.req.header("if-none-match") === 'W/"card-v1"') return c.body(null, 304);
    c.header("Content-Type", SERVER_CARD_TYPE);
    return c.body(JSON.stringify(card));
  });
  app.options("/mcp/server-card", (c) => {
    for (const [k, v] of Object.entries(corsHeaders)) c.header(k, v);
    return c.body(null, 204);
  });
  app.get("/mcp", (c) => c.body(null, 405)); // no server-initiated SSE stream

  app.post("/mcp", async (c) => {
    if (c.req.header("origin")) return c.json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "Forbidden origin" } }, 403);
    const ct = c.req.header("content-type") ?? "";
    const accept = c.req.header("accept") ?? "";
    let msg: { id?: number; method?: string; params?: { _meta?: Record<string, unknown>; protocolVersion?: string } };
    try {
      msg = await c.req.json();
    } catch {
      return c.json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }, 400);
    }
    const where = `POST ${msg.method}`;
    if (!/^application\/json\b/.test(ct)) violations.push(`${where}: Content-Type is "${ct}", not application/json`);
    if (!(accept.includes("application/json") && accept.includes("text/event-stream"))) {
      violations.push(`${where}: Accept "${accept}" must list application/json and text/event-stream`);
    }
    const bodyVersion = msg.params?._meta?.[META_VERSION];

    if (msg.method === "initialize") {
      const v = msg.params?.protocolVersion === "2025-11-25" ? "2025-11-25" : "2025-11-25";
      const sid = `s-${sessions.size + 1}`;
      sessions.set(sid, v);
      answered.push("initialize");
      c.header("Mcp-Session-Id", sid);
      return c.json({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: v, capabilities: {}, serverInfo: info } });
    }

    if (bodyVersion !== undefined) {
      // A 2026-07-28 request.
      if (legacy !== "none") {
        switch (legacy) {
          case "400": return c.json({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32600, message: "Bad Request: no session" } }, 400);
          case "404-html": return c.html("<h1>Not Found</h1>", 404);
          case "405": return c.body(null, 405);
          case "200-error": return c.json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
          case "no-supported-versions": return c.json({ jsonrpc: "2.0", id: msg.id, result: { capabilities: {} } });
        }
      }
      const hv = c.req.header("mcp-protocol-version");
      const hm = c.req.header("mcp-method");
      if (!hv || !hm) {
        violations.push(`${where}: missing ${!hv ? "MCP-Protocol-Version" : "Mcp-Method"}`);
        return c.json({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32020, message: "Header mismatch" } }, 400);
      }
      if (hv !== bodyVersion || hm !== msg.method) {
        violations.push(`${where}: headers (${hv}, ${hm}) don't match the body (${String(bodyVersion)}, ${msg.method})`);
        return c.json({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32020, message: "Header mismatch" } }, 400);
      }
      if (bodyVersion !== "2026-07-28") {
        return c.json({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32022, message: "Unsupported protocol version", data: { supported: ["2026-07-28", "2025-11-25"], requested: bodyVersion } } }, 400);
      }
      if (msg.method === "server/discover") {
        answered.push("server/discover");
        return c.json({ jsonrpc: "2.0", id: msg.id, result: { resultType: "complete", supportedVersions: ["2026-07-28", "2025-11-25"], capabilities: {}, _meta: { "io.modelcontextprotocol/serverInfo": info } } });
      }
      return c.json({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32601, message: "Method not found" } }, 404);
    }

    // A 2025-11-25 request after initialize: session and version headers are required.
    const sid = c.req.header("mcp-session-id");
    if (!sid || !sessions.has(sid)) return c.json({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: -32600, message: "Bad Request: no valid session" } }, 400);
    if (c.req.header("mcp-protocol-version") !== sessions.get(sid)) violations.push(`${where}: MCP-Protocol-Version missing or wrong after initialize`);
    return c.json({ jsonrpc: "2.0", id: msg.id, result: {} });
  });

  app.delete("/mcp", (c) => {
    const sid = c.req.header("mcp-session-id");
    if (!sid || !sessions.has(sid)) {
      violations.push("DELETE: no valid Mcp-Session-Id");
      return c.body(null, 400);
    }
    if (c.req.header("mcp-protocol-version") !== sessions.get(sid)) {
      violations.push(`DELETE: MCP-Protocol-Version "${c.req.header("mcp-protocol-version") ?? ""}" missing or wrong (2025-11-25: required on all subsequent requests)`);
    }
    sessions.delete(sid);
    return c.body(null, 204);
  });

  return { app, violations, answered, openSessions: () => sessions.size };
}

const run = (app: Hono) => checkDiscovery({ mcpUrl: MCP }, { fetch: via(app), validateCard: cardValidator() });

test("strict 2026-07-28 server: no failures, consistency via server/discover, no client violations", async () => {
  const s = strictServer();
  const r = await run(s.app);
  assert.deepEqual(failed(r), []);
  assert.deepEqual(s.answered, ["server/discover"], "a 2026-07-28 server is read via server/discover, with no initialize");
  assert.equal(status(r, "consistency.protocol-version"), "pass");
  assert.equal(status(r, "consistency.name"), "pass"); // reverse-DNS serverInfo.name equals the card's
  assert.equal(status(r, "transport.origin-403"), "pass");
  assert.deepEqual(s.violations, []);
});

test("strict 2025-11-25 server: falls back to initialize, closes the session correctly, no client violations", async () => {
  const s = strictServer({ legacy: "200-error" });
  const r = await run(s.app);
  assert.deepEqual(failed(r), []);
  assert.deepEqual(s.answered, ["initialize"]);
  assert.equal(status(r, "consistency.version"), "pass");
  assert.deepEqual(s.violations, []);
  assert.equal(s.openSessions(), 0, "the checker closes the session it opened");
});

for (const legacy of ["400", "404-html", "405", "200-error", "no-supported-versions"] as const) {
  test(`legacy server answering server/discover with ${legacy}: falls back to initialize`, async () => {
    const s = strictServer({ legacy });
    const r = await run(s.app);
    assert.equal(status(r, "consistency.transport"), "pass", detail(r, "consistency.transport"));
    assert.equal(status(r, "consistency.protocol-version"), "pass");
    assert.deepEqual(s.answered, ["initialize"], "fell back to initialize");
    assert.deepEqual(s.violations, []);
    assert.equal(s.openSessions(), 0);
  });
}

test("a card that claims a version the strict server rejects is caught", async () => {
  const s = strictServer({ versions: ["2025-11-25", "2026-07-28", "2025-06-18"] });
  const r = await run(s.app);
  assert.equal(status(r, "consistency.protocol-version"), "fail");
  assert.match(detail(r, "consistency.protocol-version"), /2025-06-18/);
  assert.deepEqual(s.violations, []);
});
