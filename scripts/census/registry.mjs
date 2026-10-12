// Step 1 of the census: every latest MCP Registry entry with a streamable-http remote.
// Read-only: paginates https://registry.modelcontextprotocol.io/v0.1/servers.
import { writeFileSync, readFileSync, existsSync } from "node:fs";
const CKPT = process.env.CENSUS_DIR + "/registry-checkpoint.json";

const BASE = "https://registry.modelcontextprotocol.io/v0.1/servers?limit=100";
const UA = "server-card-check census (read-only SEP-2127 survey; +https://github.com/Wolfe-Jam/server-card-check)";

let rows = [];
let cursor, pages = 0, entries = 0;
if (existsSync(CKPT)) ({ rows, cursor, pages, entries } = JSON.parse(readFileSync(CKPT, "utf8")));
async function page(url) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
      if (res.ok) return await res.json();
      console.error(`page ${pages + 1}: HTTP ${res.status} (attempt ${attempt})`);
    } catch (e) {
      console.error(`page ${pages + 1}: ${e.cause?.code ?? e.message} (attempt ${attempt})`);
    }
    await new Promise((r) => setTimeout(r, 2000 * attempt));
  }
  throw new Error(`registry page ${pages + 1} failed 5 times`);
}
do {
  const url = BASE + (cursor ? `&cursor=${encodeURIComponent(cursor)}` : "");
  const d = await page(url);
  for (const s of d.servers ?? []) {
    entries++;
    const srv = s.server ?? s;
    const meta = s._meta?.["io.modelcontextprotocol.registry/official"] ?? {};
    if (meta.isLatest === false) continue;
    for (const r of srv.remotes ?? []) {
      if (r.type === "streamable-http" && r.url) rows.push({ name: srv.name, version: srv.version, url: r.url });
    }
  }
  cursor = d.metadata?.nextCursor;
  pages++;
  if (pages % 25 === 0) {
    writeFileSync(CKPT, JSON.stringify({ rows, cursor, pages, entries }));
    console.log(`page ${pages} · entries ${entries} · remotes ${rows.length}`);
  }
} while (cursor);

// Templated URLs ({tenant}, {region}…) can't be probed as-is; keep them, flagged.
const seen = new Set();
const unique = [];
for (const r of rows) {
  if (seen.has(r.url)) continue;
  seen.add(r.url);
  unique.push({ ...r, templated: /[{}]/.test(r.url) });
}
const out = { fetched_at: new Date().toISOString(), source: BASE, pages, entries, remotes: rows.length, unique: unique.length, servers: unique };
writeFileSync(process.env.CENSUS_DIR + "/registry-remotes.json", JSON.stringify(out, null, 2) + "\n");
console.log(`pages ${pages} · entries ${entries} · latest streamable-http remotes ${rows.length} · unique URLs ${unique.length} · templated ${unique.filter((u) => u.templated).length}`);
