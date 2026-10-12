/**
 * card.no-secrets flags credential VALUES, not the words around them. The
 * 2026-10-12 census showed the old keyword rule failing cards whose
 * description merely said "api_key" or "Bearer token".
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { findCredential } from "../src/discovery.js";

const card = (extra: Record<string, unknown>) => ({ name: "com.example/x", version: "1.0.0", description: "x", ...extra });

test("prose that mentions credentials is not a credential", () => {
  for (const description of [
    "Requires an api_key header.",
    "Auth: Bearer token, obtained from the dashboard.",
    "Set your secret in the environment; password-free for read-only tools.",
    "Pass token: <your token> in the header.",
  ]) {
    assert.equal(findCredential(card({ description })), null, description);
  }
});

test("placeholders under secret-named keys are not credentials", () => {
  for (const v of ["{api_key}", "${API_KEY}", "<your-key>", "YOUR_API_KEY", "xxxx", "****", "", "changeme"]) {
    assert.equal(findCredential(card({ _meta: { "com.example/auth": { apiKey: v } } })), null, JSON.stringify(v));
  }
  const header = { name: "Authorization", value: "Bearer {token}", isSecret: true };
  assert.equal(findCredential(card({ remotes: [{ type: "streamable-http", url: "https://x.example/mcp", headers: [header] }] })), null);
});

test("a value under a secret-named key is a credential", () => {
  assert.match(findCredential(card({ _meta: { "com.example/auth": { apiKey: "sk-123" } } })) ?? "", /^apiKey: /);
  assert.match(findCredential(card({ _meta: { "com.example/a": { client_secret: "s3cr3t-value" } } })) ?? "", /client_secret/);
});

test("well-known token shapes are credentials wherever they appear", () => {
  const shapes = [
    "sk-" + "a".repeat(32),
    "ghp_" + "A".repeat(36),
    "github_pat_" + "B".repeat(40),
    "xoxb-1234567890-abcdef",
    "AKIA" + "ABCDEFGHIJKLMNOP",
    "AIza" + "C".repeat(35),
  ];
  for (const s of shapes) assert.notEqual(findCredential(card({ description: `see ${s}` })), null, s);
  // A generic bearer token counts where a header value would live, not in prose.
  assert.notEqual(findCredential(card({ _meta: { "com.example/a": { header: "Bearer " + "d".repeat(32) } } })), null);
  assert.equal(findCredential(card({ description: "Send Bearer " + "d".repeat(32) + " as shown in the docs" })), null);
});

test("a JWT is a credential after Bearer or under a secret-named key, not as a signed public artifact", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnop";
  assert.notEqual(findCredential(card({ _meta: { "com.example/a": { header: `Bearer ${jwt}` } } })), null);
  assert.notEqual(findCredential(card({ _meta: { "com.example/a": { token: jwt } } })), null);
  assert.equal(findCredential(card({ _meta: { "com.example/proof": { artifact: jwt } } })), null);
});

test("documentation fields, URLs, short values and ALL_CAPS names are not credentials", () => {
  const cases: Record<string, unknown>[] = [
    { remotes: [{ type: "streamable-http", url: "https://x.example/mcp", headers: [{ name: "Authorization", placeholder: "Bearer ACCESS_TOKEN_OR_API_KEY" }] }] },
    { remotes: [{ type: "streamable-http", url: "https://x.example/mcp", headers: [{ name: "Authorization", placeholder: "Bearer glpat-xxxxxxxxxxxxxxxxxxxx" }] }] },
    { _meta: { "com.example/a": { authorization: "Bearer <access token>; scopes: read" } } },
    { _meta: { "com.example/a": { apiKey: "m2m_..." } } },
    { _meta: { "com.example/a": { token: "https://auth.example.com/oauth/token" } } },
    { _meta: { "com.example/pay": { token: "USDT" } } },
    { _meta: { "com.example/a": { apiKey: "API_KEY_HERE" } } },
  ];
  for (const c of cases) assert.equal(findCredential(card(c)), null, JSON.stringify(c));
});

test("an isSecret input with a pre-set value is a credential", () => {
  const header = { name: "X-Key", value: "live-9f8e7d6c", isSecret: true };
  assert.equal(
    findCredential(card({ remotes: [{ type: "streamable-http", url: "https://x.example/mcp", headers: [header] }] })),
    "a pre-set value for an isSecret input",
  );
});
