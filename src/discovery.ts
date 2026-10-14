/**
 * conformance/discovery — a portable checker for MCP Server Card discovery
 * (SEP-2127, Final), the AI Catalog (spec 1.0), and the Streamable HTTP
 * transport's security rules, run against any server URL.
 *
 * Self-contained on purpose: no imports from this package, only the global
 * `fetch` (and `node:http` for the one check that must forge a Host header,
 * which `fetch` drops), so the file can be lifted into another tool as-is.
 * The transport checks send one JSON-RPC `ping`, which changes nothing. Point it at a
 * server's Streamable HTTP endpoint and it returns one result per requirement,
 * each tagged MUST or SHOULD exactly as the spec words it. Requirements the
 * spec leaves at MAY (where the card lives, whether a catalog exists) are
 * never failures: a missing optional document turns its checks into skips.
 *
 * JSON Schema validation is optional: pass `validateCard` (for example Ajv
 * against the official v1 schema) and it runs as one more card check.
 */

export const SERVER_CARD_SCHEMA_URL =
  "https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json";
export const SERVER_CARD_TYPE = "application/mcp-server-card+json";
export const AI_CATALOG_TYPE = "application/ai-catalog+json";

const NAME_RE = /^[a-zA-Z0-9.-]+\/[a-zA-Z0-9._-]+$/;
const EXT_KEY_RE = /^(https?:\/\/\S+|[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+)$/;
const URN_RE = /^urn:air:[^:]+\.[^:]+:[^:]+:[^:]+$/i;
/** Keys whose string value is a credential when it is set to anything but a placeholder. */
const SECRET_KEY_RE = /^(api[_-]?key|apikey|x-api-key|secret|client[_-]?secret|password|passwd|token|access[_-]?token|refresh[_-]?token|auth[_-]?token|bearer[_-]?token|authorization|private[_-]?key)$/i;
/** Well-known credential shapes, wherever they appear. */
const TOKEN_SHAPES: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/, // OpenAI-style secret keys
  /\bgh[pousr]_[A-Za-z0-9]{30,}/, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/, // Slack
  /\bAKIA[0-9A-Z]{16}\b/, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/, // Google API key
];
/** A bearer token: checked separately so the token itself can be tested for placeholders. */
const BEARER_RE = /\bBearer\s+([A-Za-z0-9._~+/-]{20,}=*)/;
/** A JWT. Only a credential after "Bearer" or under a secret-named key: signed public artifacts are JWS too. */
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/;
/** Values that stand for "fill this in", never a credential. */
const PLACEHOLDER_RE =
  /^\s*$|^[{<$]|[{}]|<[^>]+>|\.\.\.|…|x{4,}|\*{3,}|^https?:\/\/|^(your|my|example|demo|test|sample|changeme|placeholder|redacted|none|null)\b/i;
/** An environment-variable-style name (API_KEY_HERE, ACCESS_TOKEN): case-sensitive on purpose. */
const ENV_NAME_RE = /^[A-Z][A-Z0-9_]{5,}$/;
/** Keys that hold documentation of a value, never the value itself. */
const DOC_KEYS = new Set(["placeholder", "example", "examples", "description", "title", "hint"]);
const isPlaceholder = (v: string) => PLACEHOLDER_RE.test(v) || ENV_NAME_RE.test(v.trim()) || v.trim().length < 6;

/** The first credential value in a card, or null. Prose that merely mentions "api_key" is not a credential. */
export function findCredential(card: unknown): string | null {
  const walk = (v: unknown, key: string | undefined, parent: Record<string, unknown> | undefined): string | null => {
    if (typeof v === "string") {
      const doc = key !== undefined && DOC_KEYS.has(key.toLowerCase());
      for (const re of TOKEN_SHAPES) {
        const m = re.exec(v);
        if (m && !PLACEHOLDER_RE.test(m[0])) return m[0].slice(0, 12) + "…";
      }
      const bearer = BEARER_RE.exec(v);
      if (bearer && !doc && !isPlaceholder(bearer[1])) return "Bearer " + bearer[1].slice(0, 5) + "…";
      if (key && !doc && SECRET_KEY_RE.test(key) && !isPlaceholder(v)) return `${key}: ${v.slice(0, 4)}…`;
      if (key && SECRET_KEY_RE.test(key) && JWT_RE.test(v)) return `${key}: a JWT`;
      if (key === "value" && parent?.isSecret === true && !isPlaceholder(v)) return "a pre-set value for an isSecret input";
      return null;
    }
    if (Array.isArray(v)) {
      for (const x of v) {
        const hit = walk(x, key, parent);
        if (hit) return hit;
      }
      return null;
    }
    if (isObject(v)) {
      for (const [k, x] of Object.entries(v)) {
        const hit = walk(x, k, v);
        if (hit) return hit;
      }
    }
    return null;
  };
  return walk(card, undefined, undefined);
}
const PRIVATE_HOST_RE =
  /\b(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)\b/i;

/** Released MCP protocol versions (modelcontextprotocol/modelcontextprotocol schema/, checked 2026-10-12). */
/** Semantic Versioning 2.0.0 (semver.org), no leading "v". */
const SEMVER_RE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

export const KNOWN_PROTOCOL_VERSIONS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25", "2026-07-28"] as const;

/**
 * Protocol version strings that are not real: not a YYYY-MM-DD date, or a date on or
 * before the newest known release that is not one. Dates newer than the newest known
 * release pass, so a future MCP version doesn't make the checker wrong.
 */
export function unknownProtocolVersions(values: unknown, known: readonly string[] = KNOWN_PROTOCOL_VERSIONS): string[] {
  if (!Array.isArray(values)) return [];
  const newest = [...known].sort().at(-1) ?? "";
  return values
    .map((v) => String(v))
    .filter((v) => !/^\d{4}-\d{2}-\d{2}$/.test(v) || (v <= newest && !known.includes(v)));
}

export type Tier = "card" | "hosting" | "catalog" | "transport" | "consistency";
export type Level = "must" | "should";
export type Status = "pass" | "fail" | "skip";

export interface CheckResult {
  id: string;
  tier: Tier;
  level: Level;
  title: string;
  status: Status;
  detail?: string;
}

export interface DiscoveryTarget {
  /** The server's Streamable HTTP endpoint, e.g. `https://ctx.example.com/mcp`. */
  mcpUrl: string;
  /** Where to read the card. Default: `<mcpUrl>/server-card`, then the catalog's card entry. */
  cardUrl?: string;
  /** Where to read the catalog. Default: `<origin>/.well-known/ai-catalog.json`. */
  catalogUrl?: string;
  /** The server's MCP Registry name (server.json `name`), to compare with the card's `name`. Optional. */
  registryName?: string;
}

export interface DiscoveryOptions {
  fetch?: typeof fetch;
  /** Returns null when the card is valid, else a short error. */
  validateCard?: (card: unknown) => string | null;
  /** Per-request timeout in milliseconds (default 10000). */
  timeoutMs?: number;
  /** POST with exact headers (Host included); returns the status, or null. Default: node:http. */
  rawStatus?: (url: string, headers: Record<string, string>, body: string, timeoutMs: number) => Promise<number | null>;
}

/** POST through node:http, which (unlike fetch) sends a Host header as given. */
async function rawStatus(url: string, headers: Record<string, string>, body: string, timeoutMs: number): Promise<number | null> {
  try {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? await import("node:https") : await import("node:http");
    return await new Promise((resolve) => {
      const req = mod.request(
        u,
        { method: "POST", headers: { ...headers, "Content-Length": String(Buffer.byteLength(body)) }, timeout: timeoutMs },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? null);
        },
      );
      req.on("error", () => resolve(null));
      req.on("timeout", () => {
        req.destroy();
        resolve(null);
      });
      req.end(body);
    });
  } catch {
    return null;
  }
}

