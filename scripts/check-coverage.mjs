// The check-coverage gate: every check in SPEC_REFS must be driven to both "pass" and "fail"
// by some test, and its ID must appear in a test file. Runs the whole suite with an observer
// (test/support/observe.mjs) and fails if any check falls short.
import { spawnSync } from "node:child_process";
import { readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const root = join(import.meta.dirname, "..");
const log = join(tmpdir(), `scc-coverage-${process.pid}.tsv`);
if (existsSync(log)) rmSync(log);

const run = spawnSync(process.execPath, [
  "--import", "tsx", "--import", "./test/support/observe.mjs",
  "--test", "test/*.test.ts", "test/width/*.test.ts",
], { cwd: root, env: { ...process.env, SCC_COVERAGE_LOG: log }, stdio: ["ignore", "ignore", "inherit"] });
if (run.status !== 0) {
  console.error("check-coverage: the test suite failed; fix the tests first");
  process.exit(1);
}

const ids = [...readFileSync(join(root, "src/refs.ts"), "utf8").matchAll(/^\s*"([a-z]+\.[a-z0-9-]+)":/gm)].map((m) => m[1]);
const seen = new Map();
for (const line of readFileSync(log, "utf8").split("\n")) {
  if (!line) continue;
  const [id, status] = line.split("\t");
  if (!seen.has(id)) seen.set(id, new Set());
  seen.get(id).add(status);
}
const testText = ["test", "test/width"].flatMap((d) => readdirSync(join(root, d)).filter((f) => f.endsWith(".ts")).map((f) => readFileSync(join(root, d, f), "utf8"))).join("\n");
rmSync(log);

const gaps = [];
for (const id of ids) {
  const s = seen.get(id) ?? new Set();
  const missing = [!s.has("pass") && "never passes", !s.has("fail") && "never fails", !testText.includes(id) && "never asserted"].filter(Boolean);
  if (missing.length) gaps.push(`${id}: ${missing.join(", ")}`);
}
const unknown = [...seen.keys()].filter((id) => !ids.includes(id));
if (unknown.length) gaps.push(`emitted but missing from SPEC_REFS: ${unknown.join(", ")}`);

if (gaps.length) {
  console.error(`check-coverage: ${ids.length - gaps.length}/${ids.length} checks covered\n  ` + gaps.join("\n  "));
  process.exit(1);
}
console.log(`check-coverage: ${ids.length}/${ids.length} checks pass, fail and are asserted`);
