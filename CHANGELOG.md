# Changelog

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
