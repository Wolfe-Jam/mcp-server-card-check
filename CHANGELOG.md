# Changelog

## Unreleased

Hostile-server tests (`test/width/`) found three bugs, each proven failing before its fix:

- **Fix: event streams split across lines.** A JSON-RPC message spread over several `data:` lines of one SSE event was read line by line and missed, so a correct server got a false failure. Events are now parsed per the event-stream format (data lines joined with a newline; comments and other fields ignored; CRLF, CR and LF line endings).
- **Fix: no size limit in the CLI and library.** Responses were read whole: a huge body used memory without limit, and an endless one hung the run. Every response is now read through a 1 MiB cap (the web checker's limit; `maxBytes` option). An oversized card fails `card.json` with "larger than … bytes".
- **Fix: deep nesting crashed the run.** The credential scan was recursive, so a card nested about 100,000 levels deep threw "Maximum call stack size exceeded" and produced no verdicts. It is now iterative.
- **Tests:** 12 hostile-server tests (timeouts, a 20 MB and an endless body, deep nesting, duplicate CORS headers, ETag edge cases, wrong Content-Type, BOM, `__proto__` keys, wrong JSON-RPC id and batches, redirects, multi-line SSE). 54 tests.

## 0.3.1 — 2026-10-14

- **Fix:** the `server/discover` request now sends the `Mcp-Method` header, which streamable-http § Protocol Version Header requires on every 2026-07-28 POST. Without it a conforming server answers 400 (-32020), and the checker fell back to `initialize` against servers that do support `server/discover`. The test fake server now rejects a missing header, as a conforming server does.
- **Tests:** three catalog fixtures close the coverage gaps found by an audit: `catalog.entries` and `catalog.card-entry` now have failing cases, and `catalog.links` a passing one. Every one of the 39 checks is now driven to both pass and fail, and asserted. 42 tests.

## 0.3.0 — 2026-10-14

Aligns the checker with the conformance proposal (modelcontextprotocol/conformance#550). 39 checks.

- **Consistency via `server/discover`**, falling back to `initialize` for legacy servers. The report says which answered. Protocol versions: every version the card lists must be in the server's `supportedVersions`.
- **New:** `consistency.name` (only when `serverInfo.name` is reverse-DNS), `consistency.description`, `card.version-semver` (SHOULD), `hosting.cors-methods` and `hosting.cors-headers` (MUST, read from the GET response).
- **Changed:** `hosting.cors-preflight` is now a SHOULD, labelled as browser behaviour (Fetch standard), not Server Card spec text. `consistency.title` and `.version` read "doesn't contradict".
- **Removed:** `card.remote-matches` (no spec sentence behind it; `consistency.transport` covers the endpoint's remote).
- **For `--json` consumers:** `hosting.cors-preflight` → `hosting.cors-methods` + `hosting.cors-headers` (+ the SHOULD preflight); `card.remote-matches` → `consistency.transport`.
- Census: `summarize.mjs` adds `json_cards_with_all_four_cors_on_get` and `json_cards_with_preflight_ok` for runs from this version; the 2026-10-12 summary still reproduces exactly.

## 0.2.0 — 2026-10-13

Compare the card with the live server: four consistency checks (discovery.md § Consistency with Runtime Behavior).

- **`consistency.transport`**, **`consistency.protocol-version`**, **`consistency.version`**, **`consistency.title`**, all SHOULD. With `--transport`, the checker sends one MCP `initialize` (JSON or event-stream response), closes the session, and compares the server's protocol version, `serverInfo.version` and `serverInfo.title` with the card's remote and fields. `name` is not compared (reverse-DNS on the card, a short name in `serverInfo`). Servers that need authorization are skipped.
- Read-only runs and the web checker skip the tier, as they do the transport checks. 35 checks in all.
- **`transport.origin-403` is a MUST only for local servers.** For a remote server it is a SHOULD, and a failure says the server may accept every origin by design. The spec leaves "invalid" `Origin` to the server, and the DNS-rebinding attack it guards against targets local servers. Remote servers that accept a foreign Origin no longer exit 1 for it.
- Spec links for the transport checks name the section correctly: Streamable HTTP § Security & Endpoint.

## 0.1.1 — 2026-10-12

Docs only: the README on npm now matches GitHub.

- The README opens with a TL;DR, a plain-English explanation, what you can do now (check in the browser, fail CI on a broken card, check a server before you trust it), and "Did you know?" findings from the 2026-10-12 census. The technical detail follows under "How it works".
- No change to the checks, the CLI or the library.

## 0.1.0 — 2026-10-12

First release: check an MCP server's Server Card (SEP-2127) and AI Catalog discovery against the spec, rule by rule, from the command line, from code, or in the browser.

- **31 checks** across the card, its hosting (CORS, caching, HTTPS), the AI Catalog and the transport. Each is MUST or SHOULD per the spec's wording and names its source: a section of `discovery.md` (ext-server-card@526201bb), a v1 schema field, the AI Catalog spec or SEP-2127.
- **CLI:** `server-card-check <mcp-url>` (also `mcp-server-card-check`), with `--json`, `--registry-name`, `--card-url`, `--catalog-url`, `--timeout`, `--transport`. Read-only by default: GET and OPTIONS only; the two POST checks run only with `--transport`. Exit 0 / 1 (a MUST fails) / 2 (usage, or unreachable).
- **Library:** `checkDiscovery` with an injectable `fetch`; `cardValidator` from `mcp-server-card-check/validate`.
- **Web checker** on workers.dev: the same checks, read-only, nothing to install.
- **Checks prompted by the 2026-10-12 census:**
  - `card.no-secrets` looks for credential values, not words.
  - `card.protocol-versions` flags strings that aren't released MCP versions.
  - `card.registry-name` compares the card's name with the registry entry (optional).
- **Census method and results** in `docs/reference.md`, with scripts that reproduce every figure.