export interface DiscoveryReport {
  mcpUrl: string;
  cardUrl: string | null;
  catalogUrl: string;
  results: CheckResult[];
  passed: number;
  failed: number;
  skipped: number;
  /** Failed MUST checks: zero means nothing the spec requires is broken. */
  mustFailures: number;
}

interface Fetched {
  status: number;
  headers: Headers;
  text: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const isLoopback = (u: URL) => ["localhost", "127.0.0.1", "[::1]", "::1"].includes(u.hostname);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** What the server says once connected, from server/discover or (legacy servers) initialize. */
interface LiveServer {
  status: number;
  via?: "server/discover" | "initialize";
  /** server/discover: the versions the server supports. initialize: the one version agreed. */
  supportedVersions?: string[];
  serverInfo?: { name?: unknown; version?: unknown; title?: unknown; description?: unknown };
  error?: string;
}

/** Reads a JSON-RPC response with the given id from a JSON or an SSE body. */
function rpcResult(text: string, contentType: string, id: number): Record<string, unknown> | undefined {
  const bodies = contentType.includes("text/event-stream")
    ? text.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim())
    : [text];
  for (const b of bodies) {
    const msg = parseJson(b);
    if (isObject(msg) && msg.id === id) return msg;
  }
  return undefined;
}

interface RpcReply {
  status: number;
  msg?: Record<string, unknown>;
  error?: string;
}

