// Installed only by scripts/check-coverage.mjs (via --import): records every verdict a test
// run produces, one "id<TAB>status" line per result, to $SCC_COVERAGE_LOG.
import { appendFileSync } from "node:fs";

const log = process.env.SCC_COVERAGE_LOG;
if (log) {
  globalThis.__serverCardCheckObserve = (results) => {
    appendFileSync(log, results.map((r) => `${r.id}\t${r.status}\n`).join(""));
  };
}
