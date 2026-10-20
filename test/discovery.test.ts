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
    "catalog.links",
    "card.found",
  ]) {
    assert.equal(status(r, id), "fail", id);
  }
  // no card was found, so there is nothing for the entry to repeat
  assert.equal(status(r, "catalog.card-entry-lean"), "skip");
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

test("catalog.entries and catalog.links: a correct catalog passes, broken ones fail", async () => {
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
  assert.equal(status(ok, "catalog.card-entry-lean"), "pass");
  assert.equal(status(ok, "catalog.links"), "pass");

  // entries is not an array: the MUST fails, and there is no entry for this card.
  const notArray = await checkDiscovery({ mcpUrl: "https://wx.example.com/mcp" }, {
    fetch: via(serve({ [URN]: { type: SERVER_CARD_TYPE, url: "/mcp/server-card" } })),
  });
  assert.equal(status(notArray, "catalog.entries"), "fail");
  assert.equal(status(notArray, "catalog.card-entry-lean"), "skip");

  // A catalog that lists another artifact but not the Server Card.
  const noCard = await checkDiscovery({ mcpUrl: "https://wx.example.com/mcp" }, {
    fetch: via(serve([{ identifier: "urn:air:wx.example.com:a2a:weather", type: "application/a2a-agent-card+json", data: { name: "weather" } }])),
  });
  assert.equal(status(noCard, "catalog.entries"), "pass");
  assert.equal(status(noCard, "catalog.card-entry-lean"), "skip"); // no entry points at this card
  assert.equal(status(noCard, "catalog.links"), "skip"); // no entry has a url
});

