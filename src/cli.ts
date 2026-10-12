#!/usr/bin/env node
/**
 * server-card-check: check an MCP server's Server Card (SEP-2127) and AI Catalog
 * discovery, rule by rule. Read-only by default: only GET and OPTIONS are sent;
 * --transport adds the two POST checks (Origin 403, DNS rebinding).
 *
 * Exit codes: 0 = no MUST fails · 1 = a MUST fails · 2 = usage error or nothing reachable.
 */
import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkDiscovery } from "./discovery.js";
import { cardValidator } from "./validate.js";
import { render, withRefs } from "./report.js";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
const UA = `server-card-check/${VERSION} (+https://github.com/Wolfe-Jam/server-card-check)`;

const HELP = `server-card-check ${VERSION}
Check an MCP server's Server Card (SEP-2127) and AI Catalog discovery, rule by rule.

Usage:
  server-card-check <mcp-url> [options]

Options:
  --json                 Machine-readable report
  --registry-name NAME   The server's MCP Registry name, compared with the card's name
  --card-url URL         Read the card from here instead of <mcp-url>/server-card
  --catalog-url URL      Read the AI Catalog from here instead of /.well-known/ai-catalog.json
  --timeout MS           Per-request timeout (default 10000)
  --transport            Also run the two POST checks against the MCP endpoint
  -V, --version          Print the version
  -h, --help             Print this help

Read-only by default (GET and OPTIONS only). Exit: 0 no MUST fails · 1 a MUST fails · 2 usage error or unreachable.`;

export interface CliResult { code: number; out: string }

export async function run(argv: string[], fetchImpl: typeof fetch = fetch): Promise<CliResult> {
  const opts: Record<string, string | boolean> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return { code: 0, out: HELP };
    if (a === "-V" || a === "--version") return { code: 0, out: `server-card-check ${VERSION}` };
    if (a === "--json" || a === "--transport") opts[a.slice(2)] = true;
    else if (["--registry-name", "--card-url", "--catalog-url", "--timeout"].includes(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) return { code: 2, out: `${a} needs a value\n\n${HELP}` };
      opts[a.slice(2)] = v;
    } else if (a.startsWith("-")) return { code: 2, out: `unknown option ${a}\n\n${HELP}` };
    else positional.push(a);
  }
  if (positional.length !== 1) return { code: 2, out: HELP };
  let mcpUrl: string;
  try {
    const u = new URL(positional[0]);
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error();
    mcpUrl = u.href.replace(/\/$/, positional[0].endsWith("/") ? "/" : "");
  } catch {
    return { code: 2, out: `not an http(s) URL: ${positional[0]}` };
  }
  const timeoutMs = opts.timeout ? Number(opts.timeout) : 10_000;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return { code: 2, out: `--timeout must be a positive number of milliseconds` };

  let answered = 0;
  const wrapped: typeof fetch = async (input, init = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    if (method === "POST" && !opts.transport) throw new Error("read-only: POST checks need --transport");
    const res = await fetchImpl(input, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), "User-Agent": UA } });
    answered++;
    return res;
  };

  const report = await checkDiscovery(
    {
      mcpUrl,
      registryName: opts["registry-name"] as string | undefined,
      cardUrl: opts["card-url"] as string | undefined,
      catalogUrl: opts["catalog-url"] as string | undefined,
    },
    { fetch: wrapped, validateCard: cardValidator(), timeoutMs },
  );
  if (!opts.transport) {
    for (const r of report.results) {
      if (r.tier === "transport" && r.status === "skip") r.detail = "read-only run (add --transport to send the POST checks)";
    }
  }
  const code = answered === 0 ? 2 : report.mustFailures > 0 ? 1 : 0;
  return { code, out: opts.json ? JSON.stringify(withRefs(report), null, 2) : render(report, answered === 0, VERSION) };
}

// npx and global installs run the bin through a symlink: compare real paths.
const isMain = (() => {
  try {
    return !!process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();
if (isMain) {
  run(process.argv.slice(2)).then(({ code, out }) => {
    (code === 2 && !out.startsWith("server-card-check") ? process.stderr : process.stdout).write(out + "\n");
    process.exit(code);
  });
}
