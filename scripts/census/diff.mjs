// Compare two published versions of the checker on the same live endpoints, read-only.
// Each endpoint is checked by version A and then version B within the same minute, so verdict
// changes come from the code, not from servers changing in between. Every changed verdict is
// listed, so a release can explain what it changes on real servers.
//
//   CENSUS_DIR=… A=0.1.1 B=0.3.3 SAMPLE=200 node scripts/census/diff.mjs
//
// The sample comes from a previous census (census.jsonl), weighted towards endpoints that
// serve something at a card location: half JSON cards, a quarter non-JSON 200s, a quarter at
// random. The order is seeded (SEED), so a run can be repeated.
// Output: $CENSUS_DIR/diff-A-B.json and diff-A-B.md (counts and examples; local data).
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";

const dir = process.env.CENSUS_DIR;
if (!dir) throw new Error("set CENSUS_DIR to a census folder (with census.jsonl)");
const A = process.env.A ?? "0.1.1";
const B = process.env.B ?? "latest";
const SAMPLE = Number(process.env.SAMPLE ?? 200);
const SEED = Number(process.env.SEED ?? 20261018);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 8);
const TIMEOUT_MS = 10_000;
const UA = "server-card-check version comparison (read-only SEP-2127 survey; +https://github.com/Wolfe-Jam/mcp-server-card-check)";

/** Installs mcp-server-card-check@version into its own folder and loads its library. */
async function load(version) {
  const prefix = join(tmpdir(), `scc-diff-${version}`);
  mkdirSync(prefix, { recursive: true });
  execFileSync("npm", ["install", "--prefix", prefix, "--no-save", "--no-audit", "--no-fund", "--prefer-online", `mcp-server-card-check@${version}`], { stdio: "ignore" });
  const pkgDir = join(prefix, "node_modules", "mcp-server-card-check");
  const real = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")).version;
  const { checkDiscovery } = await import(pathToFileURL(join(pkgDir, "dist", "discovery.js")).href);
  const { cardValidator } = await import(pathToFileURL(join(pkgDir, "dist", "validate.js")).href);
  return { version: real, checkDiscovery, validateCard: cardValidator() };
}

const readOnlyFetch = (url, init = {}) => {
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "OPTIONS") return Promise.reject(new Error(`read-only: ${method} refused`));
  return fetch(url, { ...init, redirect: "follow", headers: { ...(init.headers ?? {}), "User-Agent": UA } });
};

