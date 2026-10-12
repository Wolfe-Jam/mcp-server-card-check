/**
 * The CLI: arguments, exit codes, read-only by default, and spec references.
 * Fake servers answer through an injected fetch; nothing touches the network.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { Hono } from "hono";
import { run } from "../src/cli.js";
import { SERVER_CARD_SCHEMA_URL, SERVER_CARD_TYPE } from "../src/discovery.js";

const via = (app: Hono): typeof fetch => (input, init) => Promise.resolve(app.fetch(new Request(input, init)));
const URL_ = "https://wx.example.com/mcp";
const goodCard = { $schema: SERVER_CARD_SCHEMA_URL, name: "com.example/weather", version: "1.0.0", description: "Weather.",
  remotes: [{ type: "streamable-http", url: URL_ }] };

function server(card: unknown, onPost?: () => void) {
  const app = new Hono();
  app.get("/mcp/server-card", (c) => c.json(card, 200, { "Content-Type": SERVER_CARD_TYPE }));
  app.post("/mcp", (c) => { onPost?.(); return c.text("", 403); });
  return app;
}

test("--help and --version answer and exit 0", async () => {
  const h = await run(["--help"]);
  assert.equal(h.code, 0);
  assert.match(h.out, /Usage:/);
  const v = await run(["-V"]);
  assert.equal(v.code, 0);
  assert.match(v.out, /^server-card-check \d+\.\d+\.\d+$/);
});

test("usage errors exit 2", async () => {
  assert.equal((await run([])).code, 2);
  assert.equal((await run(["--nope", URL_])).code, 2);
  assert.equal((await run(["ftp://x.example/mcp"])).code, 2);
  assert.equal((await run([URL_, "--timeout", "-5"])).code, 2);
  assert.equal((await run([URL_, "--registry-name"])).code, 2);
});

test("read-only by default: no POST is sent without --transport", async () => {
  let posts = 0;
  const r = await run([URL_], via(server(goodCard, () => posts++)));
  assert.equal(posts, 0);
  assert.match(r.out, /read-only run/);
  await run([URL_, "--transport"], via(server(goodCard, () => posts++)));
  assert.ok(posts > 0);
});

test("exit 1 when a MUST fails, 0 when none do", async () => {
  const bad = await run([URL_], via(server({ ...goodCard, description: "" })));
  assert.equal(bad.code, 1);
  assert.match(bad.out, /✗ MUST/);
  const ok = await run([URL_, "--json"], via(server(goodCard)));
  const report = JSON.parse(ok.out);
  const mustFails = report.results.filter((x: any) => x.level === "must" && x.status === "fail").map((x: any) => x.id);
  assert.equal(ok.code, mustFails.length ? 1 : 0, `MUST failures: ${mustFails.join(", ")}`);
});

test("exit 2 when nothing answers", async () => {
  const r = await run([URL_], () => Promise.reject(new Error("offline")));
  assert.equal(r.code, 2);
  assert.match(r.out, /could not be reached/);
});

test("--json carries a spec reference for every check", async () => {
  const r = await run([URL_, "--json", "--registry-name", "com.example/weather"], via(server(goodCard)));
  const report = JSON.parse(r.out);
  for (const x of report.results) assert.ok(x.spec?.label && x.spec?.url, `no spec ref for ${x.id}`);
  assert.equal(report.results.find((x: any) => x.id === "card.registry-name").status, "pass");
});
