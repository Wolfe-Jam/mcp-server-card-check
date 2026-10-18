/**
 * Browser entry: the checker plus a precompiled card validator.
 *
 * `cardValidator()` in ./validate.js compiles the schema with ajv at runtime, which needs
 * `new Function`. Browser extensions (MV3 content security policy) and Cloudflare Workers
 * forbid that, so this entry ships the schema precompiled by ajv "standalone"
 * (npm run build:validator) and needs no file system either.
 *
 *   import { checkDiscovery, validateCard } from "mcp-server-card-check/browser";
 *   await checkDiscovery({ mcpUrl }, { validateCard, fetch: readOnlyFetch });
 *
 * Read-only use: pass a fetch that refuses POST, and `rawStatus: async () => null`, as the
 * CLI does without --transport. The transport and consistency checks then report "skip".
 */
import validate from "./validator-standalone.cjs";

export * from "./discovery.js";
/** The spec section each check cites, by check id. */
export { SPEC_REFS, type SpecRef } from "./refs.js";

/** Returns null when the card is valid against the v1 schema, else a short error. */
export const validateCard = (card: unknown): string | null =>
  validate(card)
    ? null
    : ((validate.errors ?? []) as { instancePath?: string; message?: string }[])
        .map((e) => `${e.instancePath || "/"} ${e.message}`)
        .join("; ");
