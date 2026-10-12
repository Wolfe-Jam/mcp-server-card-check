// The stranger path: pack, install the tarball into an empty folder, run the
// installed bin (a symlink, as npx runs it). Fails loudly on any mismatch.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const work = mkdtempSync(join(tmpdir(), "scc-smoke-"));
try {
  const tgz = execFileSync("npm", ["pack", "--silent", "--pack-destination", work], { encoding: "utf8", shell: process.platform === "win32" }).trim().split("\n").pop();
  writeFileSync(join(work, "package.json"), '{"name":"smoke","private":true}');
  execFileSync("npm", ["install", "--silent", "--no-audit", "--no-fund", join(work, tgz)], { cwd: work, stdio: "inherit", shell: process.platform === "win32" });
  // Windows installs a .cmd shim; it needs a shell to run.
  const win = process.platform === "win32";
  const bin = join(work, "node_modules", ".bin", "server-card-check" + (win ? ".cmd" : ""));
  const opt = (o = {}) => ({ ...o, shell: win });
  const version = execFileSync(bin, ["--version"], opt({ encoding: "utf8" })).trim();
  if (version !== `server-card-check ${pkg.version}`) throw new Error(`--version printed "${version}"`);
  const help = execFileSync(bin, ["--help"], opt({ encoding: "utf8" }));
  if (!help.includes("Usage:")) throw new Error("--help printed no usage");
  let code = 0;
  try { execFileSync(bin, [], opt({ stdio: "pipe" })); } catch (e) { code = e.status; }
  if (code !== 2) throw new Error(`no-argument run exited ${code}, expected 2`);
  // the packaged schema is found from the installed location
  execFileSync("node", ["-e", "import('server-card-check/validate').then(m => { if (m.cardValidator()({}) === null) process.exit(1) })"], { cwd: work, stdio: "inherit" });
  console.log(`smoke ok: ${tgz} installs; bin --version/--help/exit 2 behave; schema found`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
