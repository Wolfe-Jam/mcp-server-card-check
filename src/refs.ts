/** Where each check comes from: the pinned discovery doc, the v1 schema, the AI Catalog spec or SEP-2127. */
const DISCOVERY = "https://github.com/modelcontextprotocol/ext-server-card/blob/526201bbc80231daa40ffcdecfc9da4e54e5dc93/docs/discovery.md";
const SCHEMA = "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json";
const AI_CATALOG = "https://github.com/Agent-Card/ai-catalog/blob/main/specification/ai-catalog.md";
const SEP = "https://github.com/modelcontextprotocol/modelcontextprotocol/blob/main/seps/2127-mcp-server-cards.md";

export interface SpecRef { label: string; url: string }

const d = (section: string, anchor: string): SpecRef => ({ label: `discovery.md § ${section}`, url: `${DISCOVERY}#${anchor}` });
const schema = (field: string): SpecRef => ({ label: `v1 schema: ${field}`, url: SCHEMA });
const catalog = (what: string): SpecRef => ({ label: `AI Catalog spec: ${what}`, url: AI_CATALOG });

export const SPEC_REFS: Record<string, SpecRef> = {
  "card.found": d("Hosted Server Card Location", "hosted-server-card-location"),
  "card.json": d("MCP Server Cards", "mcp-server-cards"),
  "card.schema-url": schema("$schema"),
  "card.schema-valid": schema("ServerCard"),
  "card.name": schema("name"),
  "card.version": schema("version"),
  "card.description": schema("description"),
  "card.no-secrets": d("Information Disclosure", "information-disclosure"),
  "card.remote-matches": d("Consistency with Runtime Behavior", "consistency-with-runtime-behavior"),
  "card.protocol-versions": schema("remotes[].supportedProtocolVersions + MCP released versions"),
  "card.registry-name": { label: "SEP-2127 § Relationship to the MCP Registry's server.json", url: `${SEP}#relationship-to-the-mcp-registrys-serverjson` },
  "hosting.https": d("Transport Security", "transport-security"),
  "hosting.content-type": d("Hosted Server Card Location", "hosted-server-card-location"),
  "hosting.cors-origin": d("CORS Requirements", "cors-requirements"),
  "hosting.cors-expose": d("CORS Requirements", "cors-requirements"),
  "hosting.cors-preflight": d("CORS Requirements", "cors-requirements"),
  "hosting.cache-control": d("Caching", "caching"),
  "hosting.etag": d("Caching", "caching"),
  "catalog.content-type": d("Well-Known URI", "well-known-uri"),
  "catalog.card-entry": d("Server Card Entries", "server-card-entries"),
  "catalog.card-entry-lean": d("Server Card Entries", "server-card-entries"),
  "catalog.spec-version": catalog("specVersion"),
  "catalog.entries": catalog("entries"),
  "catalog.entry-fields": catalog("Catalog Entry"),
  "catalog.entry-one-of": catalog("url or data"),
  "catalog.identifiers": catalog("identifier"),
  "catalog.host": catalog("host"),
  "catalog.links": catalog("links"),
  "catalog.extensions": catalog("extensions"),
  "transport.origin-403": { label: "MCP Streamable HTTP § Security Warning (Origin)", url: "https://modelcontextprotocol.io/specification/2026-07-28/basic/transports" },
  "transport.rebinding": { label: "MCP Streamable HTTP § Security Warning (DNS rebinding)", url: "https://modelcontextprotocol.io/specification/2026-07-28/basic/transports" },
};
