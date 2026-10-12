// Step 3 of the census: the counts reported in reference.md, from CENSUS_DIR's
// registry-remotes.json + census.jsonl. Pure arithmetic over the rows; no network.
import { readFileSync, writeFileSync } from "node:fs";

const dir = process.env.CENSUS_DIR;
const reg = JSON.parse(readFileSync(`${dir}/registry-remotes.json`, "utf8"));
const rows = readFileSync(`${dir}/census.jsonl`, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const st = (r, k) => r.status?.[k];
const host = (u) => { try { return new URL(u).hostname.toLowerCase(); } catch { return ""; } };
const ns = (r) => (r.name ?? "").split("/")[0];
// The single largest emitter is reported separately (2026-10-12: one gateway, 1,791 cards).
const top = Object.entries(rows.filter((r) => st(r, "card.schema-valid") === "pass")
  .reduce((m, r) => ((m[ns(r)] = (m[ns(r)] ?? 0) + 1), m), {})).sort((a, b) => b[1] - a[1])[0]?.[0];
const isTop = (r) => ns(r) === top;

const valid = rows.filter((r) => st(r, "card.schema-valid") === "pass");
const cards = rows.filter((r) => st(r, "card.json") === "pass");
const byNs = rows.reduce((m, r) => ((m[ns(r)] ??= []).push(r), m), {});
const nsWithValid = Object.values(byNs).filter((g) => g.some((r) => st(r, "card.schema-valid") === "pass")).length;
const single = Object.values(byNs).filter((g) => g.length === 1);
const pct = (a, b) => Math.round((10000 * a) / b) / 100;
const t = rows.map((r) => r.checked_at).sort();

const S = {
  registry_fetched_at: reg.fetched_at, census_window: [t[0], t.at(-1)],
  registry_entries_read: reg.entries, unique_remote_urls: reg.unique, templated_skipped: reg.servers.filter((s) => s.templated).length,
  checked: rows.length, errors: rows.filter((r) => r.error).length,
  answered_200_at_a_card_location: rows.filter((r) => st(r, "card.found") === "pass").length,
  of_which_not_json: rows.filter((r) => st(r, "card.json") === "fail").length,
  json_cards: cards.length,
  schema_valid_cards: valid.length, schema_valid_pct: pct(valid.length, rows.length),
  largest_emitter_namespace: top, largest_emitter_valid: valid.filter(isTop).length,
  excl_largest_valid: valid.filter((r) => !isTop(r)).length, excl_largest_checked: rows.filter((r) => !isTop(r)).length,
  distinct_hosts_checked: new Set(rows.map((r) => host(r.url))).size,
  distinct_hosts_with_valid_card: new Set(valid.map((r) => host(r.url))).size,
  namespaces: Object.keys(byNs).length, namespaces_with_valid_card: nsWithValid,
  single_server_namespaces: single.length, single_server_with_valid_card: single.filter((g) => st(g[0], "card.schema-valid") === "pass").length,
  valid_found_at_reserved_path: valid.filter((r) => (r.card_url ?? "").startsWith(r.url.replace(/\/$/, "")) && (r.card_url ?? "").replace(/\/$/, "").endsWith("/server-card")).length,
  json_cards_with_acao_star: cards.filter((r) => st(r, "hosting.cors-origin") === "pass").length,
  json_cards_with_all_listed_cors: cards.filter((r) => ["hosting.cors-origin", "hosting.cors-expose", "hosting.cors-preflight"].every((k) => st(r, k) === "pass")).length,
  json_cards_with_etag_304: cards.filter((r) => st(r, "hosting.etag") === "pass").length,
};
S.excl_largest_valid_pct = pct(S.excl_largest_valid, S.excl_largest_checked);
writeFileSync(`${dir}/summary.json`, JSON.stringify(S, null, 2) + "\n");
console.log(JSON.stringify(S, null, 2));
