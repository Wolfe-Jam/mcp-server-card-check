# Server Card Check

An independent checker for MCP Server Cards (SEP-2127). Paste a server's URL and see, rule by rule, what passes and what to fix.

**[Try it online](https://servercard.wolfejam.dev)** · [What it checks](#what-it-checks) · [Census](docs/reference.md)

```sh
npx mcp-server-card-check https://your-server.example.com/mcp
```

![The checker run against a live MCP server: card, hosting, catalog, transport and consistency checks, each marked MUST or SHOULD](https://raw.githubusercontent.com/Wolfe-Jam/mcp-server-card-check/main/docs/demo.gif)

A **Server Card** is a small public file that tells MCP clients who a server is and how to connect, before they connect. [SEP-2127](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2127) made it Final on 2026-10-06. Every result here says MUST or SHOULD, pass or fail, why, and which section of the spec it comes from.

## What you can do

- **Check your server in the browser** at [servercard.wolfejam.dev](https://servercard.wolfejam.dev). Usually a few seconds; nothing to install.
- **Fail the build on a broken card:** add `npx mcp-server-card-check https://your-server/mcp` to CI. It exits 1 on any MUST failure.
- **Check a server before you trust it:** run it on someone else's endpoint before adding it to your client or catalog.
- **Compare the card with the live server:** add `--transport` to connect once and check that the server says what its card says.

## Did you know?

From a [census of every MCP Registry remote server](docs/reference.md) on 2026-10-12, six days after the spec merged:

- About **2%** publish a valid Server Card so far.
- **637 of the 3,609** endpoints that answer at `/server-card` return a web page, not a card. A 200 isn't a card.
- Only **6%** of cards send all the CORS headers browsers need to cache and refresh them.
- A card can pass the schema and still be wrong: invented protocol versions, or a name that doesn't match its registry entry. The schema doesn't catch either; this checker does.

## Use it

| How | Command |
|---|---|
| Once, no install | `npx mcp-server-card-check <mcp-url>` |
| In CI | `npx mcp-server-card-check <mcp-url> --json` (exit code 1 on any MUST failure) |
| Against the live server | `npx mcp-server-card-check <mcp-url> --transport` (connects once: the transport and consistency checks) |
| With your registry name | `npx mcp-server-card-check <mcp-url> --registry-name com.example/weather` |
| In the browser | **[servercard.wolfejam.dev](https://servercard.wolfejam.dev)**: the same checks, read-only, nothing to install |

**Read-only by default.** It sends GET and OPTIONS requests only. The two transport checks (a foreign `Origin` is refused; a local server refuses a foreign `Host`) and the six consistency checks send a POST, so they run only with `--transport`.

Options: `--json` · `--registry-name NAME` · `--card-url URL` · `--catalog-url URL` · `--timeout MS` (default 10000) · `--transport` · `-V` / `--version` · `-h` / `--help`.

Exit codes: **0** no MUST failures · **1** at least one MUST failure · **2** usage error, or nothing answered.

Node 22 or later. The package installs two commands, `server-card-check` and `mcp-server-card-check`; they are the same tool.

**Example output** (abridged):

```
server-card-check 0.3.3 · https://your-server.example.com/mcp
card: https://your-server.example.com/mcp/server-card · catalog: https://your-server.example.com/.well-known/ai-catalog.json

CARD
  ✓ MUST   The card validates against the v1 JSON Schema
  ✗ SHOULD supportedProtocolVersions lists released MCP protocol versions
           not MCP versions: 2025-03-12 (released: 2024-11-05, 2025-03-26, 2025-06-18, 2025-11-25, 2026-07-28)
           v1 schema: remotes[].supportedProtocolVersions + MCP released versions

HOSTING
  ✗ MUST   CORS: ETag is exposed
           got ""
           discovery.md § CORS Requirements
  …

29 passed · 2 failed · 8 skipped · 1 MUST failure
```



## As a library

```ts
import { checkDiscovery } from "mcp-server-card-check";
import { cardValidator } from "mcp-server-card-check/validate";

const report = await checkDiscovery(
  { mcpUrl: "https://your-server.example.com/mcp", registryName: "com.example/weather" },
  { validateCard: cardValidator() },
);
console.log(report.mustFailures, report.results);
```

`checkDiscovery` takes an optional `fetch`, so tests and other runtimes can supply their own.

## What it checks

The card is validated against the v1 Server Card schema at [ext-server-card@526201bb](https://github.com/modelcontextprotocol/ext-server-card/tree/526201bbc80231daa40ffcdecfc9da4e54e5dc93), the snapshot SEP-2127 pins. Levels follow the spec's wording; where the spec is soft, the check is a SHOULD.

<details>
<summary><b>All 39 checks</b>, each with its level and the spec section it comes from</summary>

| Check | Level | What | Source |
|---|---|---|---|
| `card.found` | SHOULD | A Server Card is published (hosted or in the catalog) | [discovery.md § Hosted Server Card Location](https://github.com/modelcontextprotocol/ext-server-card/blob/526201bbc80231daa40ffcdecfc9da4e54e5dc93/docs/discovery.md#hosted-server-card-location) |
| `card.json` | MUST | The card is a JSON object | [discovery.md § MCP Server Cards](https://github.com/modelcontextprotocol/ext-server-card/blob/526201bbc80231daa40ffcdecfc9da4e54e5dc93/docs/discovery.md#mcp-server-cards) |
| `card.schema-url` | MUST | $schema is the v1 Server Card schema URL | [v1 schema: $schema](https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json) |
| `card.name` | MUST | name is reverse-DNS with one slash | [v1 schema: name](https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json) |
| `card.registry-name` | SHOULD | name matches the server's MCP Registry name | [SEP-2127 § Relationship to the MCP Registry's server.json](https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2127-mcp-server-cards.md#relationship-to-the-mcp-registrys-serverjson) |
| `card.version` | MUST | version is present | [v1 schema: version](https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json) |
| `card.version-semver` | SHOULD | version follows semantic versioning | [v1 schema: version (SHOULD follow semantic versioning)](https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json) |
| `card.description` | MUST | description is 1–100 characters | [v1 schema: description](https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json) |
| `card.schema-valid` | MUST | The card validates against the v1 JSON Schema | [v1 schema: ServerCard](https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json) |
| `card.no-secrets` | MUST | No credentials or private endpoints in the card | [discovery.md § Information Disclosure](https://github.com/modelcontextprotocol/ext-server-card/blob/526201bbc80231daa40ffcdecfc9da4e54e5dc93/docs/discovery.md#information-disclosure) |
| `card.protocol-versions` | SHOULD | supportedProtocolVersions lists released MCP protocol versions | [v1 schema: remotes[].supportedProtocolVersions + MCP released versions](https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json) |
| `hosting.content-type` | SHOULD | Served as application/mcp-server-card+json | [discovery.md § Hosted Server Card Location](https://github.com/modelcontextprotocol/ext-server-card/blob/526201bbc80231daa40ffcdecfc9da4e54e5dc93/docs/discovery.md#hosted-server-card-location) |
| `hosting.cors-origin` | MUST | CORS: Access-Control-Allow-Origin is * | [discovery.md § CORS Requirements](https://github.com/modelcontextprotocol/ext-server-card/blob/526201bbc80231daa40ffcdecfc9da4e54e5dc93/docs/discovery.md#cors-requirements) |
| `hosting.cors-methods` | MUST | CORS: Access-Control-Allow-Methods includes GET | [discovery.md § CORS Requirements](https://github.com/modelcontextprotocol/ext-server-card/blob/526201bbc80231daa40ffcdecfc9da4e54e5dc93/docs/discovery.md#cors-requirements) |
| `hosting.cors-headers` | MUST | CORS: Access-Control-Allow-Headers includes Content-Type and If-None-Match | [discovery.md § CORS Requirements](https://github.com/modelcontextprotocol/ext-server-card/blob/526201bbc80231daa40ffcdecfc9da4e54e5dc93/docs/discovery.md#cors-requirements) |
| `hosting.cors-expose` | MUST | CORS: ETag is exposed | [discovery.md § CORS Requirements](https://github.com/modelcontextprotocol/ext-server-card/blob/526201bbc80231daa40ffcdecfc9da4e54e5dc93/docs/discovery.md#cors-requirements) |
| `hosting.cors-preflight` | SHOULD | Browser preflight allows GET with If-None-Match | [Fetch standard § CORS preflight (browser behaviour, not Server Card spec text)](https://fetch.spec.whatwg.org/#cors-preflight-fetch) |
| `hosting.cache-control` | SHOULD | Cache-Control is public with a max-age | [discovery.md § Caching](https://github.com/modelcontextprotocol/ext-server-card/blob/526201bbc80231daa40ffcdecfc9da4e54e5dc93/docs/discovery.md#caching) |
| `hosting.etag` | SHOULD | An ETag is returned and If-None-Match gets 304 | [discovery.md § Caching](https://github.com/modelcontextprotocol/ext-server-card/blob/526201bbc80231daa40ffcdecfc9da4e54e5dc93/docs/discovery.md#caching) |
| `hosting.https` | MUST | Served over HTTPS (HTTP only for local development) | [discovery.md § Transport Security](https://github.com/modelcontextprotocol/ext-server-card/blob/526201bbc80231daa40ffcdecfc9da4e54e5dc93/docs/discovery.md#transport-security) |
| `catalog.content-type` | SHOULD | Served as application/ai-catalog+json | [discovery.md § Well-Known URI](https://github.com/modelcontextprotocol/ext-server-card/blob/526201bbc80231daa40ffcdecfc9da4e54e5dc93/docs/discovery.md#well-known-uri) |
| `catalog.spec-version` | MUST | specVersion is present | [AI Catalog spec: specVersion](https://github.com/Agent-Card/ai-catalog/blob/main/specification/ai-catalog.md) |
| `catalog.entries` | MUST | entries is an array | [AI Catalog spec: entries](https://github.com/Agent-Card/ai-catalog/blob/main/specification/ai-catalog.md) |
| `catalog.host` | MUST | host.displayName is present when host is | [AI Catalog spec: host](https://github.com/Agent-Card/ai-catalog/blob/main/specification/ai-catalog.md) |
| `catalog.entry-fields` | MUST | Every entry has identifier and type | [AI Catalog spec: Catalog Entry](https://github.com/Agent-Card/ai-catalog/blob/main/specification/ai-catalog.md) |
| `catalog.entry-one-of` | MUST | Every entry has exactly one of url or data | [AI Catalog spec: url or data](https://github.com/Agent-Card/ai-catalog/blob/main/specification/ai-catalog.md) |
| `catalog.identifiers` | SHOULD | Identifiers use urn:air:{publisher-domain}:{namespace}:{name} | [AI Catalog spec: identifier](https://github.com/Agent-Card/ai-catalog/blob/main/specification/ai-catalog.md) |
| `catalog.extensions` | SHOULD | Custom data sits in extensions under URL or reverse-DNS keys | [AI Catalog spec: extensions](https://github.com/Agent-Card/ai-catalog/blob/main/specification/ai-catalog.md) |
| `catalog.card-entry` | SHOULD | The catalog lists the Server Card | [discovery.md § Server Card Entries](https://github.com/modelcontextprotocol/ext-server-card/blob/526201bbc80231daa40ffcdecfc9da4e54e5dc93/docs/discovery.md#server-card-entries) |
| `catalog.card-entry-lean` | SHOULD | The card entry repeats no displayName, description or version | [discovery.md § Server Card Entries](https://github.com/modelcontextprotocol/ext-server-card/blob/526201bbc80231daa40ffcdecfc9da4e54e5dc93/docs/discovery.md#server-card-entries) |
| `catalog.links` | SHOULD | Every entry URL resolves with the type its entry declares | [AI Catalog spec: links](https://github.com/Agent-Card/ai-catalog/blob/main/specification/ai-catalog.md) |
| `transport.origin-403` | MUST (local) · SHOULD (remote) | A foreign Origin is refused with 403 | [MCP Streamable HTTP § Security & Endpoint (Origin)](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports) |
| `transport.rebinding` | SHOULD | A local server refuses a foreign Host (DNS rebinding) | [MCP Streamable HTTP § Security & Endpoint (DNS rebinding)](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports) |
| `consistency.transport` | SHOULD | The card's remote for this endpoint says streamable-http, and it answers as one | [discovery.md § Consistency with Runtime Behavior](https://github.com/modelcontextprotocol/ext-server-card/blob/526201bbc80231daa40ffcdecfc9da4e54e5dc93/docs/discovery.md#consistency-with-runtime-behavior) |
| `consistency.protocol-version` | SHOULD | The card's protocol versions don't contradict the server's | [discovery.md § Consistency with Runtime Behavior](https://github.com/modelcontextprotocol/ext-server-card/blob/526201bbc80231daa40ffcdecfc9da4e54e5dc93/docs/discovery.md#consistency-with-runtime-behavior) |
| `consistency.version` | SHOULD | The card's version doesn't contradict the server's | [discovery.md § Consistency with Runtime Behavior](https://github.com/modelcontextprotocol/ext-server-card/blob/526201bbc80231daa40ffcdecfc9da4e54e5dc93/docs/discovery.md#consistency-with-runtime-behavior) |
| `consistency.name` | SHOULD | The card's name doesn't contradict a reverse-DNS serverInfo.name | [discovery.md § Consistency with Runtime Behavior](https://github.com/modelcontextprotocol/ext-server-card/blob/526201bbc80231daa40ffcdecfc9da4e54e5dc93/docs/discovery.md#consistency-with-runtime-behavior) |
| `consistency.title` | SHOULD | The card's title doesn't contradict the server's | [discovery.md § Consistency with Runtime Behavior](https://github.com/modelcontextprotocol/ext-server-card/blob/526201bbc80231daa40ffcdecfc9da4e54e5dc93/docs/discovery.md#consistency-with-runtime-behavior) |
| `consistency.description` | SHOULD | The card's description doesn't contradict the server's | [discovery.md § Consistency with Runtime Behavior](https://github.com/modelcontextprotocol/ext-server-card/blob/526201bbc80231daa40ffcdecfc9da4e54e5dc93/docs/discovery.md#consistency-with-runtime-behavior) |

</details>

Notes on six checks:

- **`card.no-secrets`** looks for credential *values*: a value under a secret-named key, known token shapes, `Bearer <token>` where a header value would go, a pre-set value on an `isSecret` input. Placeholders (`{token}`, `<key>`, `YOUR_API_KEY`, `xxxx`) and prose that mentions auth pass.
- **`card.protocol-versions`** fails values that are not dates, and dates on or before the newest released MCP version that were never released. Newer dates pass, so a future MCP release doesn't make the checker wrong.
- **`consistency.*`** connect once: `server/discover` (the 2026-07-28 spec says servers MUST implement it), or `initialize` for a legacy server; any session is closed afterwards. They check that the card doesn't contradict what the server says once connected, as discovery.md asks ("SHOULD NOT contradict"). The report says which method answered. `name` is compared only when `serverInfo.name` is itself reverse-DNS: a short name can't contradict the card's. A server that needs authorization (401/403) is skipped, not failed.
- **`hosting.cors-*`**: discovery.md lists four headers hosted cards MUST include; all four are read from the GET response. `hosting.cors-preflight` is a SHOULD of our own: a browser that sends `If-None-Match` from script makes a preflight first (it isn't a CORS-safelisted header), in every browser, so a failing preflight breaks revalidation even when the GET headers are right.
- **`transport.origin-403`** is a MUST for a local server and a SHOULD for a remote one. The spec says servers MUST answer an "invalid" `Origin` with 403 to prevent DNS rebinding, but leaves "invalid" to the server, and the attack it names is on local servers. A public server can accept every origin by design.
- **`card.registry-name`** runs only with `--registry-name`. SEP-2127 says cards and the registry's `server.json` "use compatible metadata where practical", identity included.

## Census

[`docs/reference.md`](docs/reference.md) records a read-only census of every MCP Registry remote server, run with this checker on 2026-10-12, and how to repeat it.

## Contributing

Think a verdict is wrong? [Open a "Wrong verdict" issue](https://github.com/Wolfe-Jam/mcp-server-card-check/issues/new?template=wrong-verdict.yml) with the URL and the check. The spec text decides. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

MIT
