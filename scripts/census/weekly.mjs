// Step 4 of the weekly census: the figures summary.json doesn't carry, from CENSUS_DIR's
// census.jsonl (+ PREV_DIR's, the previous run, when given). Writes weekly.json.
// summary.json stays exactly as summarize.mjs makes it, so older runs reproduce unchanged.
//   - top_publishers: the three namespaces with the most valid cards, and every count again
//     without them (2026-11-20: three publishers held 3,810 of 5,544 valid cards)
//   - vs_previous: endpoints new, gone, turned valid, lost a valid card since the last run
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { hostOf } from "./shard.mjs";

const dir = process.env.CENSUS_DIR;
const read = (d) => readFileSync(`${d}/census.jsonl`, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
const valid = (r) => r.status?.["card.schema-valid"] === "pass";
const ns = (r) => (r.name ?? "").split("/")[0];
const pct = (a, b) => (b ? Math.round((10000 * a) / b) / 100 : 0);
const rows = read(dir);
const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

const byNs = {};
for (const r of rows) if (valid(r)) byNs[ns(r)] = (byNs[ns(r)] ?? 0) + 1;
const top = Object.entries(byNs).sort((a, b) => b[1] - a[1]).slice(0, 3);
const topSet = new Set(top.map(([n]) => n));
const rest = rows.filter((r) => !topSet.has(ns(r)));
const restValid = rest.filter(valid);
const restHosts = new Set(rest.map((r) => hostOf(r.url)));
const restValidHosts = new Set(restValid.map((r) => hostOf(r.url)));

const W = {
  checker_version: pkg.version, // the checkout that ran this script: in the workflow, the one that ran the probe
  checked: rows.length,
  top_publishers: top.map(([namespace, valid_cards]) => ({ namespace, valid_cards })),
  without_top_three: {
    endpoints_checked: rest.length, valid_cards: restValid.length, valid_pct_of_endpoints: pct(restValid.length, rest.length),
    hosts_checked: restHosts.size, hosts_with_valid_card: restValidHosts.size, valid_pct_of_hosts: pct(restValidHosts.size, restHosts.size),
  },
};

const prevDir = process.env.PREV_DIR;
if (prevDir && existsSync(`${prevDir}/census.jsonl`)) {
  const prev = new Map(read(prevDir).map((r) => [r.url, r]));
  const now = new Map(rows.map((r) => [r.url, r]));
  const existing = rows.filter((r) => prev.has(r.url));
  W.vs_previous = {
    previous_first_check: [...prev.values()].map((r) => r.checked_at).sort()[0],
    new_endpoints: rows.length - existing.length,
    gone_endpoints: [...prev.keys()].filter((u) => !now.has(u)).length,
    valid_on_new_endpoints: rows.filter((r) => !prev.has(r.url) && valid(r)).length,
    existing_turned_valid: existing.filter((r) => valid(r) && !valid(prev.get(r.url))).length,
    existing_lost_valid: existing.filter((r) => !valid(r) && valid(prev.get(r.url))).length,
  };
}
writeFileSync(`${dir}/weekly.json`, JSON.stringify(W, null, 2) + "\n");
console.log(JSON.stringify(W, null, 2));
