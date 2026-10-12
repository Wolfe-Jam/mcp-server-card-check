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
