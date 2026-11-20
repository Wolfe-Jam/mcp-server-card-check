// The weekly census PR body, from <dir>/summary.json + weekly.json. Facts only, no prose.
//   node scripts/census/pr-body.mjs <dir> <expected endpoints>
import { readFileSync } from "node:fs";
const [dir, expected] = process.argv.slice(2);
const S = JSON.parse(readFileSync(`${dir}/summary.json`, "utf8"));
const W = JSON.parse(readFileSync(`${dir}/weekly.json`, "utf8"));
const n = (x) => Number(x).toLocaleString("en-US");
const out = [
  `Checker ${W.checker_version} · registry read ${S.registry_fetched_at} · window ${S.census_window.join(" → ")}`,
  "",
  `Checked **${n(S.checked)}** of ${n(expected)} endpoints · errors ${n(S.errors)}${S.checked < Number(expected) ? " · **incomplete: a job ran out of time**" : ""}`,
  "",
  "| | |",
  "|---|---|",
  `| Schema-valid cards | ${n(S.schema_valid_cards)} (${S.schema_valid_pct}% of endpoints) |`,
  `| Hosts with a valid card | ${n(S.distinct_hosts_with_valid_card)} of ${n(S.distinct_hosts_checked)} |`,
  `| Namespaces with a valid card | ${n(S.namespaces_with_valid_card)} of ${n(S.namespaces)} |`,
  `| Top three publishers | ${W.top_publishers.map((p) => `${p.namespace} ${n(p.valid_cards)}`).join(" · ")} |`,
  `| Without them, by host | ${W.without_top_three.valid_pct_of_hosts}% (${n(W.without_top_three.hosts_with_valid_card)} of ${n(W.without_top_three.hosts_checked)}) |`,
  `| Without them, by endpoint | ${W.without_top_three.valid_pct_of_endpoints}% |`,
];
if (W.vs_previous) {
  const v = W.vs_previous;
  out.push(`| Since the last run | +${n(v.new_endpoints)} endpoints (${n(v.valid_on_new_endpoints)} valid) · ${n(v.gone_endpoints)} gone · ${n(v.existing_turned_valid)} existing turned valid · ${n(v.existing_lost_valid)} lost a valid card |`);
} else {
  out.push("| Since the last run | not available (no previous workflow run) |");
}
out.push("", "Merge to publish this week's figures: `docs/census/<date>/summary.json` + `weekly.json`. The reference.md write-up follows by hand.");
console.log(out.join("\n"));
