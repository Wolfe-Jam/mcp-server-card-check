// Step 2 of the census: run the SEP-2127 discovery checks against every registry remote.
// Read-only by construction: the fetch passed to the checker refuses anything but GET / OPTIONS,
// so the transport tier (a POST ping) is recorded as "skip" and nothing is ever sent to an MCP endpoint.
// Resumable: results append to data/census.jsonl; URLs already there are skipped.
import { readFileSync, appendFileSync, existsSync } from "node:fs";
import Ajv2020 from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { checkDiscovery } from "../../dist/discovery.js";

const UA = "server-card-check census (read-only SEP-2127 survey; +https://github.com/Wolfe-Jam/server-card-check)";
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 8);
const TIMEOUT_MS = 10_000;
const OUT = process.env.CENSUS_DIR + "/census.jsonl";

const schema = JSON.parse(readFileSync(new URL("../../schema/server-card.schema.v1.json", import.meta.url), "utf8"));
const ajv = new Ajv2020({ strict: false, allErrors: true });
(addFormatsModule.default ?? addFormatsModule)(ajv);
ajv.addSchema(schema, "server-card");
const validate = ajv.getSchema("server-card#/$defs/ServerCard");
const validateCard = (card) => (validate(card) ? null : ajv.errorsText(validate.errors).slice(0, 300));

const readOnlyFetch = (url, init = {}) => {
  const method = (init.method ?? "GET").toUpperCase();
  if (method !== "GET" && method !== "OPTIONS") return Promise.reject(new Error(`census is read-only: ${method} refused`));
  return fetch(url, { ...init, redirect: "follow", headers: { ...(init.headers ?? {}), "User-Agent": UA } });
};

const reg = JSON.parse(readFileSync(process.env.CENSUS_DIR + "/registry-remotes.json", "utf8"));
const done = new Set(existsSync(OUT) ? readFileSync(OUT, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l).url) : []);
const todo = reg.servers.filter((s) => !s.templated && !done.has(s.url));
const limit = Number(process.env.LIMIT ?? todo.length);
const queue = todo.slice(0, limit);
console.log(`registry ${reg.fetched_at} · unique ${reg.unique} · templated skipped ${reg.servers.filter((s) => s.templated).length} · already done ${done.size} · this run ${queue.length}`);

let n = 0;
async function worker() {
  while (queue.length) {
    const s = queue.shift();
    const started = Date.now();
    let row;
    try {
      const r = await checkDiscovery({ mcpUrl: s.url }, { fetch: readOnlyFetch, validateCard, timeoutMs: TIMEOUT_MS });
      const st = Object.fromEntries(r.results.map((x) => [x.id, x.status]));
      const detail = Object.fromEntries(r.results.filter((x) => x.status === "fail" && x.detail).map((x) => [x.id, x.detail.slice(0, 200)]));
      row = { url: s.url, name: s.name, version: s.version, checked_at: new Date().toISOString(), ms: Date.now() - started,
        card_url: r.cardUrl, must_failures: r.mustFailures, passed: r.passed, failed: r.failed, skipped: r.skipped, status: st, fail_detail: detail };
    } catch (e) {
      row = { url: s.url, name: s.name, version: s.version, checked_at: new Date().toISOString(), error: String(e).slice(0, 200) };
    }
    appendFileSync(OUT, JSON.stringify(row) + "\n");
    if (++n % 100 === 0) console.log(`${n} checked`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`done: ${n} this run`);
