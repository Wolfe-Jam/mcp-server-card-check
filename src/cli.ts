#!/usr/bin/env node
/**
 * server-card-check: check an MCP server's Server Card (SEP-2127) and AI Catalog
 * discovery, rule by rule. Read-only by default: only GET and OPTIONS are sent;
 * --transport adds the POST checks: Origin 403, DNS rebinding, and the card vs the live server.
 *
 * Exit codes: 0 = no MUST fails · 1 = a MUST fails · 2 = usage error or nothing reachable.
 */
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkDiscovery } from "./discovery.js";
import { cardValidator } from "./validate.js";
import { render, withRefs } from "./report.js";
import { migrateCatalog, type SegmentOrder } from "./migrate.js";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version as string;
const UA = `server-card-check/${VERSION} (+https://github.com/Wolfe-Jam/mcp-server-card-check)`;

const HELP = `server-card-check ${VERSION}
Check an MCP server's Server Card (SEP-2127) and AI Catalog discovery, rule by rule.

Usage:
  server-card-check <mcp-url> [options]
  server-card-check migrate <catalog.json | catalog-url> [migrate options]

Options:
  --json                 Machine-readable report
  --registry-name NAME   The server's MCP Registry name, compared with the card's name
  --card-url URL         Read the card from here instead of <mcp-url>/server-card
  --catalog-url URL      Read the AI Catalog from here instead of /.well-known/ai-catalog.json
  --timeout MS           Per-request timeout (default 10000)
  --transport            Also connect: the transport checks, and the card vs the live server
  -V, --version          Print the version
  -h, --help             Print this help

Read-only by default (GET and OPTIONS only). Exit: 0 no MUST fails · 1 a MUST fails · 2 usage error or unreachable.

Migrate options (re-issue urn:air identifiers in the v0.9 form, kind-less by default: urn:air:{publisher}:{name}):
  --order ORDER          How to read two segments after the publisher: namespace-name (pre-v0.9)
                         or name-kind (v0.9). Required when the catalog has such identifiers
  --rename OLD=NEW       Use this new identifier for OLD (repeatable; NEW may carry a kind)
  --map FILE             A JSON object of OLD: NEW renames shared by several catalogs; ids not in
                         this catalog are skipped (--rename wins over it)
  --former-key KEY       Extension key for the former identifiers (default: <reverse-DNS publisher>.former-identifiers)
  --stubs-until DATE     Also keep each old entry until DATE (ISO 8601) as a deprecated stub, marked with
                         the lifecycle extension proposed in ai-catalog PR #97 (proposed, not adopted)
  --out FILE             Write the migrated catalog here (without it, a dry run)
  --json                 Machine-readable result, with the migrated catalog`;

export interface CliResult { code: number; out: string }

export async function run(argv: string[], fetchImpl: typeof fetch = fetch): Promise<CliResult> {
  if (argv[0] === "migrate") return migrate(argv.slice(1), fetchImpl);
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
      if ((r.tier === "transport" || r.tier === "consistency") && r.status === "skip" && r.detail !== "no card to compare" && r.detail !== "the card declares no remote for this endpoint") {
        r.detail = "read-only run (add --transport to send the POST checks)";
      }
    }
  }
  const code = answered === 0 ? 2 : report.mustFailures > 0 ? 1 : 0;
  return { code, out: opts.json ? JSON.stringify(withRefs(report), null, 2) : render(report, answered === 0, VERSION) };
}

