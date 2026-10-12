/** The human report and the JSON shape, shared by the CLI and the web checker. */
import type { CheckResult, DiscoveryReport } from "./discovery.js";
import { SPEC_REFS } from "./refs.js";

export function withRefs(report: DiscoveryReport) {
  return { ...report, results: report.results.map((r) => ({ ...r, spec: SPEC_REFS[r.id] })) };
}

const MARK: Record<CheckResult["status"], string> = { pass: "✓", fail: "✗", skip: "–" };

export function render(report: DiscoveryReport, unreachable: boolean, version: string): string {
  const lines = [`server-card-check ${version} · ${report.mcpUrl}`];
  if (unreachable) return [...lines, "", "Nothing answered: the server could not be reached."].join("\n");
  lines.push(`card: ${report.cardUrl ?? "not found"} · catalog: ${report.catalogUrl}`);
  for (const tier of ["card", "hosting", "catalog", "transport"] as const) {
    const rs = report.results.filter((r) => r.tier === tier);
    if (!rs.length) continue;
    lines.push("", tier.toUpperCase());
    const details = new Set(rs.map((r) => r.detail));
    if (rs.every((r) => r.status === "skip") && details.size === 1) {
      lines.push(`  – ${rs.length} checks skipped: ${rs[0].detail ?? "not applicable"}`);
      continue;
    }
    for (const r of rs) {
      lines.push(`  ${MARK[r.status]} ${r.level === "must" ? "MUST  " : "SHOULD"} ${r.title}`);
      if (r.status !== "pass" && r.detail) lines.push(`           ${r.detail}`);
      if (r.status === "fail" && SPEC_REFS[r.id]) lines.push(`           ${SPEC_REFS[r.id].label}`);
    }
  }
  lines.push(
    "",
    `${report.passed} passed · ${report.failed} failed · ${report.skipped} skipped · ` +
      (report.mustFailures ? `${report.mustFailures} MUST failure${report.mustFailures === 1 ? "" : "s"}` : "no MUST failures"),
  );
  return lines.join("\n");
}
