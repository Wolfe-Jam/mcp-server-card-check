# Changelog

## Unreleased

Catalog checks re-read against the AI Catalog spec, after an independent review. Verdicts change.

- **`catalog.card-entry-lean` cites the AI Catalog spec** (§ Catalog Entry), not discovery.md. discovery.md's "an entry does not need to repeat" grants permission and has no keyword; the AI Catalog spec says `displayName`, `description` and `version` SHOULD be omitted when the card carries its own. So `displayName` is flagged only when the card has a `title`, and the detail says whether the entry *repeats* or *overrides* it. `version` isn't flagged when the catalog lists several versions of one identifier, where the spec makes it REQUIRED.
- **New `catalog.card-entry-version` (SHOULD):** a version on the card's entry equals the card's version. The spec calls a contradiction "a publishing error".
- **The entry checked is the one for this card**, not the first card entry in the catalog: its `url` matches the card checked (normalised, or after redirects), or it carries the same card inline (matched by `name`). When the card is found through a catalog that lists several servers, the card whose `remotes` include this endpoint is preferred.
- **Multi-version** means the same identifier with different versions (AI Catalog § Multi-Version Entries), not any repeat of the identifier. `card-entry-version` skips when the card has no version.
- **`catalog.card-entry` is retired.** No spec keyword makes listing the card a SHOULD; publishing a catalog is itself a MAY.
- **`catalog.extensions` is a MUST** ("the keys MUST be a valid URL or a reverse-DNS string") and covers the catalog's own `extensions` and each entry's Trust Manifest, not only entries'.
- **Fix: `catalog.identifiers`** accepts a namespace of several colon-separated categories (`urn:air:example.com:finance:agent:ledger`), as the spec allows.
- Every AI Catalog link is pinned to commit `9316f00` and points at its section; `catalog.links` now cites § Catalog Entry (`url`), where its rule is. SEP-2127 links are pinned too.
- Schema links point at the pinned `schema.json`: the `$schema` id cards must declare (`static.modelcontextprotocol.io/schemas/v1/server-card.schema.json`) isn't served yet (HTTP 404). `card.schema-url` is unchanged: the spec defines that id.
- A second independent review checked this change; its seven edge cases are now tests. Still 39 checks (one retired, one added). 80 tests.

## 0.4.0 — 2026-10-17

A browser entry, for extensions and Workers. No verdict changes.

- **`mcp-server-card-check/browser`:** the checker, `SPEC_REFS` (each check's spec link) and a precompiled `validateCard`, for browser extensions and Workers, where compiling the schema at run time isn't allowed. The web checker now uses the same validator, so there's one source. The generated validator moves from `worker/validator.cjs` to `src/validator-standalone.cjs` and ships in `dist`. Tests: the browser validator agrees with the library's, the entry has no static `node:` imports and no code generation, and a read-only run never sends POST. The pack smoke test loads the new entry. 74 tests.

## 0.3.4 — 2026-10-16

Width suite, parts 3 and 4: comparing versions on live endpoints, and parity (no parity bug found; the tests keep it that way).

- **Fix: the CORS checks read the preflight, as browsers do.** From 0.3.0, `hosting.cors-methods` and `hosting.cors-headers` read `Access-Control-Allow-Methods` and `Allow-Headers` only from the GET response; browsers read them only from the preflight, so servers whose browser access works failed a MUST. The first version comparison (0.1.1 → 0.3.3, 200 live endpoints) found 2 such servers. Now, read against the Fetch standard: Allow-Origin and Expose-Headers on the GET; Allow-Origin, Allow-Methods and Allow-Headers on the preflight. `*` counts as a wildcard. `hosting.cors-preflight` becomes a MUST again: the preflight must answer 2xx with `Access-Control-Allow-Origin` of `*` or the request's origin. A header sent on the GET only fails, and the detail says so. The census summary field is renamed `json_cards_with_all_four_cors` (no census has used it yet). The rule was reviewed independently in two rounds before release.
- **`npm run census:diff`** (`scripts/census/diff.mjs`): compare two published versions on the same live endpoints, read-only, each endpoint checked by both within the same minute. The report lists endpoints whose exit code changes, MUST ↔ SHOULD level changes, every changed verdict with examples, and the checks added or retired. Method in `docs/reference.md` § Comparing two versions.
- **Tests:** the web's precompiled validator and the library's agree on 11 valid and invalid cards; the CLI's `--json` verdicts equal the library's; the README's table, its "All N checks" count, `SPEC_REFS` and a full run name the same checks; every check cites an https spec source. 70 tests.
- **Coverage gate:** `npm run coverage:checks` runs the suite with an observer and fails unless every check is driven to both pass and fail and is asserted (39/39 today). CI runs it on ubuntu with Node 24. The core gains a no-op observer hook for it; it never changes a verdict.
- The web checker's `validateCard` is exported for the parity test.

## 0.3.3 — 2026-10-15

Width suite, parts 1 and 5: strict fake servers that record every client violation, and a guard on every URL the web checker fetches.

- **Fix: closing a 2025-11-25 session.** The `DELETE` that closes a session sent `Mcp-Session-Id` but not `MCP-Protocol-Version`, which 2025-11-25 transports require on every request after `initialize`. A strict server could reject it and leave the session open. The session is now closed after the reply is read, with the negotiated version. Found by the strict fakes on their first run (6 tests).
- **Web checker: every URL it fetches is guarded.** The public-hostname check (`targetError`) ran only on the URL the visitor typed. URLs the target supplied (catalog entry links, cards found through a catalog) and redirect hops were fetched without it, so a target could make the web checker send GET requests to any URL. Every outbound URL now passes the guard; redirects are followed by hand (at most 5), each hop re-checked. Workers can't reach private networks, so the practical risk was low; this closes it. 4 tests, proven by a mutation check (2 fail without the guard).
- **Tests:** 8 strict-server tests (`test/width/strict.test.ts`): a strict 2026-07-28 server (read only via `server/discover`), a strict 2025-11-25 server, every way a legacy server can answer `server/discover` (400, an HTML 404, 405, a 200 with an error, a result without `supportedVersions`), each falling back to `initialize` and closing its session, and a card claiming a version the server rejects. Each asserts the checker made no client violations. 62 tests. Plus 4 web-guard tests: 66 in all.

## 0.3.2 — 2026-10-14

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
