/**
 * The web checker fetches URLs visitors type in: only public http(s)
 * hostnames get through.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { targetError } from "../worker/index.js";

test("public http(s) hostnames are accepted", () => {
  for (const u of ["https://context.faf.one/mcp", "http://example.com/mcp", "https://a.b.example.co.uk/x/mcp"]) assert.equal(targetError(u), null, u);
});

test("IP literals, local names, other schemes and credentials are refused", () => {
  for (const u of [
    "http://127.0.0.1/mcp", "http://10.0.0.5/mcp", "http://169.254.169.254/latest", "http://[::1]/mcp",
    "http://localhost:3000/mcp", "https://printer.local/mcp", "https://db.internal/mcp", "http://intranet/mcp",
    "ftp://example.com/x", "file:///etc/passwd", "https://user:pw@example.com/mcp", "notaurl", null,
  ]) assert.notEqual(targetError(u as string | null), null, String(u));
});

// ── Every outbound URL passes the guard (width suite, part 5) ──────────────────
import { makeSafeFetch } from "../worker/index.js";

/** A fake network: answers each URL from a table, recording what was requested. */
function network(routes: Record<string, () => Response>) {
  const asked: string[] = [];
  const base: typeof fetch = async (input) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
    asked.push(url);
    const route = routes[url];
    return route ? route() : new Response("not found", { status: 404 });
  };
  return { fetch: makeSafeFetch(base), asked };
}

test("the web fetch refuses a URL the visitor didn't type but the target supplied (an IP, a local name)", async () => {
  for (const bad of ["http://169.254.169.254/latest/meta-data/", "http://10.0.0.5/card.json", "http://localhost:8080/x", "https://db.internal/x"]) {
    const net = network({ [bad]: () => new Response("secret") });
    await assert.rejects(net.fetch(bad), /refused/, bad);
    assert.deepEqual(net.asked, [], `${bad} must never be requested`);
  }
});

test("the web fetch re-checks every redirect hop and refuses one that leaves public hostnames", async () => {
  const net = network({
    "https://wx.example.com/mcp/server-card": () => new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest/meta-data/" } }),
  });
  await assert.rejects(net.fetch("https://wx.example.com/mcp/server-card"), /refused http:\/\/169\.254\.169\.254/);
  assert.deepEqual(net.asked, ["https://wx.example.com/mcp/server-card"], "the private hop is never requested");
});

test("the web fetch follows public redirects, and stops after five", async () => {
  const ok = network({
    "https://wx.example.com/mcp/server-card": () => new Response(null, { status: 301, headers: { location: "/cards/weather.json" } }),
    "https://wx.example.com/cards/weather.json": () => new Response('{"ok":true}', { headers: { "content-type": "application/json" } }),
  });
  assert.equal(await (await ok.fetch("https://wx.example.com/mcp/server-card")).text(), '{"ok":true}');

  const loop = network(Object.fromEntries(
    Array.from({ length: 10 }, (_, i) => [`https://wx.example.com/r${i}`, () => new Response(null, { status: 302, headers: { location: `/r${i + 1}` } })]),
  ));
  await assert.rejects(loop.fetch("https://wx.example.com/r0"), /more than 5 redirects/);
});

test("the web fetch stays read-only", async () => {
  const net = network({});
  await assert.rejects(net.fetch("https://wx.example.com/mcp", { method: "POST" }), /read-only/);
  assert.deepEqual(net.asked, []);
});