/** One JSON-RPC POST; closes any session it opens (DELETE with its Mcp-Session-Id, best effort). */
async function rpcPost(
  doFetch: typeof fetch,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
  id: number,
  method: string,
  params: Record<string, unknown>,
): Promise<RpcReply | null> {
  let res: Response;
  let text: string;
  try {
    res = await doFetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    text = await res.text();
  } catch {
    return null;
  }
  const session = res.headers.get("mcp-session-id");
  if (session) {
    try {
      const del = await doFetch(url, { method: "DELETE", headers: { "Mcp-Session-Id": session }, signal: AbortSignal.timeout(timeoutMs) });
      await del.body?.cancel();
    } catch {
      // closing is a courtesy; the server expires the session anyway
    }
  }
  if (!res.ok) return { status: res.status, error: `answered ${res.status}` };
  const msg = rpcResult(text, res.headers.get("content-type") ?? "", id);
  if (!msg) return { status: res.status, error: `no JSON-RPC response to ${method}` };
  if (isObject(msg.error)) return { status: res.status, error: `${method} error: ${String(msg.error.message ?? msg.error.code)}` };
  return { status: res.status, msg };
}

/**
 * Asks the server who it is: server/discover first (2026-07-28: "Servers MUST implement it"),
 * then initialize for legacy servers. Returns null when nothing answered.
 */
async function connect(
  doFetch: typeof fetch,
  url: string,
  headers: Record<string, string>,
  timeoutMs: number,
): Promise<LiveServer | null> {
  const latest = KNOWN_PROTOCOL_VERSIONS[KNOWN_PROTOCOL_VERSIONS.length - 1];
  const clientInfo = { name: "server-card-check", version: "1" };
  const discover = await rpcPost(doFetch, url, { ...headers, "MCP-Protocol-Version": latest }, timeoutMs, 2, "server/discover", {
    _meta: {
      "io.modelcontextprotocol/protocolVersion": latest,
      "io.modelcontextprotocol/clientInfo": clientInfo,
      "io.modelcontextprotocol/clientCapabilities": {},
    },
  });
  if (!discover) return null;
  if (discover.status === 401 || discover.status === 403) return { status: discover.status };
  const result = discover.msg && isObject(discover.msg.result) ? discover.msg.result : undefined;
  if (result && Array.isArray(result.supportedVersions)) {
    const meta = isObject(result._meta) ? result._meta : {};
    const info = meta["io.modelcontextprotocol/serverInfo"];
    return {
      status: discover.status,
      via: "server/discover",
      supportedVersions: result.supportedVersions.filter((v): v is string => typeof v === "string"),
      serverInfo: isObject(info) ? info : undefined,
    };
  }

  // Legacy server: no server/discover, so the initialize handshake.
  const init = await rpcPost(doFetch, url, headers, timeoutMs, 3, "initialize", {
    protocolVersion: latest,
    capabilities: {},
    clientInfo,
  });
  if (!init) return { status: discover.status, error: discover.error ?? "no server/discover result" };
  if (init.status === 401 || init.status === 403) return { status: init.status };
  if (init.error) return { status: init.status, error: `${discover.error ?? "no server/discover result"}; ${init.error}` };
  const r = init.msg && isObject(init.msg.result) ? init.msg.result : {};
  if (typeof r.protocolVersion !== "string") return { status: init.status, error: "initialize result has no protocolVersion" };
  return {
    status: init.status,
    via: "initialize",
    supportedVersions: [r.protocolVersion],
    serverInfo: isObject(r.serverInfo) ? r.serverInfo : undefined,
  };
}

