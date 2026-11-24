/**
 * Re-issue a catalog's urn:air identifiers in the kind-less v0.9 form, urn:air:{publisher}:{name}.
 *
 * AI Catalog v0.9 (ADR-0030) reads urn:air:{publisher}:{name}[:{kind}]. Before v0.9 the same shape
 * was urn:air:{publisher}:{namespace}:{name}. So an identifier with two segments after the publisher
 * reads differently in each version: urn:air:example.com:hr:benefits-agent has the name "hr" in v0.9.
 * Nothing in the string says which reading its publisher meant, so the caller states it (`order`).
 *
 * The spec defines no migration mechanism (§ Catalog Entry identifiers: "Adopting a different primary
 * identifier after publication requires an explicit migration mechanism, which this specification
 * does not define"). This module keeps the old entry as a stub with `lifecycle: "deprecated"` and
 * `supersededBy`, the spec's own example of a candidate field (§ Unrecognized members); consumers
 * that do not know those fields ignore them.
 */
import { URN_RE } from "./discovery.js";

/** How to read two or more segments after the publisher. */
export type SegmentOrder = "namespace-name" | "name-kind";

export interface MigrateOptions {
  /** Required when any identifier has two or more segments after the publisher. */
  order?: SegmentOrder;
  /** Exact new identifiers for some old ones, by old identifier. */
  rename?: Record<string, string>;
  /** Keep a deprecated stub per re-issued entry (default true). */
  stubs?: boolean;
}

export interface IdChange { from: string; to: string }

export interface MigrateResult {
  /** The migrated catalog (a copy; the input is not changed). */
  catalog: Record<string, unknown>;
  changes: IdChange[];
  /** urn:air identifiers already kind-less, left as they are. */
  unchanged: string[];
  /** Identifiers that are not urn:air, left as they are. */
  other: string[];
  stubs: number;
  /** String values elsewhere in the entries that named an old identifier and now name the new one. */
  references: number;
  /** Problems that stop the migration (the catalog is then returned unchanged). */
  errors: string[];
}

const KINDLESS_RE = /^urn:air:[^:]+\.[^:]+:[^:]+$/i;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parse(id: string): { publisher: string; segments: string[] } | null {
  const m = /^urn:air:([^:]+):(.+)$/i.exec(id);
  if (!m || !m[1].includes(".")) return null;
  const segments = m[2].split(":");
  return segments.every((s) => s.length > 0) ? { publisher: m[1], segments } : null;
}

function replaceDeep(v: unknown, map: Map<string, string>, count: { n: number }): unknown {
  if (typeof v === "string" && map.has(v)) {
    count.n++;
    return map.get(v);
  }
  if (Array.isArray(v)) return v.map((x) => replaceDeep(x, map, count));
  if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, replaceDeep(x, map, count)]));
  return v;
}

export function migrateCatalog(input: unknown, opts: MigrateOptions = {}): MigrateResult {
  const errors: string[] = [];
  const empty = (catalog: Record<string, unknown>): MigrateResult =>
    ({ catalog, changes: [], unchanged: [], other: [], stubs: 0, references: 0, errors });
  if (!isObject(input) || !Array.isArray(input.entries)) {
    errors.push("not an AI Catalog: expected a JSON object with an entries array");
    return empty(isObject(input) ? input : {});
  }
  const entries = input.entries as unknown[];
  const rename = opts.rename ?? {};

  // Distinct identifiers, in catalog order (a multi-version entry repeats its identifier).
  const ids = [...new Set(entries.filter(isObject).map((e) => e.identifier).filter((x): x is string => typeof x === "string"))];
  for (const old of Object.keys(rename)) {
    if (!ids.includes(old)) errors.push(`--rename: ${old} is not an identifier in this catalog`);
  }
  const unchanged: string[] = [];
  const other: string[] = [];
  const pending: { from: string; publisher: string; name: string; qualifiers: string[] }[] = [];
  for (const id of ids) {
    const p = parse(id);
    if (!p) { other.push(id); continue; }
    if (p.segments.length === 1 && !(id in rename)) { unchanged.push(id); continue; }
    if (p.segments.length > 1 && !(id in rename) && !opts.order) {
      errors.push(`${id} has ${p.segments.length} segments after the publisher, which read differently before and after v0.9: pass --order namespace-name (pre-v0.9) or --order name-kind (v0.9)`);
      continue;
    }
    const [name, qualifiers] = opts.order === "name-kind" || p.segments.length === 1
      ? [p.segments[0], p.segments.slice(1)]
      : [p.segments[p.segments.length - 1], p.segments.slice(0, -1)];
    pending.push({ from: id, publisher: p.publisher, name, qualifiers });
  }

  // The bare name when no other identifier from the same publisher wants it; otherwise name-qualifiers.
  const key = (pub: string, name: string) => `${pub.toLowerCase()}:${name}`;
  const wanted = new Map<string, number>();
  for (const p of pending) wanted.set(key(p.publisher, p.name), (wanted.get(key(p.publisher, p.name)) ?? 0) + 1);
  const taken = new Set([...unchanged, ...other].map((id) => id.toLowerCase()));
  const changes: IdChange[] = [];
  for (const p of pending) {
    let to = rename[p.from];
    if (to === undefined) {
      const bare = (wanted.get(key(p.publisher, p.name)) ?? 0) === 1 || p.qualifiers.length === 0;
      to = `urn:air:${p.publisher}:${bare ? p.name : [p.name, ...p.qualifiers].join("-")}`;
    } else if (!URN_RE.test(to)) {
      errors.push(`--rename: ${to} is not urn:air:{publisher-domain}:{name}[:{kind}]`);
      continue;
    } else if (!KINDLESS_RE.test(to)) {
      errors.push(`--rename: ${to} carries a kind; this tool re-issues kind-less identifiers`);
      continue;
    }
    if (taken.has(to.toLowerCase()) || ids.some((id) => id !== p.from && id.toLowerCase() === to!.toLowerCase())) {
      errors.push(`${p.from} → ${to} collides with an identifier already in use: name it with --rename ${p.from}=<new>`);
      continue;
    }
    taken.add(to.toLowerCase());
    if (to !== p.from) changes.push({ from: p.from, to });
    else unchanged.push(p.from);
  }
  if (errors.length) return empty(input);

  const map = new Map(changes.map((c) => [c.from, c.to]));
  const count = { n: 0 };
  const stubs: Record<string, unknown>[] = [];
  const migrated = entries.map((e) => {
    if (!isObject(e)) return e;
    const old = typeof e.identifier === "string" ? e.identifier : undefined;
    const next = replaceDeep(e, map, count) as Record<string, unknown>;
    if (old && map.has(old)) {
      count.n--; // the identifier itself is a change, not a reference
      if (opts.stubs !== false) stubs.push({ ...e, lifecycle: "deprecated", supersededBy: map.get(old) });
    }
    return next;
  });
  return {
    catalog: { ...input, entries: [...migrated, ...stubs] },
    changes,
    unchanged,
    other,
    stubs: stubs.length,
    references: count.n,
    errors,
  };
}