async function migrate(argv: string[], fetchImpl: typeof fetch): Promise<CliResult> {
  let order: SegmentOrder | undefined;
  let out: string | undefined;
  let stubsUntil: string | undefined;
  let formerKey: string | undefined;
  let json = false;
  const map: Record<string, string> = {};
  const rename: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") return { code: 0, out: HELP };
    if (a === "--json") json = true;
    else if (["--order", "--rename", "--out", "--map", "--stubs-until", "--former-key"].includes(a)) {
      const v = argv[++i];
      if (v === undefined || v.startsWith("--")) return { code: 2, out: `${a} needs a value\n\n${HELP}` };
      if (a === "--out") out = v;
      else if (a === "--stubs-until") stubsUntil = v;
      else if (a === "--former-key") formerKey = v;
      else if (a === "--order") {
        if (v !== "namespace-name" && v !== "name-kind") return { code: 2, out: `--order is namespace-name or name-kind, not ${v}` };
        order = v;
      } else if (a === "--map") {
        let m: unknown;
        try {
          m = JSON.parse(readFileSync(v, "utf8"));
        } catch (e) {
          return { code: 2, out: `cannot read --map ${v}: ${(e as Error).message}` };
        }
        if (typeof m !== "object" || m === null || Array.isArray(m) || !Object.values(m).every((x) => typeof x === "string")) {
          return { code: 2, out: `--map ${v} must be a JSON object of "old id": "new id"` };
        }
        Object.assign(map, m);
      } else {
        const eq = v.indexOf("=");
        if (eq < 1 || eq === v.length - 1) return { code: 2, out: `--rename takes OLD=NEW, got ${v}` };
        rename[v.slice(0, eq)] = v.slice(eq + 1);
      }
    } else if (a.startsWith("-")) return { code: 2, out: `unknown option ${a}\n\n${HELP}` };
    else positional.push(a);
  }
  if (positional.length !== 1) return { code: 2, out: HELP };
  const src = positional[0];

  let text: string;
  try {
    if (/^https?:\/\//i.test(src)) {
      const res = await fetchImpl(src, {
        headers: { "User-Agent": UA, Accept: "application/ai-catalog+json, application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) return { code: 2, out: `${src}: HTTP ${res.status}` };
      text = await res.text();
    } else text = readFileSync(src, "utf8");
  } catch (e) {
    return { code: 2, out: `cannot read ${src}: ${(e as Error).message}` };
  }
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return { code: 2, out: `${src} is not JSON` };
  }

  const r = migrateCatalog(input, { order, rename, map, stubsUntil, formerKey });
  if (r.errors.length) return { code: 2, out: r.errors.map((e) => `✗ ${e}`).join("\n") };
  if (out) {
    try {
      writeFileSync(out, JSON.stringify(r.catalog, null, 2) + "\n");
    } catch (e) {
      return { code: 2, out: `cannot write ${out}: ${(e as Error).message}` };
    }
  }
  if (json) return { code: 0, out: JSON.stringify({ source: src, order: order ?? null, ...r }, null, 2) };

  const w = Math.max(0, ...r.changes.map((c) => c.from.length));
  const lines = [
    `server-card-check ${VERSION} · migrate ${src}`,
    ...(order ? [`Two segments after the publisher read as ${order === "namespace-name" ? "{namespace}:{name} (pre-v0.9)" : "{name}:{kind} (v0.9)"}`] : []),
    "",
    ...r.changes.map((c) => `  ${c.from.padEnd(w)}  →  ${c.to}`),
    ...r.unchanged.map((id) => `  ${id}  (stays)`),
    ...r.stubbed.map((id) => `  ${id}  (stub from an earlier run)`),
    ...r.other.map((id) => `  ${id}  (not urn:air with a domain publisher, left as is)`),
    ...r.warnings.map((x) => `  ! ${x}`),
    "",
    `${r.changes.length} re-issued${r.changes.length ? " (former ids kept in extensions)" : ""}` +
      (r.stubs ? ` · ${r.stubs} deprecated stub${r.stubs === 1 ? "" : "s"} until ${stubsUntil}` : "") +
      (r.references ? ` · ${r.references} reference${r.references === 1 ? "" : "s"} updated` : "") +
      (out ? ` · written to ${out}` : r.changes.length ? " · dry run (add --out FILE to write)" : ""),
  ];
  return { code: 0, out: lines.join("\n") };
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