export async function checkDiscovery(
  target: DiscoveryTarget,
  opts: DiscoveryOptions = {},
): Promise<DiscoveryReport> {
  const doFetch = opts.fetch ?? fetch;
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const results: CheckResult[] = [];
  const add = (tier: Tier, level: Level, id: string, title: string, status: Status, detail?: string) =>
    results.push({ id, tier, level, title, status, ...(detail ? { detail } : {}) });
  const check = (tier: Tier, level: Level, id: string, title: string, ok: boolean, detail?: string) =>
    add(tier, level, id, title, ok ? "pass" : "fail", ok ? undefined : detail);

  const get = async (url: string, headers: Record<string, string> = {}, method = "GET"): Promise<Fetched | null> => {
    try {
      const r = await doFetch(url, { method, headers, signal: AbortSignal.timeout(timeoutMs) });
      return { status: r.status, headers: r.headers, text: method === "OPTIONS" ? "" : await r.text() };
    } catch {
      return null;
    }
  };

  const mcp = new URL(target.mcpUrl);
  const catalogUrl = target.catalogUrl ?? new URL("/.well-known/ai-catalog.json", mcp).href;

  // ── Catalog first: it may be where the card is found ──────────────────────
  const catRes = await get(catalogUrl, { Accept: AI_CATALOG_TYPE });
  const catalog = catRes && catRes.status === 200 ? parseJson(catRes.text) : undefined;
  const entries = isObject(catalog) && Array.isArray(catalog.entries) ? (catalog.entries as unknown[]) : [];
  const cardEntry = entries.find((e) => isObject(e) && e.type === SERVER_CARD_TYPE) as
    | Record<string, unknown>
    | undefined;

  // ── Find the card: explicit → <mcp>/server-card → catalog entry ──────────
  const candidates = [
    target.cardUrl,
    `${target.mcpUrl.replace(/\/+$/, "")}/server-card`,
    cardEntry && typeof cardEntry.url === "string" ? new URL(cardEntry.url, catalogUrl).href : undefined,
  ].filter((u): u is string => !!u);
  let cardUrl: string | null = null;
  let cardRes: Fetched | null = null;
  for (const u of [...new Set(candidates)]) {
    const r = await get(u, { Accept: SERVER_CARD_TYPE });
    if (r && r.status === 200) {
      cardUrl = u;
      cardRes = r;
      break;
    }
  }
  const inlineCard = !cardRes && cardEntry && isObject(cardEntry.data) ? cardEntry.data : undefined;

  // ── Tier: card ────────────────────────────────────────────────────────────
  const card = cardRes ? parseJson(cardRes.text) : inlineCard;
  if (card === undefined && !cardRes) {
    add("card", "should", "card.found", "A Server Card is published (hosted or in the catalog)", "fail",
      `none at ${candidates.join(", ")}`);
  } else {
    add("card", "should", "card.found", "A Server Card is published (hosted or in the catalog)", "pass");
    check("card", "must", "card.json", "The card is a JSON object", isObject(card), "body is not a JSON object");
    if (isObject(card)) {
      check("card", "must", "card.schema-url", "$schema is the v1 Server Card schema URL",
        card.$schema === SERVER_CARD_SCHEMA_URL, `got ${JSON.stringify(card.$schema)}`);
      check("card", "must", "card.name", "name is reverse-DNS with one slash",
        typeof card.name === "string" && NAME_RE.test(card.name) && card.name.length >= 3 && card.name.length <= 200,
        `got ${JSON.stringify(card.name)}`);
      if (target.registryName) {
        check("card", "should", "card.registry-name", "name matches the server's MCP Registry name",
          card.name === target.registryName,
          `card ${JSON.stringify(card.name)} vs registry ${JSON.stringify(target.registryName)} — SEP-2127: cards and server.json "use compatible metadata where practical", identity included`);
      } else {
        add("card", "should", "card.registry-name", "name matches the server's MCP Registry name", "skip",
          "no registry name given");
      }
      check("card", "must", "card.version", "version is present",
        typeof card.version === "string" && card.version.length > 0 && card.version.length <= 255,
        `got ${JSON.stringify(card.version)}`);
      check("card", "must", "card.description", "description is 1–100 characters",
        typeof card.description === "string" && card.description.length >= 1 && card.description.length <= 100,
        typeof card.description === "string" ? `${card.description.length} characters` : "missing");
      if (opts.validateCard) {
        const err = opts.validateCard(card);
        check("card", "must", "card.schema-valid", "The card validates against the v1 JSON Schema", err === null, err ?? "");
      } else {
        add("card", "must", "card.schema-valid", "The card validates against the v1 JSON Schema", "skip",
          "no schema validator supplied");
      }
      const text = JSON.stringify(card);
      const leak = findCredential(card) ?? PRIVATE_HOST_RE.exec(text)?.[0] ?? null;
      check("card", "must", "card.no-secrets", "No credentials or private endpoints in the card",
        !leak || isLoopback(mcp), `found ${leak}`);
      const remotes = Array.isArray(card.remotes) ? (card.remotes as unknown[]) : [];
      if (typeof card.version === "string" && card.version.length > 0) {
        check("card", "should", "card.version-semver", "version follows semantic versioning", SEMVER_RE.test(card.version),
          `got ${JSON.stringify(card.version)} (v1 schema: "SHOULD follow semantic versioning")`);
      } else {
        add("card", "should", "card.version-semver", "version follows semantic versioning", "skip", "no version");
      }
      const declared = remotes.filter(isObject).filter((r) => r.supportedProtocolVersions !== undefined);
      if (declared.length) {
        const bad = [...new Set(declared.flatMap((r) => unknownProtocolVersions(r.supportedProtocolVersions)))];
        check("card", "should", "card.protocol-versions", "supportedProtocolVersions lists released MCP protocol versions",
          bad.length === 0, `not MCP versions: ${bad.join(", ")} (released: ${KNOWN_PROTOCOL_VERSIONS.join(", ")})`);
      } else {
        add("card", "should", "card.protocol-versions", "supportedProtocolVersions lists released MCP protocol versions",
          "skip", "no remote declares supportedProtocolVersions");
      }
    }
  }

  // ── Tier: hosting (only for a hosted card) ───────────────────────────────
  // discovery.md § CORS Requirements lists four headers that hosted card endpoints MUST include;
  // they are read from the GET response. The OPTIONS preflight is a SHOULD of our own: a browser
  // that sends If-None-Match from script preflights first (it is not a CORS-safelisted header).
  const hostingTitles: [Level, string, string][] = [
    ["should", "hosting.content-type", `Served as ${SERVER_CARD_TYPE}`],
    ["must", "hosting.cors-origin", "CORS: Access-Control-Allow-Origin is *"],
    ["must", "hosting.cors-methods", "CORS: Access-Control-Allow-Methods includes GET"],
    ["must", "hosting.cors-headers", "CORS: Access-Control-Allow-Headers includes Content-Type and If-None-Match"],
    ["must", "hosting.cors-expose", "CORS: ETag is exposed"],
    ["should", "hosting.cors-preflight", "Browser preflight allows GET with If-None-Match"],
    ["should", "hosting.cache-control", "Cache-Control is public with a max-age"],
    ["should", "hosting.etag", "An ETag is returned and If-None-Match gets 304"],
    ["must", "hosting.https", "Served over HTTPS (HTTP only for local development)"],
  ];
  const T = (id: string) => hostingTitles.find((t) => t[1] === id)![2];
  if (!cardRes || !cardUrl) {
    for (const [level, id, title] of hostingTitles) add("hosting", level, id, title, "skip", "no hosted card");
  } else {
    const h = cardRes.headers;
    const ct = h.get("content-type") ?? "";
    check("hosting", "should", "hosting.content-type", T("hosting.content-type"),
      ct.split(";")[0].trim().toLowerCase() === SERVER_CARD_TYPE, `got "${ct}"`);

    const withOrigin = await get(cardUrl, { Origin: "https://conformance.example" });
    const listHas = (value: string, item: string) =>
      value.split(",").map((v) => v.trim().toLowerCase()).includes(item.toLowerCase());
    const acao = withOrigin?.headers.get("access-control-allow-origin") ?? "";
    check("hosting", "must", "hosting.cors-origin", T("hosting.cors-origin"), acao === "*", `got "${acao}"`);
    const getMethods = withOrigin?.headers.get("access-control-allow-methods") ?? "";
    check("hosting", "must", "hosting.cors-methods", T("hosting.cors-methods"), listHas(getMethods, "GET"),
      `got "${getMethods}" on the GET response`);
    const getHeaders = withOrigin?.headers.get("access-control-allow-headers") ?? "";
    check("hosting", "must", "hosting.cors-headers", T("hosting.cors-headers"),
      listHas(getHeaders, "content-type") && listHas(getHeaders, "if-none-match"), `got "${getHeaders}" on the GET response`);
    const expose = withOrigin?.headers.get("access-control-expose-headers") ?? "";
    check("hosting", "must", "hosting.cors-expose", T("hosting.cors-expose"), listHas(expose, "etag"),
      `got "${expose}"`);

    const pre = await get(cardUrl, {
      Origin: "https://conformance.example",
      "Access-Control-Request-Method": "GET",
      "Access-Control-Request-Headers": "content-type, if-none-match",
    }, "OPTIONS");
    const methods = pre?.headers.get("access-control-allow-methods") ?? "";
    const allowed = pre?.headers.get("access-control-allow-headers") ?? "";
    const preOrigin = pre?.headers.get("access-control-allow-origin") ?? "";
    check("hosting", "should", "hosting.cors-preflight", T("hosting.cors-preflight"),
      !!pre && pre.status < 400 && (preOrigin === "*" || preOrigin === "https://conformance.example") &&
        listHas(methods, "GET") && listHas(allowed, "if-none-match"),
      `preflight ${pre?.status ?? "failed"}: origin "${preOrigin}", methods "${methods}", headers "${allowed}" (browser behaviour: If-None-Match from script triggers a preflight)`);

    const cc = (h.get("cache-control") ?? "").toLowerCase();
    check("hosting", "should", "hosting.cache-control", T("hosting.cache-control"),
      /\bpublic\b/.test(cc) && /\bmax-age=\d+/.test(cc), `got "${cc}"`);

    const etag = h.get("etag");
    const again = etag ? await get(cardUrl, { "If-None-Match": etag }) : null;
    check("hosting", "should", "hosting.etag", T("hosting.etag"), !!etag && again?.status === 304,
      etag ? `If-None-Match answered ${again?.status}` : "no ETag header");

    const u = new URL(cardUrl);
    if (u.protocol === "https:") add("hosting", "must", "hosting.https", T("hosting.https"), "pass");
    else if (isLoopback(u)) add("hosting", "must", "hosting.https", T("hosting.https"), "skip", "local development");
    else add("hosting", "must", "hosting.https", T("hosting.https"), "fail", `served from ${u.protocol}//${u.host}`);
  }

  // ── Tier: catalog (optional: absent → skipped) ───────────────────────────
  const catTitles: [Level, string, string][] = [
    ["should", "catalog.content-type", `Served as ${AI_CATALOG_TYPE}`],
    ["must", "catalog.spec-version", "specVersion is present"],
    ["must", "catalog.entries", "entries is an array"],
    ["must", "catalog.host", "host.displayName is present when host is"],
    ["must", "catalog.entry-fields", "Every entry has identifier and type"],
    ["must", "catalog.entry-one-of", "Every entry has exactly one of url or data"],
    ["should", "catalog.identifiers", "Identifiers use urn:air:{publisher-domain}:{namespace}:{name}"],
    ["should", "catalog.extensions", "Custom data sits in extensions under URL or reverse-DNS keys"],
    ["should", "catalog.card-entry", "The catalog lists the Server Card"],
    ["should", "catalog.card-entry-lean", "The card entry repeats no displayName, description or version"],
    ["should", "catalog.links", "Every entry URL resolves with the type its entry declares"],
  ];
  if (!catRes || catRes.status !== 200 || !isObject(catalog)) {
    const why = !catRes ? "unreachable" : catRes.status !== 200 ? `HTTP ${catRes.status}` : "not a JSON object";
    for (const [level, id, title] of catTitles) add("catalog", level, id, title, "skip", `no catalog (${why})`);
  } else {
    const t = (i: number) => catTitles[i];
    const ct = catRes.headers.get("content-type") ?? "";
    check("catalog", t(0)[0], t(0)[1], t(0)[2], ct.split(";")[0].trim().toLowerCase() === AI_CATALOG_TYPE, `got "${ct}"`);
    check("catalog", t(1)[0], t(1)[1], t(1)[2], typeof catalog.specVersion === "string", "missing");
    check("catalog", t(2)[0], t(2)[1], t(2)[2], Array.isArray(catalog.entries), "missing or not an array");
    check("catalog", t(3)[0], t(3)[1], t(3)[2],
      catalog.host === undefined || (isObject(catalog.host) && typeof catalog.host.displayName === "string"),
      "host without displayName");

    const objs = entries.filter(isObject);
    const bad = (pred: (e: Record<string, unknown>) => boolean) =>
      objs.filter((e) => !pred(e)).map((e) => String(e.identifier ?? "(no identifier)"));
    const noFields = bad((e) => typeof e.identifier === "string" && typeof e.type === "string");
    check("catalog", t(4)[0], t(4)[1], t(4)[2], noFields.length === 0 && objs.length === entries.length,
      noFields.join(", ") || "non-object entry");
    const notOne = bad((e) => (e.url !== undefined) !== (e.data !== undefined));
    check("catalog", t(5)[0], t(5)[1], t(5)[2], notOne.length === 0, notOne.join(", "));
    const notUrn = bad((e) => typeof e.identifier === "string" && URN_RE.test(e.identifier));
    check("catalog", t(6)[0], t(6)[1], t(6)[2], notUrn.length === 0, notUrn.join(", "));
    const badExt = objs.flatMap((e) =>
      isObject(e.extensions) ? Object.keys(e.extensions).filter((k) => !EXT_KEY_RE.test(k)) : [],
    );
    check("catalog", t(7)[0], t(7)[1], t(7)[2], badExt.length === 0, badExt.join(", "));

    check("catalog", t(8)[0], t(8)[1], t(8)[2], !!cardEntry, `no entry of type ${SERVER_CARD_TYPE}`);
    if (cardEntry) {
      const repeated = ["displayName", "description", "version"].filter((k) => cardEntry[k] !== undefined);
      check("catalog", t(9)[0], t(9)[1], t(9)[2], repeated.length === 0, repeated.join(", "));
    } else {
      add("catalog", t(9)[0], t(9)[1], t(9)[2], "skip", "no card entry");
    }

    const linked = objs.filter((e) => typeof e.url === "string");
    if (!linked.length) {
      add("catalog", t(10)[0], t(10)[1], t(10)[2], "skip", "no entry has a url");
    } else {
      const broken: string[] = [];
      for (const e of linked) {
        const u = new URL(e.url as string, catalogUrl).href;
        const r = await get(u, { Accept: String(e.type) });
        const rt = (r?.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
        if (!r || r.status !== 200) broken.push(`${u} → ${r ? `HTTP ${r.status}` : "unreachable"}`);
        else if (rt !== String(e.type).toLowerCase()) broken.push(`${u} → "${rt}"`);
      }
      check("catalog", t(10)[0], t(10)[1], t(10)[2], broken.length === 0, broken.join("; "));
    }
  }

  // ── Tier: transport (Streamable HTTP, Security & Endpoint) ─────────────────
  const ping = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" });
  const rpcHeaders = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  let foreign: Response | null = null;
  try {
    foreign = await doFetch(target.mcpUrl, {
      method: "POST",
      headers: { ...rpcHeaders, Origin: "https://conformance-check.invalid" },
      body: ping,
      signal: AbortSignal.timeout(timeoutMs),
    });
    await foreign.body?.cancel();
  } catch {
    foreign = null;
  }
  // The spec: servers MUST validate Origin and answer 403 when it is "invalid", to prevent DNS
  // rebinding. It doesn't define "invalid", and the attack it names is on local servers. A public
  // remote server may accept every origin by design (Access-Control-Allow-Origin: *), so the check
  // is a MUST for local servers and a SHOULD for remote ones.
  const local = isLoopback(mcp);
  const originLevel: Level = local ? "must" : "should";
  if (!foreign) {
    add("transport", originLevel, "transport.origin-403", "A foreign Origin is refused with 403", "skip", "MCP endpoint unreachable");
  } else {
    check("transport", originLevel, "transport.origin-403", "A foreign Origin is refused with 403", foreign.status === 403,
      local
        ? `answered ${foreign.status}`
        : `answered ${foreign.status}; fine if this public server accepts every origin by design (the spec leaves "invalid" to the server)`);
  }
  if (!isLoopback(mcp)) {
    add("transport", "should", "transport.rebinding", "A local server refuses a foreign Host (DNS rebinding)", "skip",
      "not a local server");
  } else {
    const status = await (opts.rawStatus ?? rawStatus)(target.mcpUrl, { ...rpcHeaders, Host: "rebind.invalid" }, ping, timeoutMs);
    if (status === null) {
      add("transport", "should", "transport.rebinding", "A local server refuses a foreign Host (DNS rebinding)", "skip",
        "MCP endpoint unreachable");
    } else {
      check("transport", "should", "transport.rebinding", "A local server refuses a foreign Host (DNS rebinding)",
        status === 403, `Host: rebind.invalid answered ${status}`);
    }
  }

  // ── Tier: consistency (discovery.md § Consistency with Runtime Behavior) ─
  // The card is read before connecting; these compare it with what the server says once
  // connected (server/discover, or initialize for a legacy server). All SHOULD NOT contradict,
  // as in the spec. `name` is compared only when serverInfo.name is itself reverse-DNS: a short
  // name is not a contradiction of the card's reverse-DNS name.
  const cardObj = isObject(card) ? card : undefined;
  const remote = cardObj && Array.isArray(cardObj.remotes)
    ? (cardObj.remotes as unknown[]).filter(isObject).find((r) => r.url === target.mcpUrl)
    : undefined;
  const CONSISTENCY = [
    ["consistency.transport", "The card's remote for this endpoint says streamable-http, and it answers as one"],
    ["consistency.protocol-version", "The card's protocol versions don't contradict the server's"],
    ["consistency.version", "The card's version doesn't contradict the server's"],
    ["consistency.name", "The card's name doesn't contradict a reverse-DNS serverInfo.name"],
    ["consistency.title", "The card's title doesn't contradict the server's"],
    ["consistency.description", "The card's description doesn't contradict the server's"],
  ] as const;
  const C = Object.fromEntries(CONSISTENCY) as Record<(typeof CONSISTENCY)[number][0], string>;
  const cAdd = (id: keyof typeof C, status: Status, detail?: string) => add("consistency", "should", id, C[id], status, detail);
  const cCheck = (id: keyof typeof C, ok: boolean, detail: string) => check("consistency", "should", id, C[id], ok, detail);
  const skipAll = (why: string) => { for (const [id] of CONSISTENCY) cAdd(id, "skip", why); };
  if (!cardObj) {
    skipAll("no card to compare");
  } else {
    const live = await connect(doFetch, target.mcpUrl, rpcHeaders, timeoutMs);
    if (!live) {
      skipAll("MCP endpoint unreachable");
    } else if (live.status === 401 || live.status === 403) {
      skipAll(`needs authorization (${live.status})`);
    } else if (live.error) {
      if (remote) cAdd("consistency.transport", "fail", `card says ${String(remote.type)}; ${live.error}`);
      else cAdd("consistency.transport", "skip", "the card declares no remote for this endpoint");
      for (const [id] of CONSISTENCY.slice(1)) cAdd(id, "skip", "the server gave no server/discover or initialize result");
    } else {
      const via = `via ${live.via}`;
      if (!remote) {
        cAdd("consistency.transport", "skip", "the card declares no remote for this endpoint");
      } else {
        cCheck("consistency.transport", remote.type === "streamable-http",
          `card says ${JSON.stringify(remote.type)}; the endpoint answered ${live.via} over Streamable HTTP`);
      }

      const listed = remote && Array.isArray(remote.supportedProtocolVersions)
        ? remote.supportedProtocolVersions.filter((v): v is string => typeof v === "string")
        : undefined;
      const server = live.supportedVersions ?? [];
      if (!listed) {
        cAdd("consistency.protocol-version", "skip", "the card's remote lists no supportedProtocolVersions");
      } else if (live.via === "server/discover") {
        const extra = listed.filter((v) => !server.includes(v));
        cCheck("consistency.protocol-version", extra.length === 0,
          `card lists ${extra.join(", ")}, which the server doesn't support (server: ${server.join(", ")}; ${via})`);
      } else {
        cCheck("consistency.protocol-version", listed.includes(server[0]),
          `server agreed ${server[0]}; card lists ${listed.join(", ")} (${via})`);
      }

      const info = live.serverInfo ?? {};
      const compare = (id: "consistency.version" | "consistency.title" | "consistency.description", field: "version" | "title" | "description") => {
        const mine = cardObj[field];
        const theirs = info[field];
        if (typeof mine !== "string" || typeof theirs !== "string") cAdd(id, "skip", `card or server gives no ${field} (${via})`);
        else cCheck(id, mine === theirs, `card ${JSON.stringify(mine)} vs server ${JSON.stringify(theirs)} (${via})`);
      };
      compare("consistency.version", "version");
      if (typeof info.name === "string" && NAME_RE.test(info.name) && typeof cardObj.name === "string") {
        cCheck("consistency.name", info.name === cardObj.name, `card ${JSON.stringify(cardObj.name)} vs server ${JSON.stringify(info.name)} (${via})`);
      } else {
        cAdd("consistency.name", "skip", `serverInfo.name is not reverse-DNS, so it can't contradict the card's (${via})`);
      }
      compare("consistency.title", "title");
      compare("consistency.description", "description");
    }
  }

  const count = (s: Status) => results.filter((r) => r.status === s).length;
  return {
    mcpUrl: target.mcpUrl,
    cardUrl,
    catalogUrl,
    results,
    passed: count("pass"),
    failed: count("fail"),
    skipped: count("skip"),
    mustFailures: results.filter((r) => r.status === "fail" && r.level === "must").length,
  };
}
