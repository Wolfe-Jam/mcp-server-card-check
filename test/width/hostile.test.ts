/**
 * Width: hostile and messy servers. The depth suite proves every check passes and fails
 * against polite fakes; these prove the verdicts hold, and the run finishes, when a server
 * is slow, huge, oddly shaped or broken.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { SERVER_CARD_SCHEMA_URL, SERVER_CARD_TYPE, checkDiscovery, type DiscoveryReport } from "../../src/discovery.js";
import { cardValidator } from "../../src/validate.js";

const MCP = "https://wx.example.com/mcp";
const status = (r: DiscoveryReport, id: string) => r.results.find((x) => x.id === id)?.status;
const detail = (r: DiscoveryReport, id: string) => r.results.find((x) => x.id === id)?.detail ?? "";
const via = (app: Hono): typeof fetch => (input, init) => Promise.resolve(app.fetch(new Request(input, init)));

const card = {
  $schema: SERVER_CARD_SCHEMA_URL,
  name: "com.example/weather",
  version: "2.0.0",
  description: "Weather for agents.",
  remotes: [{ type: "streamable-http", url: MCP, supportedProtocolVersions: ["2025-11-25"] }],
};

/** A fetch that answers the card at /mcp/server-card with `body` and 404s everything else. */
function cardFetch(body: () => BodyInit, headers: Record<string, string> = {}): typeof fetch {
  return async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname === "/mcp/server-card") return new Response(body(), { headers: { "content-type": SERVER_CARD_TYPE, ...headers } });
    return new Response("not found", { status: 404 });
  };
}

// ── Bug A: SSE events whose data spans several `data:` lines ────────────────────
test("SSE: a JSON-RPC result split over several data: lines is read (lines joined with \\n)", async () => {
  const app = new Hono();
  app.get("/mcp/server-card", (c) => c.json(card));
  app.post("/mcp", async (c) => {
    const msg = (await c.req.json()) as { id: number; method: string };
    if (msg.method !== "initialize") return c.json({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "Method not found" } });
    const json = JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-11-25", serverInfo: { name: "weather", version: "2.0.0" } } }, null, 2);
    c.header("Content-Type", "text/event-stream");
    // One event, the JSON pretty-printed across many data: lines, CRLF endings, a comment and an event: line.
    return c.body(`: keep-alive\r\nevent: message\r\n${json.split("\n").map((l) => `data: ${l}`).join("\r\n")}\r\n\r\n`);
  });
  const r = await checkDiscovery({ mcpUrl: MCP }, { fetch: via(app), validateCard: cardValidator() });
  assert.equal(status(r, "consistency.transport"), "pass", detail(r, "consistency.transport"));
  assert.equal(status(r, "consistency.version"), "pass");
});

// ── Bug B: response size ────────────────────────────────────────────────────────
test("a card larger than the cap fails as too large, and the run finishes quickly", { timeout: 20_000 }, async () => {
  const big = () => {
    const chunk = new TextEncoder().encode(" ".repeat(64 * 1024));
    let sent = 0;
    return new ReadableStream<Uint8Array>({
      pull(ctrl) {
        if (sent >= 20 * 1024 * 1024) return ctrl.close();
        sent += chunk.length;
        ctrl.enqueue(chunk);
      },
    });
  };
  const t0 = Date.now();
  const r = await checkDiscovery({ mcpUrl: MCP }, { fetch: cardFetch(big), validateCard: cardValidator() });
  assert.equal(status(r, "card.json"), "fail");
  assert.match(detail(r, "card.json"), /larger than/i);
  assert.ok(Date.now() - t0 < 10_000, "the cap stops reading early");
});

test("an endless card body is cut off at the cap instead of hanging", { timeout: 20_000 }, async () => {
  const endless = () =>
    new ReadableStream<Uint8Array>({
      pull(ctrl) {
        ctrl.enqueue(new TextEncoder().encode("x".repeat(64 * 1024)));
      },
    });
  const r = await checkDiscovery({ mcpUrl: MCP }, { fetch: cardFetch(endless), validateCard: cardValidator() });
  assert.equal(status(r, "card.json"), "fail");
});

// ── Bug D: deep nesting ─────────────────────────────────────────────────────────
test("a card nested 100,000 levels deep gets verdicts, not a crash", { timeout: 20_000 }, async () => {
  const deep = '{"_meta":{"com.example/x":' + "[".repeat(100_000) + "]".repeat(100_000) + "}}";
  const body = JSON.stringify(card).replace(/}$/, "," + deep.slice(1));
  const r = await checkDiscovery({ mcpUrl: MCP }, { fetch: cardFetch(() => body), validateCard: cardValidator() });
  assert.ok(r.results.length > 0);
  assert.ok(["pass", "fail"].includes(String(status(r, "card.no-secrets"))));
});

