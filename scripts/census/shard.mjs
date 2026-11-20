// How a census is split across parallel jobs (the weekly workflow). Keyed by host, so all of a
// host's endpoints are checked by one job, and a host never sees more parallel requests than
// that job's CONCURRENCY (8, the same as a single local run).
// Hosts with BIG_HOST or more endpoints each get a job of their own (2026-11-20: one gateway
// with 1,936 endpoints took 39 of 89 check-hours); the rest are split by a hash of the host.
export const BIG_HOST = 500;

export function hostOf(url) {
  try { return new URL(url).hostname.toLowerCase(); } catch { return ""; }
}

/** FNV-1a over the lowercased hostname: stable across runs and machines. */
export function hashShard(url, n) {
  let h = 0x811c9dc5;
  for (const c of hostOf(url)) { h ^= c.codePointAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h % n;
}

/** The plan for a list of servers: { big: [host…], hashed: n }. Job i < big.length = that host. */
export function plan(servers, hashed = 4) {
  const count = {};
  for (const s of servers) { const h = hostOf(s.url); count[h] = (count[h] ?? 0) + 1; }
  const big = Object.entries(count).filter(([, n]) => n >= BIG_HOST).sort((a, b) => b[1] - a[1]).map(([h]) => h);
  return { big, hashed };
}

/** Does job `shard` of `p` check this URL? */
export function inShard(url, p, shard) {
  const h = hostOf(url);
  if (shard < p.big.length) return h === p.big[shard];
  return !p.big.includes(h) && hashShard(url, p.hashed) === shard - p.big.length;
}

export const jobs = (p) => p.big.length + p.hashed;