/** mulberry32: a small seeded PRNG, so the sample is reproducible. */
function rng(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(xs, rand) {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

const rows = readFileSync(join(dir, "census.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)).filter((r) => r.status);
const rand = rng(SEED);
const jsonCards = shuffle(rows.filter((r) => r.status["card.json"] === "pass"), rand);
const nonJson = shuffle(rows.filter((r) => r.status["card.json"] === "fail"), rand);
const rest = shuffle(rows.filter((r) => !["pass", "fail"].includes(r.status["card.json"])), rand);
const picked = new Map();
for (const [pool, n] of [[jsonCards, SAMPLE / 2], [nonJson, SAMPLE / 4], [rest, SAMPLE / 4]]) {
  for (const r of pool.slice(0, Math.round(n))) picked.set(r.url, r);
}
const sample = [...picked.keys()];

const a = await load(A);
const b = await load(B);
console.log(`comparing ${a.version} → ${b.version} on ${sample.length} endpoints (seed ${SEED}, read-only)`);

const per = []; // { url, a: {id: status}, b: {id: status}, bDetail: {id: detail} }
const queue = [...sample];
let n = 0;
async function worker() {
  while (queue.length) {
    const url = queue.shift();
    const one = async (v) => {
      try {
        const r = await v.checkDiscovery({ mcpUrl: url }, { fetch: readOnlyFetch, validateCard: v.validateCard, timeoutMs: TIMEOUT_MS });
        return {
          status: Object.fromEntries(r.results.map((x) => [x.id, x.status])),
          level: Object.fromEntries(r.results.map((x) => [x.id, x.level])),
          detail: Object.fromEntries(r.results.filter((x) => x.detail).map((x) => [x.id, x.detail.slice(0, 160)])),
          mustFailures: r.mustFailures,
        };
      } catch (e) {
        return { error: String(e).slice(0, 160) };
      }
    };
    const ra = await one(a);
    const rb = await one(b);
    per.push({ url, a: ra, b: rb });
    if (++n % 25 === 0) console.log(`${n} compared`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));

// Summarise per check: transitions for checks in both versions; distributions for new and retired ones.
const idsA = new Set(per.flatMap((p) => Object.keys(p.a.status ?? {})));
const idsB = new Set(per.flatMap((p) => Object.keys(p.b.status ?? {})));
const both = [...idsA].filter((id) => idsB.has(id)).sort();
const retired = [...idsA].filter((id) => !idsB.has(id)).sort();
const added = [...idsB].filter((id) => !idsA.has(id)).sort();
const changes = {};
for (const id of both) {
  for (const p of per) {
    const sa = p.a.status?.[id], sb = p.b.status?.[id];
    if (!sa || !sb || sa === sb) continue;
    const key = `${sa} → ${sb}`;
    changes[id] ??= {};
    changes[id][key] ??= { count: 0, examples: [] };
    changes[id][key].count++;
    if (changes[id][key].examples.length < 3) changes[id][key].examples.push(p.b.detail?.[id] ?? "");
  }
}
// Level changes (MUST ↔ SHOULD) move the exit code even when the status doesn't.
const levelChanges = {};
for (const id of both) {
  const la = per.find((p) => p.a.level?.[id])?.a.level[id];
  const lb = per.find((p) => p.b.level?.[id])?.b.level[id];
  if (la && lb && la !== lb) levelChanges[id] = `${la} → ${lb}`;
}
// Endpoints whose "has a MUST failure" (exit code 1) changes between versions.
const exitFlip = { "fail → pass": [], "pass → fail": [] };
for (const p of per) {
  if (p.a.error || p.b.error) continue;
  const fa = p.a.mustFailures > 0, fb = p.b.mustFailures > 0;
  if (fa && !fb) exitFlip["fail → pass"].push(p.url);
  if (!fa && fb) exitFlip["pass → fail"].push(p.url);
}

const dist = (ids, side) => Object.fromEntries(ids.map((id) => {
  const c = {};
  for (const p of per) { const s = p[side].status?.[id]; if (s) c[s] = (c[s] ?? 0) + 1; }
  return [id, c];
}));
const errors = { [a.version]: per.filter((p) => p.a.error).length, [b.version]: per.filter((p) => p.b.error).length };
const withMust = (side) => per.filter((p) => !p[side].error && p[side].mustFailures > 0).length;
const report = {
  compared_at: new Date().toISOString(), a: a.version, b: b.version, seed: SEED, endpoints: per.length, errors,
  endpoints_with_must_failures: { [a.version]: withMust("a"), [b.version]: withMust("b") },
  exit_code_changes: { "fail → pass": exitFlip["fail → pass"].length, "pass → fail": exitFlip["pass → fail"].length },
  level_changes: levelChanges, changes, added: dist(added, "b"), retired: dist(retired, "a"),
};

const stem = join(dir, `diff-${a.version}-${b.version}`);
writeFileSync(stem + ".json", JSON.stringify({ ...report, per }, null, 2) + "\n");
const md = [
  `# ${a.version} → ${b.version}: verdicts on ${per.length} live endpoints`,
  `*${report.compared_at} · seed ${SEED} · read-only (GET/OPTIONS) · errors: ${a.version} ${errors[a.version]}, ${b.version} ${errors[b.version]}*`,
  "", "## Exit code (any MUST failure)", "",
  `- endpoints with a MUST failure: ${a.version} **${report.endpoints_with_must_failures[a.version]}**, ${b.version} **${report.endpoints_with_must_failures[b.version]}**`,
  `- exit code 1 → 0: **${report.exit_code_changes["fail → pass"]}** · 0 → 1: **${report.exit_code_changes["pass → fail"]}**`,
  "", "## Level changes", "",
  ...(Object.keys(levelChanges).length ? Object.entries(levelChanges).map(([id, c]) => `- \`${id}\`: ${c}`) : ["- none"]),
  "", "## Changed verdicts (checks in both versions)", "",
  ...(Object.keys(changes).length ? Object.entries(changes).flatMap(([id, ks]) => Object.entries(ks).map(([k, v]) => `- \`${id}\` ${k}: **${v.count}**${v.examples.filter(Boolean).length ? ` — e.g. ${v.examples.filter(Boolean).map((e) => `"${e}"`).join("; ")}` : ""}`)) : ["- none"]),
  "", `## New in ${b.version}`, "", ...Object.entries(report.added).map(([id, c]) => `- \`${id}\`: ${Object.entries(c).map(([s, k]) => `${s} ${k}`).join(", ")}`),
  "", `## Retired since ${a.version}`, "", ...Object.entries(report.retired).map(([id, c]) => `- \`${id}\`: ${Object.entries(c).map(([s, k]) => `${s} ${k}`).join(", ")}`),
  "",
].join("\n");
writeFileSync(stem + ".md", md);
console.log(md);