// ── Time ────────────────────────────────────────────────────────────────────────
test("a server that never answers is timed out, and the run reports it", { timeout: 30_000 }, async () => {
  // A real hanging server holds an open socket, which keeps the process alive. This fake holds a
  // timer for the same reason: AbortSignal.timeout's timer alone doesn't, and Node 22 then ends the
  // event loop and cancels the remaining tests.
  const hang: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      const socket = setInterval(() => {}, 1_000);
      init?.signal?.addEventListener("abort", () => {
        clearInterval(socket);
        reject(new Error("aborted"));
      });
    });
  const t0 = Date.now();
  const r = await checkDiscovery({ mcpUrl: MCP }, { fetch: hang, timeoutMs: 200 });
  assert.equal(status(r, "card.found"), "fail");
  assert.ok(Date.now() - t0 < 15_000, `took ${Date.now() - t0} ms`);
});

// ── Shape ───────────────────────────────────────────────────────────────────────
test("duplicate Access-Control-Allow-Origin values (*, *) are not a valid *", async () => {
  const app = new Hono();
  app.get("/mcp/server-card", (c) => {
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Access-Control-Allow-Origin", "*", { append: true });
    return c.json(card);
  });
  const r = await checkDiscovery({ mcpUrl: MCP }, { fetch: via(app) });
  assert.equal(status(r, "hosting.cors-origin"), "fail");
});

test("ETags: a weak ETag answered with 304 passes; a 304 without an ETag, or an ETag never honoured, fails", async () => {
  const serve = (mode: "weak" | "never" | "none") => {
    const app = new Hono();
    app.get("/mcp/server-card", (c) => {
      if (mode !== "none") c.header("ETag", 'W/"v1"');
      if (mode === "weak" && c.req.header("if-none-match") === 'W/"v1"') return c.body(null, 304);
      if (mode === "none" && c.req.header("if-none-match")) return c.body(null, 304);
      return c.json(card);
    });
    return checkDiscovery({ mcpUrl: MCP }, { fetch: via(app) });
  };
  assert.equal(status(await serve("weak"), "hosting.etag"), "pass");
  assert.equal(status(await serve("never"), "hosting.etag"), "fail");
  assert.equal(status(await serve("none"), "hosting.etag"), "fail");
});

test("a valid card with the wrong Content-Type fails only the media-type check", async () => {
  const r = await checkDiscovery({ mcpUrl: MCP }, { fetch: cardFetch(() => JSON.stringify(card), { "content-type": "text/plain" }), validateCard: cardValidator() });
  assert.equal(status(r, "hosting.content-type"), "fail");
  assert.equal(status(r, "card.schema-valid"), "pass");
});

test("a UTF-8 BOM before the JSON is tolerated", async () => {
  const r = await checkDiscovery({ mcpUrl: MCP }, { fetch: cardFetch(() => "﻿" + JSON.stringify(card)), validateCard: cardValidator() });
  assert.equal(status(r, "card.json"), "pass");
});

test("__proto__ keys in a card don't pollute Object.prototype", async () => {
  const body = JSON.stringify(card).replace(/}$/, ',"__proto__":{"polluted":true},"_meta":{"com.example/x":{"__proto__":{"polluted":true}}}}');
  await checkDiscovery({ mcpUrl: MCP }, { fetch: cardFetch(() => body), validateCard: cardValidator() });
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
});

test("a JSON-RPC reply with the wrong id, or a batch, is not taken as the answer", async () => {
  for (const shape of ["wrong-id", "batch"] as const) {
    const app = new Hono();
    app.get("/mcp/server-card", (c) => c.json(card));
    app.post("/mcp", async (c) => {
      const msg = (await c.req.json()) as { id: number };
      const reply = { jsonrpc: "2.0", id: shape === "wrong-id" ? 999 : msg.id, result: { supportedVersions: ["2025-11-25"], protocolVersion: "2025-11-25", serverInfo: { version: "2.0.0" } } };
      return c.json(shape === "batch" ? [reply] : reply);
    });
    const r = await checkDiscovery({ mcpUrl: MCP }, { fetch: via(app) });
    assert.equal(status(r, "consistency.transport"), "fail", shape);
  }
});

test("a card behind a redirect is followed when the fetch follows redirects", async () => {
  const app = new Hono();
  app.get("/mcp/server-card", (c) => c.redirect("/cards/weather.json", 301));
  app.get("/cards/weather.json", (c) => c.json(card));
  const follow: typeof fetch = async (input, init) => {
    let req = new Request(input, init);
    for (let i = 0; i < 5; i++) {
      const res = await app.fetch(req);
      const loc = res.headers.get("location");
      if (res.status < 300 || res.status >= 400 || !loc) return res;
      req = new Request(new URL(loc, req.url), { method: req.method, headers: req.headers });
    }
    throw new Error("too many redirects");
  };
  const r = await checkDiscovery({ mcpUrl: MCP }, { fetch: follow, validateCard: cardValidator() });
  assert.equal(status(r, "card.schema-valid"), "pass");
});
