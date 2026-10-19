/** Where each check comes from: the pinned discovery doc, the v1 schema, the AI Catalog spec or SEP-2127. */
const DISCOVERY = "https://github.com/modelcontextprotocol/ext-server-card/blob/526201bbc80231daa40ffcdecfc9da4e54e5dc93/docs/discovery.md";
// The schema itself, pinned. Its canonical $schema id (static.modelcontextprotocol.io/schemas/v1/
// server-card.schema.json) is what cards must declare, but that URL isn't served yet (HTTP 404, 2026-10-18).
const SCHEMA = "https://github.com/modelcontextprotocol/ext-server-card/blob/526201bbc80231daa40ffcdecfc9da4e54e5dc93/schema.json";
// Pinned: the entry rules (displayName / description / version) changed on 2026-06-08 (0798bcc).
const AI_CATALOG = "https://github.com/Agent-Card/ai-catalog/blob/9316f00de22f8baf0a7bb526cf92e27a40ca047e/specification/ai-catalog.md";
const SEP = "https://github.com/modelcontextprotocol/modelcontextprotocol/blob/5c8483d511d60ef1f8ded5160c5290fd8213d19e/seps/2127-mcp-server-cards.md";

export interface SpecRef { label: string; url: string }

const d = (section: string, anchor: string): SpecRef => ({ label: `discovery.md § ${section}`, url: `${DISCOVERY}#${anchor}` });
const schema = (field: string): SpecRef => ({ label: `v1 schema: ${field}`, url: SCHEMA });
const catalog = (what: string, anchor = ""): SpecRef => ({ label: `AI Catalog spec: ${what}`, url: AI_CATALOG + (anchor ? `#${anchor}` : "") });

export const SPEC_REFS: Record<string, SpecRef> = {
  "card.found": d("Hosted Server Card Location", "hosted-server-card-location"),
  "card.json": d("MCP Server Cards", "mcp-server-cards"),
  "card.schema-url": schema("$schema"),
  "card.schema-valid": schema("ServerCard"),
  "card.name": schema("name"),
  "card.version": schema("version"),
  "card.version-semver": schema("version (SHOULD follow semantic versioning)"),
  "card.description": schema("description"),
  "card.no-secrets": d("Information Disclosure", "information-disclosure"),
  "card.protocol-versions": schema("remotes[].supportedProtocolVersions + MCP released versions"),
  "card.registry-name": { label: "SEP-2127 § Relationship to the MCP Registry's server.json", url: `${SEP}#relationship-to-the-mcp-registrys-serverjson` },
  "hosting.https": d("Transport Security", "transport-security"),
  "hosting.content-type": d("Hosted Server Card Location", "hosted-server-card-location"),
  "hosting.cors-origin": d("CORS Requirements", "cors-requirements"),
  "hosting.cors-methods": d("CORS Requirements", "cors-requirements"),
  "hosting.cors-headers": d("CORS Requirements", "cors-requirements"),
  "hosting.cors-expose": d("CORS Requirements", "cors-requirements"),
  "hosting.cors-preflight": d("CORS Requirements", "cors-requirements"),
  "hosting.cache-control": d("Caching", "caching"),
  "hosting.etag": d("Caching", "caching"),
  "catalog.content-type": d("Well-Known URI", "well-known-uri"),
  "catalog.card-entry-lean": catalog("Catalog Entry (displayName, description, version)", "catalog-entry"),
  "catalog.card-entry-version": catalog("Catalog Entry (version)", "catalog-entry"),
  "catalog.spec-version": catalog("Top-Level Structure: specVersion", "top-level-structure"),
  "catalog.entries": catalog("Top-Level Structure: entries", "top-level-structure"),
  "catalog.entry-fields": catalog("Catalog Entry: identifier, type", "catalog-entry"),
  "catalog.entry-one-of": catalog("Catalog Entry: url or data", "catalog-entry"),
  "catalog.identifiers": catalog("Catalog Entry: identifier", "catalog-entry"),
  "catalog.host": catalog("Host Info", "host-info"),
  "catalog.links": catalog("Catalog Entry: url (served with the declared type)", "catalog-entry"),
  "catalog.extensions": catalog("Extensions: key naming", "format-and-key-naming"),
  "consistency.transport": d("Consistency with Runtime Behavior", "consistency-with-runtime-behavior"),
  "consistency.protocol-version": d("Consistency with Runtime Behavior", "consistency-with-runtime-behavior"),
  "consistency.version": d("Consistency with Runtime Behavior", "consistency-with-runtime-behavior"),
  "consistency.name": d("Consistency with Runtime Behavior", "consistency-with-runtime-behavior"),
  "consistency.title": d("Consistency with Runtime Behavior", "consistency-with-runtime-behavior"),
  "consistency.description": d("Consistency with Runtime Behavior", "consistency-with-runtime-behavior"),
  "transport.origin-403": { label: "MCP Streamable HTTP § Security & Endpoint (Origin)", url: "https://modelcontextprotocol.io/specification/2026-07-28/basic/transports" },
  "transport.rebinding": { label: "MCP Streamable HTTP § Security & Endpoint (DNS rebinding)", url: "https://modelcontextprotocol.io/specification/2026-07-28/basic/transports" },
};
