/**
 * The discovery checker (src/discovery.ts), tested on
 * servers that get it wrong. Each fake server is a Hono app answered through
 * an injected `fetch`, so any host name works and nothing touches the network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import {
  AI_CATALOG_TYPE,
  SERVER_CARD_SCHEMA_URL,
  SERVER_CARD_TYPE,
  checkDiscovery,
  type DiscoveryReport,
} from "../src/discovery.js";
import { cardValidator } from "../src/validate.js";

const via = (app: Hono): typeof fetch => (input, init) => Promise.resolve(app.fetch(new Request(input, init)));
const offline: typeof fetch = () => Promise.reject(new Error("offline"));
const status = (r: DiscoveryReport, id: string) => r.results.find((x) => x.id === id)?.status;
const failed = (r: DiscoveryReport) => r.results.filter((x) => x.status === "fail").map((x) => x.id).sort();

const goodCard = (url: string) => ({
  $schema: SERVER_CARD_SCHEMA_URL,
  name: "com.example/weather",
  version: "2.0.0",
  description: "Weather for agents.",
  remotes: [{ type: "streamable-http", url }],
});

test("a server that only serves bare JSON fails the MUSTs and SHOULDs it misses", async () => {
  const app = new Hono();
  app.get("/mcp/server-card", (c) =>
    c.json({ $schema: "https://example.com/old.json", name: "weather", version: "", description: "x".repeat(101) }),
  );
  const r = await checkDiscovery({ mcpUrl: "https://wx.example.com/mcp" }, { fetch: via(app), validateCard: cardValidator() });
  assert.deepEqual(failed(r), [
    "card.description",
    "card.name",
    "card.schema-url",
    "card.schema-valid",
    "card.version",
    "hosting.cache-control",
    "hosting.content-type",
    "hosting.cors-expose",
    "hosting.cors-headers",
    "hosting.cors-methods",
    "hosting.cors-origin",
    "hosting.cors-preflight", // no OPTIONS handler: the preflight fails (a MUST: appropriate CORS)
    "hosting.etag",
    "transport.origin-403", // no /mcp at all: 404, not 403 (a SHOULD on a remote server)
  ]);
  assert.equal(r.mustFailures, 10); // cors-methods, cors-headers and cors-preflight are MUSTs read from the preflight
  assert.equal(status(r, "hosting.https"), "pass");
  assert.ok(r.results.filter((x) => x.tier === "catalog").every((x) => x.status === "skip"), "no catalog → skipped");
});

test("a correct hosted card over HTTPS passes, and plain HTTP off localhost fails", async () => {
  const app = new Hono();
  app.get("/mcp/server-card", (c) => {
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Access-Control-Allow-Methods", "GET");
    c.header("Access-Control-Allow-Headers", "Content-Type, If-None-Match");
    c.header("Access-Control-Expose-Headers", "ETag");
    c.header("Cache-Control", "public, max-age=3600");
    c.header("ETag", '"v1"');
    if (c.req.header("if-none-match") === '"v1"') return c.body(null, 304);
    c.header("Content-Type", SERVER_CARD_TYPE);
    return c.body(JSON.stringify(goodCard(new URL(c.req.url).origin + "/mcp")));
  });
  app.post("/mcp", async (c) => {
    if (c.req.header("origin")) return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Invalid Origin" }, id: null }, 403);
    const { id } = (await c.req.json()) as { id: number };
    return c.json({
      jsonrpc: "2.0",
      id,
      result: { supportedVersions: ["2025-11-25"], _meta: { "io.modelcontextprotocol/serverInfo": { name: "weather", version: "2.0.0" } } },
    });
  });
  app.options("/mcp/server-card", (c) => {
    c.header("Access-Control-Allow-Origin", "*");
    c.header("Access-Control-Allow-Methods", "GET");
    c.header("Access-Control-Allow-Headers", "Content-Type, If-None-Match");
    return c.body(null, 204);
  });
  const ok = await checkDiscovery({ mcpUrl: "https://wx.example.com/mcp" }, { fetch: via(app), validateCard: cardValidator() });
  assert.deepEqual(failed(ok), []);
  assert.equal(ok.cardUrl, "https://wx.example.com/mcp/server-card");

  const plain = await checkDiscovery({ mcpUrl: "http://wx.example.com/mcp" }, { fetch: via(app) });
  assert.deepEqual(failed(plain), ["hosting.https"]);
  assert.equal(status(plain, "card.schema-valid"), "skip"); // no validator supplied
});

test("a card that leaks a credential or a private endpoint fails", async () => {
  const app = new Hono();
  app.get("/mcp/server-card", (c) =>
    c.json({ ...goodCard("https://wx.example.com/mcp"), _meta: { "com.example/auth": { apiKey: "sk-123" } } }),
  );
  const leak = await checkDiscovery({ mcpUrl: "https://wx.example.com/mcp" }, { fetch: via(app) });
  assert.equal(status(leak, "card.no-secrets"), "fail");

  const priv = new Hono();
  priv.get("/mcp/server-card", (c) => c.json(goodCard("http://192.168.1.20/mcp")));
  const r = await checkDiscovery({ mcpUrl: "https://wx.example.com/mcp" }, { fetch: via(priv) });
  assert.equal(status(r, "card.no-secrets"), "fail");
});

test("a card found only inline in the catalog is checked; hosting is skipped", async () => {
  const app = new Hono();
  app.get("/.well-known/ai-catalog.json", (c) => {
    c.header("Content-Type", AI_CATALOG_TYPE);
    return c.body(
      JSON.stringify({
        specVersion: "1.0",
        entries: [{ identifier: "urn:air:example.com:mcp:weather", type: SERVER_CARD_TYPE, data: goodCard("https://elsewhere.example.com/mcp") }],
      }),
    );
  });
  const r = await checkDiscovery({ mcpUrl: "https://wx.example.com/mcp" }, { fetch: via(app), validateCard: cardValidator() });
  assert.equal(r.cardUrl, null);
  assert.equal(status(r, "card.found"), "pass");
  assert.equal(status(r, "card.schema-valid"), "pass");
  assert.equal(status(r, "consistency.transport"), "skip"); // declares a different endpoint
  assert.ok(r.results.filter((x) => x.tier === "hosting").every((x) => x.status === "skip"));
  assert.equal(status(r, "catalog.links"), "skip"); // inline only, nothing to resolve
});

test("the card is followed from the catalog when it is not at <mcp>/server-card", async () => {
  const app = new Hono();
  app.get("/cards/weather.json", (c) => c.json(goodCard("https://wx.example.com/mcp")));
  app.get("/.well-known/ai-catalog.json", (c) =>
    c.json({ specVersion: "1.0", entries: [{ identifier: "weather", type: SERVER_CARD_TYPE, url: "/cards/weather.json" }] }),
  );
  const r = await checkDiscovery({ mcpUrl: "https://wx.example.com/mcp" }, { fetch: via(app) });
  assert.equal(r.cardUrl, "https://wx.example.com/cards/weather.json");
  assert.equal(status(r, "card.version-semver"), "pass"); // "2.0.0"
  assert.equal(status(r, "catalog.identifiers"), "fail"); // "weather" is not urn:air:{domain}:…
  assert.equal(status(r, "catalog.content-type"), "fail"); // application/json
  assert.equal(status(r, "catalog.links"), "fail"); // served as application/json, entry declares the card type
});

test("a broken catalog fails each catalog requirement it misses", async () => {
  const app = new Hono();
  app.get("/.well-known/ai-catalog.json", (c) =>
    c.json({
      host: { identifier: "x" },
      entries: [
        { identifier: "urn:air:example.com:docs:a", type: "text/markdown", url: "/a.md", data: "both" },
        { type: "text/plain", url: "/b.txt", extensions: { "not a key": 1 } },
        { identifier: "urn:air:example.com:mcp:c", type: SERVER_CARD_TYPE, displayName: "C", url: "/nope" },
        "not an object",
      ],
    }),
  );
  const r = await checkDiscovery({ mcpUrl: "https://wx.example.com/mcp" }, { fetch: via(app) });
  for (const id of [
    "catalog.spec-version",
    "catalog.host",
    "catalog.entry-fields",
    "catalog.entry-one-of",
    "catalog.identifiers",
    "catalog.extensions",
    "catalog.card-entry-lean",
    "catalog.links",
    "card.found",
  ]) {
    assert.equal(status(r, id), "fail", id);
  }
  assert.equal(status(r, "catalog.card-entry"), "pass");
});

test("nothing published: the card is reported missing and the discovery checks skip", async () => {
  const r = await checkDiscovery({ mcpUrl: "https://wx.example.com/mcp" }, { fetch: via(new Hono()) });
  assert.deepEqual(failed(r), ["card.found", "transport.origin-403"]);
  assert.equal(r.mustFailures, 0); // where (and whether) a card is hosted is the spec's MAY; Origin is a SHOULD on a remote server
  assert.equal(r.passed, 0);

  const down = await checkDiscovery({ mcpUrl: "https://wx.example.com/mcp" }, { fetch: offline });
  assert.deepEqual(failed(down), ["card.found"]);
  assert.equal(down.results.find((x) => x.id === "transport.origin-403")!.status, "skip");
  assert.match(down.results.find((x) => x.id === "catalog.links")!.detail!, /unreachable/);
});

test("a body that is not JSON fails card.json and the catalog is skipped", async () => {
  const app = new Hono();
  app.get("/mcp/server-card", (c) => c.text("<html>"));
  app.get("/.well-known/ai-catalog.json", (c) => c.text("nope"));
  const r = await checkDiscovery({ mcpUrl: "https://wx.example.com/mcp" }, { fetch: via(app) });
  assert.equal(status(r, "card.found"), "pass");
  assert.equal(status(r, "card.json"), "fail");
  assert.match(r.results.find((x) => x.id === "catalog.spec-version")!.detail!, /not a JSON object/);
});

test("transport: a local server must refuse a forged Host; remote servers skip that check", async () => {
  const app = new Hono();
  app.post("/mcp", (c) => c.json({}, c.req.header("origin") ? 403 : 200));
  const run = (status: number | null) =>
    checkDiscovery({ mcpUrl: "http://127.0.0.1:3000/mcp" }, { fetch: via(app), rawStatus: async () => status });
  assert.equal(status(await run(403), "transport.rebinding"), "pass");
  assert.equal(status(await run(200), "transport.rebinding"), "fail");
  assert.equal(status(await run(null), "transport.rebinding"), "skip");
  assert.equal(status(await run(403), "transport.origin-403"), "pass");
  const remote = await checkDiscovery({ mcpUrl: "https://wx.example.com/mcp" }, { fetch: via(app) });
  assert.equal(status(remote, "transport.rebinding"), "skip");
});

test("the Origin check is a MUST on a local server and a SHOULD on a remote one", async () => {
  const app = new Hono();
  app.post("/mcp", (c) => c.json({ jsonrpc: "2.0", id: 1, result: {} })); // accepts every Origin
  const level = (r: DiscoveryReport) => r.results.find((x) => x.id === "transport.origin-403");
  const remote = level(await checkDiscovery({ mcpUrl: "https://wx.example.com/mcp" }, { fetch: via(app) }));
  assert.equal(remote?.level, "should");
  assert.equal(remote?.status, "fail");
  assert.match(remote?.detail ?? "", /accepts every origin by design/);
  const local = level(await checkDiscovery({ mcpUrl: "http://127.0.0.1:3000/mcp" }, { fetch: via(app), rawStatus: async () => 403 }));
  assert.equal(local?.level, "must");
  assert.equal(local?.status, "fail");
});

test("catalog.entries, catalog.card-entry and catalog.links: a correct catalog passes, broken ones fail", async () => {
  const URN = "urn:air:wx.example.com:mcp:weather";
  const serve = (entries: unknown) => {
    const app = new Hono();
    app.get("/mcp/server-card", (c) => {
      c.header("Content-Type", SERVER_CARD_TYPE);
      return c.body(JSON.stringify(goodCard("https://wx.example.com/mcp")));
    });
    app.get("/.well-known/ai-catalog.json", (c) => {
      c.header("Content-Type", AI_CATALOG_TYPE);
      return c.body(JSON.stringify({ specVersion: "1.0", entries }));
    });
    return app;
  };

  // A correct catalog: one card entry whose url resolves with the type it declares.
  const ok = await checkDiscovery({ mcpUrl: "https://wx.example.com/mcp" }, {
    fetch: via(serve([{ identifier: URN, type: SERVER_CARD_TYPE, url: "/mcp/server-card" }])),
  });
  assert.equal(status(ok, "catalog.entries"), "pass");
  assert.equal(status(ok, "catalog.card-entry"), "pass");
  assert.equal(status(ok, "catalog.links"), "pass");

  // entries is not an array: the MUST fails, and there is no card entry to find.
  const notArray = await checkDiscovery({ mcpUrl: "https://wx.example.com/mcp" }, {
    fetch: via(serve({ [URN]: { type: SERVER_CARD_TYPE, url: "/mcp/server-card" } })),
  });
  assert.equal(status(notArray, "catalog.entries"), "fail");
  assert.equal(status(notArray, "catalog.card-entry"), "fail");

  // A catalog that lists another artifact but not the Server Card.
  const noCard = await checkDiscovery({ mcpUrl: "https://wx.example.com/mcp" }, {
    fetch: via(serve([{ identifier: "urn:air:wx.example.com:a2a:weather", type: "application/a2a-agent-card+json", data: { name: "weather" } }])),
  });
  assert.equal(status(noCard, "catalog.entries"), "pass");
  assert.equal(status(noCard, "catalog.card-entry"), "fail");
  assert.equal(status(noCard, "catalog.links"), "skip"); // no entry has a url
});

test("CORS preflight: Allow-Methods / Allow-Headers / Allow-Origin are read from the preflight; * counts", async () => {
  const serve = (opts: { get?: boolean; pre?: "full" | "wildcard" | "no-origin" | "none"; preStatus?: number }) => {
    const app = new Hono();
    const allow = (c: { header: (k: string, v: string) => void }, wildcard = false) => {
      c.header("Access-Control-Allow-Methods", wildcard ? "*" : "GET");
      c.header("Access-Control-Allow-Headers", wildcard ? "*" : "Content-Type, If-None-Match");
    };
    app.get("/mcp/server-card", (c) => {
      c.header("Access-Control-Allow-Origin", "*");
      c.header("Access-Control-Expose-Headers", "ETag");
      if (opts.get) allow(c);
      return c.json(goodCard("https://wx.example.com/mcp"));
    });
    app.options("/mcp/server-card", (c) => {
      if (opts.pre !== "no-origin" && opts.pre !== "none") c.header("Access-Control-Allow-Origin", "*");
      if (opts.pre === "full" || opts.pre === "no-origin") allow(c);
      if (opts.pre === "wildcard") allow(c, true);
      return c.body(null, (opts.preStatus ?? 204) as 204);
    });
    return checkDiscovery({ mcpUrl: "https://wx.example.com/mcp" }, { fetch: via(app) });
  };
  const st = (r: Awaited<ReturnType<typeof checkDiscovery>>, id: string) => [status(r, id), r.results.find((x) => x.id === id)?.detail ?? ""] as const;

  // Correct CORS: the three on the preflight. 0.3.0–0.3.3 failed these servers.
  const ok = await serve({ pre: "full" });
  for (const id of ["hosting.cors-methods", "hosting.cors-headers", "hosting.cors-preflight"]) assert.equal(status(ok, id), "pass", id);

  // `*` is a wildcard for requests without credentials.
  const wild = await serve({ pre: "wildcard" });
  assert.equal(status(wild, "hosting.cors-methods"), "pass");
  assert.equal(status(wild, "hosting.cors-headers"), "pass");

  // On the GET only: browsers never read them there.
  const [m, md] = st(await serve({ get: true, pre: "none" }), "hosting.cors-methods");
  assert.equal(m, "fail");
  assert.match(md, /sent on the GET only/);

  // An Allow-Origin that echoes the request origin is valid CORS too.
  {
    const app = new Hono();
    app.get("/mcp/server-card", (c) => c.json(goodCard("https://wx.example.com/mcp")));
    app.options("/mcp/server-card", (c) => {
      c.header("Access-Control-Allow-Origin", c.req.header("origin") ?? "");
      c.header("Access-Control-Allow-Methods", "GET");
      c.header("Access-Control-Allow-Headers", "Content-Type, If-None-Match");
      return c.body(null, 204);
    });
    const echo = await checkDiscovery({ mcpUrl: "https://wx.example.com/mcp" }, { fetch: via(app) });
    assert.equal(status(echo, "hosting.cors-preflight"), "pass");
  }

  // A preflight without Allow-Origin, or with a non-2xx status, fails the preflight check.
  assert.equal(status(await serve({ pre: "no-origin" }), "hosting.cors-preflight"), "fail");
  assert.equal(status(await serve({ pre: "full", preStatus: 404 }), "hosting.cors-preflight"), "fail");
});
