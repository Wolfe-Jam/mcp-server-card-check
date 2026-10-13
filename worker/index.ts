/**
 * The web checker: the same checks as the CLI, nothing to install.
 *   GET /                         the form
 *   GET /check?url=…[&registry=…]  the report (HTML; add &format=json for JSON)
 *
 * It fetches URLs visitors type in, so: public http(s) hostnames only (no IP
 * literals, no localhost / .local / .internal), GET and OPTIONS only (never a
 * POST), 1 MiB per response, 10 checks a minute per visitor, and a 60-second
 * cache per target so the page can't be used to hammer anyone's server.
 */
import { checkDiscovery } from "../src/discovery.js";
import { render, withRefs } from "../src/report.js";
// ajv standalone: precompiled, no runtime eval (Workers ban it). npm run build:validator
import validate from "./validator.cjs";
import pkg from "../package.json";

interface Env {
  LIMITER?: { limit(opts: { key: string }): Promise<{ success: boolean }> };
}

const VERSION: string = pkg.version;
const UA = `server-card-check/${VERSION} (web; +https://github.com/Wolfe-Jam/mcp-server-card-check)`;
const MAX_BYTES = 1024 * 1024;
const TIMEOUT_MS = 8000;

const validateCard = (card: unknown): string | null =>
  (validate as any)(card) ? null : ((validate as any).errors ?? []).map((e: any) => `${e.instancePath || "/"} ${e.message}`).join("; ");

/** Public http(s) hostnames only. */
export function targetError(raw: string | null): string | null {
  if (!raw) return "Enter your server's MCP endpoint, e.g. https://example.com/mcp";
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return "That isn't a URL.";
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return "Only http(s) URLs can be checked.";
  if (u.username || u.password) return "URLs with credentials can't be checked.";
  const h = u.hostname.toLowerCase();
  if (/^[\d.]+$/.test(h) || h.includes(":") || h.startsWith("[")) return "Use a hostname, not an IP address.";
  if (h === "localhost" || /\.(localhost|local|internal|lan|home|corp)$/.test(h) || !h.includes(".")) return "Only public hostnames can be checked.";
  return null;
}

/** GET / OPTIONS only, a timeout, and at most 1 MiB read from any response. */
const safeFetch: typeof fetch = async (input, init = {}) => {
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "OPTIONS") throw new Error("read-only: the web checker never sends " + method);
  const res = await fetch(input as RequestInfo, {
    ...init,
    redirect: "follow",
    headers: { ...(init.headers as Record<string, string> | undefined), "User-Agent": UA },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.body) return res;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error("response over 1 MiB");
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    body.set(c, at);
    at += c.byteLength;
  }
  return new Response(body, { status: res.status, statusText: res.statusText, headers: res.headers });
};

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

const SECURITY_HEADERS = {
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};

function page(body: string, status = 200): Response {
  return new Response(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Server Card Check</title>
<style>
:root{--bg:#fff;--fg:#111;--muted:#555;--line:#ddd;--box:#f6f6f6;--ok:#137333;--bad:#b3261e}
@media (prefers-color-scheme:dark){:root{--bg:#121212;--fg:#eee;--muted:#aaa;--line:#333;--box:#1d1d1d;--ok:#7bd88f;--bad:#ff8a80}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,sans-serif}
main{max-width:760px;margin:0 auto;padding:24px 16px}
h1{font-size:1.4rem;margin:0 0 4px}p{color:var(--muted);margin:4px 0 16px}
form{display:grid;gap:8px;margin:16px 0}
input,button{font:inherit;padding:10px;border:1px solid var(--line);border-radius:6px;background:var(--bg);color:var(--fg)}
button{cursor:pointer;font-weight:600}
pre{background:var(--box);border:1px solid var(--line);border-radius:6px;padding:12px;overflow-x:auto;white-space:pre;font-size:13px}
.ok{color:var(--ok)}.bad{color:var(--bad)}a{color:inherit}
</style></head><body><main>
<h1>Server Card Check</h1>
<p>Checks an MCP server's Server Card (SEP-2127) and AI Catalog discovery, rule by rule. Read-only: GET and OPTIONS only. v${esc(VERSION)}</p>
<form action="/check" method="get">
<input name="url" type="url" required placeholder="https://example.com/mcp" aria-label="MCP endpoint URL">
<input name="registry" placeholder="MCP Registry name (optional), e.g. com.example/weather" aria-label="MCP Registry name">
<button>Check</button>
</form>
${body}
<p>Same checks as the CLI: <code>npx mcp-server-card-check &lt;url&gt;</code>. Source and method: github.com/Wolfe-Jam/mcp-server-card-check</p>
</main></body></html>`,
    { status, headers: { "content-type": "text/html; charset=utf-8", ...SECURITY_HEADERS } },
  );
}

export default {
  async fetch(request: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET") return new Response("method not allowed", { status: 405, headers: { allow: "GET" } });
    if (url.pathname === "/") return page("");
    if (url.pathname === "/health") return Response.json({ ok: true, version: VERSION });
    if (url.pathname !== "/check") return new Response("not found", { status: 404 });

    const json = url.searchParams.get("format") === "json";
    const target = url.searchParams.get("url");
    const registry = url.searchParams.get("registry")?.trim() || undefined;
    const err = targetError(target);
    if (err) return json ? Response.json({ error: err }, { status: 400 }) : page(`<p class="bad">${esc(err)}</p>`, 400);

    const visitor = request.headers.get("cf-connecting-ip") ?? "unknown";
    if (env.LIMITER && !(await env.LIMITER.limit({ key: visitor })).success) {
      const msg = "Too many checks; try again in a minute.";
      return json ? Response.json({ error: msg }, { status: 429 }) : page(`<p class="bad">${msg}</p>`, 429);
    }

    const cacheKey = new Request(`https://cache.server-card-check/v${VERSION}?u=${encodeURIComponent(target!)}&r=${encodeURIComponent(registry ?? "")}`);
    const cache = (caches as any).default as Cache;
    let report = await cache.match(cacheKey).then((r) => (r ? r.json() : null)) as ReturnType<typeof withRefs> | null;
    let answered = 1;
    if (!report) {
      answered = 0;
      const counting: typeof fetch = async (i, init) => {
        const r = await safeFetch(i, init);
        answered++;
        return r;
      };
      const raw = await checkDiscovery({ mcpUrl: target!, registryName: registry }, { fetch: counting, validateCard, timeoutMs: TIMEOUT_MS });
      for (const r of raw.results) if ((r.tier === "transport" || r.tier === "consistency") && r.status === "skip" && r.detail !== "no card to compare" && r.detail !== "the card declares no remote for this endpoint") {
        r.detail = "not run on the web (the CLI's --transport sends the POST checks)";
      }
      report = withRefs(raw);
      if (answered > 0) ctx.waitUntil(cache.put(cacheKey, Response.json(report, { headers: { "cache-control": "max-age=60" } })));
    }

    if (json) return Response.json(report, { headers: { "access-control-allow-origin": "*" } });
    const text = render(report, answered === 0, VERSION);
    const verdict = answered === 0 ? "" : report.mustFailures
      ? `<p class="bad">${report.mustFailures} MUST failure${report.mustFailures === 1 ? "" : "s"}.</p>`
      : `<p class="ok">No MUST failures.</p>`;
    const jsonLink = `/check?url=${encodeURIComponent(target!)}${registry ? `&registry=${encodeURIComponent(registry)}` : ""}&format=json`;
    return page(`${verdict}<pre>${esc(text)}</pre><p><a href="${esc(jsonLink)}">JSON</a></p>`);
  },
};
