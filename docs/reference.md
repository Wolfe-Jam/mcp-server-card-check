# Server Card census: method and results

A read-only census of every MCP Registry entry with a remote endpoint, checked for a Server Card with this repository's checker. First run: 2026-10-12, six days after [SEP-2127](https://github.com/modelcontextprotocol/modelcontextprotocol/pull/2127) merged as Final on 2026-10-06.

## Method

1. **Scope.** Every *latest* version in the [MCP Registry](https://registry.modelcontextprotocol.io/v0.1/servers) with a `streamable-http` remote, de-duplicated by URL. URLs with template variables (`{tenant}`) are skipped; they can't be requested as written.
2. **Checks.** For each endpoint, `checkDiscovery` from this package with the v1 schema ([ext-server-card@526201bb](https://github.com/modelcontextprotocol/ext-server-card/tree/526201bbc80231daa40ffcdecfc9da4e54e5dc93)):
   - the card at `<url>/server-card`, else the AI Catalog's card entry at `/.well-known/ai-catalog.json`;
   - schema validity, the hosting headers (CORS, caching), and the catalog.
3. **Read-only.** GET and OPTIONS only. The transport checks (POST) are skipped for every endpoint. One pass, at most 16 requests in flight, a 10-second timeout, and a User-Agent naming this repository.
4. **Counting.** A *card* is a 200 response at a card location that parses as JSON. A *valid card* also passes the v1 schema. Endpoints that answer 200 with something that isn't JSON (catch-all pages) are counted separately.

## Results, 2026-10-12

Registry read: 2026-10-12 01:47 UTC (145,157 entries across all versions). Census window: 01:51–04:15 UTC. Full figures: [`census/2026-10-12/summary.json`](census/2026-10-12/summary.json).

| | Count |
|---|---|
| Endpoints checked | **26,105** (270 templated URLs skipped; 0 errors) |
| Answered 200 at a card location | 3,609 |
| …of which not JSON | 637 |
| JSON cards | 2,972 |
| **Schema-valid cards** | **2,194 (8.40% of endpoints)** |
| …from the single largest emitter (one gateway) | 1,791 |
| **Valid, excluding that emitter** | **403 of 24,314 (1.66%)** |
| **By distinct host** | **352 of 18,268 (1.93%)** |
| **By registry namespace** | **344 of 15,926 (2.16%)** |
| Single-endpoint namespaces | 308 of 14,815 (2.08%) |
| Valid cards at the reserved `<url>/server-card` path | 2,096 of 2,194 |
| JSON cards with `Access-Control-Allow-Origin: *` | 2,731 of 2,972 |
| JSON cards with all four CORS headers [discovery.md lists](https://github.com/modelcontextprotocol/ext-server-card/blob/526201bbc80231daa40ffcdecfc9da4e54e5dc93/docs/discovery.md#cors-requirements) | 179 of 2,972 |
| JSON cards with an ETag that answers `If-None-Match` with 304 | 433 of 2,972 |

**About 2% of MCP servers with a remote endpoint publish a valid Server Card, whichever way you count.** The per-endpoint figure (8.4%) is dominated by one gateway that publishes a card for each of its 1,791 registry entries; it was an early implementer of the draft.

## Caveats

- **Registry entries are not servers.** Several publishers put hundreds or thousands of entries behind one host. That's why the table counts by host and by namespace as well as by endpoint.
- **CORS.** discovery.md says hosted cards "MUST include appropriate CORS headers" and lists four. The table counts cards carrying all four; it doesn't treat each missing header as a separate MUST failure.
- **Credentials.** The run on 2026-10-12 used an earlier `card.no-secrets` rule that matched words such as `api_key`, so its no-secrets counts are not reported. The current rule checks values; re-run on the 487 cards the old rule flagged, it flags 1.
- **Schema-valid is not correct.** The v1 schema accepts any string in `supportedProtocolVersions`, and doesn't relate a card's `name` to its registry entry. `card.protocol-versions` and `card.registry-name` were added after the census for that reason.
- **A snapshot.** Cards change. The census is meant to be repeated with the same method.

## Reproduce

```sh
npm ci && npm run build
export CENSUS_DIR=./census-data && mkdir -p "$CENSUS_DIR"
node scripts/census/registry.mjs       # the registry's remote endpoints (about 20 minutes)
CONCURRENCY=16 node scripts/census/probe.mjs     # the checks, read-only (about 2.5 hours); resumable
node scripts/census/summarize.mjs      # the figures above, as summary.json
```

`summarize.mjs` reproduces every figure in the table above from the 2026-10-12 rows exactly.