// AI Catalog § Catalog Entry (pinned 9316f00): displayName / description / version SHOULD be omitted
// when the card carries its own; version is REQUIRED for multi-version listings; a version that
// contradicts the card's is a publishing error.
test("card-entry-lean and card-entry-version follow the AI Catalog entry rules", async () => {
  const MCP = "https://wx.example.com/mcp";
  const URN = "urn:air:wx.example.com:mcp:weather";
  const run = async (entries: unknown[], card: Record<string, unknown> = goodCard(MCP)) => {
    const app = new Hono();
    app.get("/mcp/server-card", (c) => {
      c.header("Content-Type", SERVER_CARD_TYPE);
      return c.body(JSON.stringify(card));
    });
    app.get("/.well-known/ai-catalog.json", (c) => {
      c.header("Content-Type", AI_CATALOG_TYPE);
      return c.body(JSON.stringify({ specVersion: "1.0", entries }));
    });
    return checkDiscovery({ mcpUrl: MCP }, { fetch: via(app) });
  };
  const entry = (extra: Record<string, unknown> = {}) => ({ identifier: URN, type: SERVER_CARD_TYPE, url: "/mcp/server-card", ...extra });
  const detail = (r: DiscoveryReport, id: string) => r.results.find((x) => x.id === id)?.detail ?? "";
  const titled = { ...goodCard(MCP), title: "Weather" };

  // displayName: flagged only when the card has a title; the detail says repeat vs override
  let r = await run([entry({ displayName: "Weather" })], titled);
  assert.equal(status(r, "catalog.card-entry-lean"), "fail");
  assert.match(detail(r, "catalog.card-entry-lean"), /displayName repeats the card's title/);
  r = await run([entry({ displayName: "Forecasts" })], titled);
  assert.match(detail(r, "catalog.card-entry-lean"), /displayName overrides the card's title/);
  r = await run([entry({ displayName: "Weather" })]); // card without a title: displayName is how it gets a name
  assert.equal(status(r, "catalog.card-entry-lean"), "pass");

  // description repeats the card's description
  r = await run([entry({ description: "Weather for agents." })]);
  assert.equal(status(r, "catalog.card-entry-lean"), "fail");

  // version: SHOULD be omitted for a single entry, REQUIRED (so not flagged) for several versions
  r = await run([entry({ version: "2.0.0" })]);
  assert.equal(status(r, "catalog.card-entry-lean"), "fail");
  assert.equal(status(r, "catalog.card-entry-version"), "pass");
  r = await run([entry({ version: "2.0.0" }), { identifier: URN, type: SERVER_CARD_TYPE, url: "/old/server-card", version: "1.0.0" }]);
  assert.equal(status(r, "catalog.card-entry-lean"), "pass");
  assert.equal(status(r, "catalog.card-entry-version"), "pass");

  // a version that contradicts the card's is a publishing error
  r = await run([entry({ version: "1.9.0" }), { identifier: URN, type: SERVER_CARD_TYPE, url: "/old/server-card", version: "1.0.0" }]);
  assert.equal(status(r, "catalog.card-entry-version"), "fail");
  assert.match(detail(r, "catalog.card-entry-version"), /"1.9.0".*"2.0.0"/);
  r = await run([entry()]);
  assert.equal(status(r, "catalog.card-entry-version"), "skip");

  // the entry checked is the one for THIS card, not simply the first card entry
  r = await run([
    { identifier: "urn:air:wx.example.com:mcp:other", type: SERVER_CARD_TYPE, url: "/other/server-card", displayName: "Other" },
    entry(),
  ], titled);
  assert.equal(status(r, "catalog.card-entry-lean"), "pass");
});

test("identifiers: the urn:air namespace can have several colon-separated categories", async () => {
  const app = new Hono();
  app.get("/.well-known/ai-catalog.json", (c) => {
    c.header("Content-Type", AI_CATALOG_TYPE);
    return c.body(JSON.stringify({ specVersion: "1.0", entries: [
      { identifier: "urn:air:example.com:finance:agent:ledger", type: "text/plain", data: "x" },
      { identifier: "urn:air:example.com:mcp:weather", type: "text/plain", data: "y" },
    ] }));
  });
  const ok = await checkDiscovery({ mcpUrl: "https://example.com/mcp" }, { fetch: via(app) });
  assert.equal(status(ok, "catalog.identifiers"), "pass");
});

test("extensions: keys are checked on the catalog itself as well as on entries, as a MUST", async () => {
  const app = new Hono();
  app.get("/.well-known/ai-catalog.json", (c) => {
    c.header("Content-Type", AI_CATALOG_TYPE);
    return c.body(JSON.stringify({ specVersion: "1.0", extensions: { "not a key": 1 }, entries: [] }));
  });
  const r = await checkDiscovery({ mcpUrl: "https://example.com/mcp" }, { fetch: via(app) });
  const ext = r.results.find((x) => x.id === "catalog.extensions");
  assert.equal(ext?.status, "fail");
  assert.equal(ext?.level, "must");
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

  // An echoed origin on the GET fails cors-origin, and the detail says why (public caching).
  {
    const app = new Hono();
    app.get("/mcp/server-card", (c) => {
      c.header("Access-Control-Allow-Origin", c.req.header("origin") ?? "null");
      return c.json(goodCard("https://wx.example.com/mcp"));
    });
    const r = await checkDiscovery({ mcpUrl: "https://wx.example.com/mcp" }, { fetch: via(app) });
    assert.match(r.results.find((x) => x.id === "hosting.cors-origin")?.detail ?? "", /publicly cacheable/);
  }

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
  const p404 = await serve({ pre: "full", preStatus: 404 });
  assert.equal(status(p404, "hosting.cors-preflight"), "fail");
  // One defect (no preflight) shows its cause in each failing check, not a confusing header list.
  assert.equal(st(p404, "hosting.cors-methods")[1], "no preflight response (HTTP 404)");
  assert.equal(st(p404, "hosting.cors-headers")[1], "no preflight response (HTTP 404)");

  // cors-methods on the GET only: a spec requirement, not a browser block (GET is CORS-safelisted).
  assert.match(md, /GET itself is CORS-safelisted/);
});

// Review round 2 probes (A, A2, C, D, E, F, G) and Trust Manifest extensions.
test("round-2 probes: the entry for this card is found however its URL is written", async () => {
  const URN = "urn:air:wx.example.com:mcp:weather";
  const card = (url: string, extra: Record<string, unknown> = {}) => ({ ...goodCard(url), title: "Weather", ...extra });
  const site = (entries: unknown[], opts: { hosted?: boolean; extraRoutes?: (app: Hono) => void; cardFor?: string } = {}) => {
    const app = new Hono();
    if (opts.hosted !== false) app.get("/mcp/server-card", (c) => { c.header("Content-Type", SERVER_CARD_TYPE); return c.body(JSON.stringify(card(opts.cardFor ?? "https://wx.example.com/mcp"))); });
    app.get("/.well-known/ai-catalog.json", (c) => { c.header("Content-Type", AI_CATALOG_TYPE); return c.body(JSON.stringify({ specVersion: "1.0", entries })); });
    opts.extraRoutes?.(app);
    return app;
  };
  // a fetch that follows redirects and reports the final URL, as a real fetch does
  const following = (app: Hono): typeof fetch => async (input, init) => {
    let req = new Request(input, init);
    for (let i = 0; i < 5; i++) {
      const res = await app.fetch(req);
      const loc = res.headers.get("location");
      if (res.status < 300 || res.status >= 400 || !loc) { Object.defineProperty(res, "url", { value: req.url }); return res; }
      req = new Request(new URL(loc, req.url), { method: req.method, headers: req.headers });
    }
    throw new Error("too many redirects");
  };
  const lean = (r: DiscoveryReport) => r.results.find((x) => x.id === "catalog.card-entry-lean");
  const withName = { identifier: URN, type: SERVER_CARD_TYPE, url: "/mcp/server-card", displayName: "Weather" };

  // A / A2: the endpoint is written with :443 or an uppercase host
  for (const mcpUrl of ["https://wx.example.com:443/mcp", "https://WX.example.com/mcp"]) {
    const r = await checkDiscovery({ mcpUrl }, { fetch: via(site([withName])) });
    assert.equal(lean(r)?.status, "fail", mcpUrl); // matched, and the repeated title is reported
  }

  // C: the entry's url redirects to the card
  const redirected = site([{ ...withName, url: "/old/server-card" }], {
    extraRoutes: (app) => app.get("/old/server-card", (c) => c.redirect("/mcp/server-card", 301)),
  });
  assert.equal(lean(await checkDiscovery({ mcpUrl: "https://wx.example.com/mcp" }, { fetch: following(redirected) }))?.status, "fail");

  // D: the card is hosted AND the entry carries the same card inline
  const inline = site([{ identifier: URN, type: SERVER_CARD_TYPE, data: card("https://wx.example.com/mcp"), displayName: "Weather" }]);
  assert.equal(lean(await checkDiscovery({ mcpUrl: "https://wx.example.com/mcp" }, { fetch: via(inline) }))?.status, "fail");

  // E: no hosted card; the catalog lists another server's card first
  const two = site([
    { identifier: "urn:air:wx.example.com:mcp:other", type: SERVER_CARD_TYPE, url: "/other/server-card" },
    { identifier: URN, type: SERVER_CARD_TYPE, url: "/cards/weather", version: "9.9.9" },
  ], {
    hosted: false,
    extraRoutes: (app) => {
      app.get("/other/server-card", (c) => { c.header("Content-Type", SERVER_CARD_TYPE); return c.body(JSON.stringify(card("https://wx.example.com/other-mcp", { name: "com.example/other" }))); });
      app.get("/cards/weather", (c) => { c.header("Content-Type", SERVER_CARD_TYPE); return c.body(JSON.stringify(card("https://wx.example.com/mcp"))); });
    },
  });
  const e = await checkDiscovery({ mcpUrl: "https://wx.example.com/mcp" }, { fetch: via(two) });
  assert.equal(e.results.find((x) => x.id === "catalog.card-entry-version")?.status, "fail"); // this server's entry (9.9.9 vs 2.0.0) is the one checked
  assert.equal(e.results.find((x) => x.id === "card.name")?.status, "pass");
});

test("round-2 probes: multi-version means different versions; a card with no version is skipped", async () => {
  const URN = "urn:air:wx.example.com:mcp:weather";
  const serve = (entries: unknown[], cardExtra: Record<string, unknown> = {}) => {
    const app = new Hono();
    app.get("/mcp/server-card", (c) => { c.header("Content-Type", SERVER_CARD_TYPE); return c.body(JSON.stringify({ ...goodCard("https://wx.example.com/mcp"), ...cardExtra })); });
    app.get("/.well-known/ai-catalog.json", (c) => { c.header("Content-Type", AI_CATALOG_TYPE); return c.body(JSON.stringify({ specVersion: "1.0", entries })); });
    return checkDiscovery({ mcpUrl: "https://wx.example.com/mcp" }, { fetch: via(app) });
  };
  // F: same identifier, another type, no version → not a multi-version listing: version is still flagged
  const f = await serve([
    { identifier: URN, type: SERVER_CARD_TYPE, url: "/mcp/server-card", version: "2.0.0" },
    { identifier: URN, type: "application/a2a-agent-card+json", data: { name: "weather" } },
  ]);
  assert.equal(f.results.find((x) => x.id === "catalog.card-entry-lean")?.status, "fail");
  // G: the card has no version → the version comparison is skipped, not failed
  const g = await serve([{ identifier: URN, type: SERVER_CARD_TYPE, url: "/mcp/server-card", version: "2.0.0" }], { version: undefined });
  const v = g.results.find((x) => x.id === "catalog.card-entry-version");
  assert.equal(v?.status, "skip");
  assert.match(v?.detail ?? "", /card has no version/);
});

test("extensions keys on a Trust Manifest are checked too", async () => {
  const app = new Hono();
  app.get("/.well-known/ai-catalog.json", (c) => {
    c.header("Content-Type", AI_CATALOG_TYPE);
    return c.body(JSON.stringify({ specVersion: "1.0", entries: [
      { identifier: "urn:air:example.com:docs:a", type: "text/plain", data: "x", trustManifest: { extensions: { "bad key": 1 } } },
    ] }));
  });
  const r = await checkDiscovery({ mcpUrl: "https://example.com/mcp" }, { fetch: via(app) });
  assert.equal(r.results.find((x) => x.id === "catalog.extensions")?.status, "fail");
});

// AI Catalog § Multi-Version Entries: identifier (+ version when given) MUST be unique.
test("catalog.entry-unique: identifiers, and identifier + version, are unique", async () => {
  const run = async (entries: unknown[]) => {
    const app = new Hono();
    app.get("/.well-known/ai-catalog.json", (c) => { c.header("Content-Type", AI_CATALOG_TYPE); return c.body(JSON.stringify({ specVersion: "1.0", entries })); });
    const r = await checkDiscovery({ mcpUrl: "https://example.com/mcp" }, { fetch: via(app) });
    return r.results.find((x) => x.id === "catalog.entry-unique")!;
  };
  const e = (identifier: string, version?: string) => ({ identifier, type: "text/plain", data: "x", ...(version ? { version } : {}) });
  assert.equal((await run([e("urn:air:example.com:docs:a"), e("urn:air:example.com:docs:b")])).status, "pass");
  assert.equal((await run([e("urn:air:example.com:docs:a", "1.0.0"), e("urn:air:example.com:docs:a", "2.0.0")])).status, "pass"); // a version history
  const dupId = await run([e("urn:air:example.com:docs:a"), e("urn:air:example.com:docs:a")]);
  assert.equal(dupId.status, "fail");
  assert.equal(dupId.level, "must");
  assert.match(dupId.detail ?? "", /urn:air:example\.com:docs:a ×2/);
  assert.equal((await run([e("urn:air:example.com:docs:a", "1.0.0"), e("urn:air:example.com:docs:a", "1.0.0")])).status, "fail");
  const mixed = await run([e("urn:air:example.com:docs:a", "1.0.0"), e("urn:air:example.com:docs:a")]);
  assert.equal(mixed.status, "fail");
  assert.match(mixed.detail ?? "", /with and without a version/);
});
