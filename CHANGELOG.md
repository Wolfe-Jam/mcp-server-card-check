# Changelog

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
