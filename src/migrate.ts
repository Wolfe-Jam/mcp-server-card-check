/**
 * Re-issue a catalog's urn:air identifiers in the v0.9 form, kind-less by default: urn:air:{publisher}:{name}.
 *
 * AI Catalog v0.9 (ADR-0030) reads urn:air:{publisher}:{name}[:{kind}]. Before v0.9 the same shape
 * was urn:air:{publisher}:{namespace}:{name}. So an identifier with two segments after the publisher
 * reads differently in each version: urn:air:example.com:hr:benefits-agent has the name "hr" in v0.9.
 * Nothing in the string says which reading its publisher meant, so the caller states it (`order`).
 *
 * The spec defines no migration mechanism (§ Catalog Projection: "Adopting a different primary
 * identifier after publication requires an explicit migration mechanism, which this specification
 * does not define"). This module records the former identifier on the new entry in a namespaced
 * extension (as § Catalog Projection suggests for replaced identifiers). On request it also keeps the
 * old entry as a time-boxed stub, marked with the lifecycle extension proposed in ai-catalog PR #97
 * (proposed, not adopted).
 * A conformant consumer still reads a stub as a listing of the artifact (§ Unrecognized Members), so
 * stubs are off by default.
 */
import { URN_RE } from "./discovery.js";

/** How to read two or more segments after the publisher. */
export type SegmentOrder = "namespace-name" | "name-kind";

/** The lifecycle extension key proposed in ai-catalog PR #97: proposed, not adopted. */
export const LIFECYCLE_EXT = "https://ai-catalog.org/extensions/lifecycle";

export interface MigrateOptions {
  /** Required when any identifier has two or more segments after the publisher. */
  order?: SegmentOrder;
  /** Exact new identifiers, by old identifier. Each old identifier must be in the catalog. */
  rename?: Record<string, string>;
  /** A shared map of renames for several catalogs: entries for identifiers not in this catalog are ignored. */
  map?: Record<string, string>;
  /** Keep each re-issued entry as a deprecated stub until this ISO 8601 date (its endOfLifeDate). */
  stubsUntil?: string;
  /** Extension key for the former identifiers. Default: the publisher's reverse-DNS + ".former-identifiers". */
  formerKey?: string;
  /** Today's date, for the stubs' deprecationDate (tests). */
  today?: string;
}

export interface IdChange { from: string; to: string }

export interface MigrateResult {
  /** The migrated catalog (a copy; the input is not changed). */
  catalog: Record<string, unknown>;
  changes: IdChange[];
  /** urn:air identifiers that stay: already one segment after the publisher, or renamed to themselves. */
  unchanged: string[];
  /** Old identifiers kept only by stubs from an earlier run. */
  stubbed: string[];
  /** Identifiers that are not urn:air with a domain publisher, left as they are. */
  other: string[];
  stubs: number;
  /** String values elsewhere in the entries that named an old identifier and now name the new one. */
  references: number;
  /** Things the caller should act on (signatures that no longer verify). */
  warnings: string[];
  /** Problems that stop the migration (the catalog is then returned unchanged). */
  errors: string[];
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}([T ][\d:.]+(Z|[+-]\d{2}:?\d{2})?)?$/;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parse(id: string): { publisher: string; segments: string[] } | null {
  const m = /^urn:air:([^:]+):(.+)$/i.exec(id);
  if (!m || !m[1].includes(".")) return null;
  const segments = m[2].split(":");
  return segments.every((s) => s.length > 0) ? { publisher: m[1], segments } : null;
}

/**
 * An entry an earlier run left as a stub: deprecated, and its successor in this catalog lists this
 * identifier among its former identifiers. A deprecated entry without that record is a real entry.
 */
function isStub(e: Record<string, unknown>, objs: Record<string, unknown>[]): boolean {
  const lc = isObject(e.extensions) ? e.extensions[LIFECYCLE_EXT] : undefined;
  if (!isObject(lc) || lc.status !== "deprecated" || !isObject(lc.deprecated)) return false;
  const next = lc.deprecated.replacedBy;
  if (typeof next !== "string" || typeof e.identifier !== "string") return false;
  return objs.some((o) => o.identifier === next && isObject(o.extensions) &&
    Object.values(o.extensions).some((v) => Array.isArray(v) && v.includes(e.identifier)));
}

/** Replace old identifiers in string values; signed Trust Manifests are left whole (a rewrite breaks the signature). */
function replaceDeep(v: unknown, map: Map<string, string>, count: { n: number }, signed: { n: number }, path: string[] = []): unknown {
  if (typeof v === "string" && map.has(v)) {
    count.n++;
    return map.get(v);
  }
  if (Array.isArray(v)) {
    return v.map((x) => {
      if (path[path.length - 1] === "trustManifests" && isObject(x) && "signature" in x) {
        const probe = { n: 0 };
        replaceDeep(x, map, probe, { n: 0 });
        if (probe.n) signed.n++;
        return x;
      }
      return replaceDeep(x, map, count, signed, path);
    });
  }
  if (isObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, replaceDeep(x, map, count, signed, [...path, k])]));
  return v;
}

export function migrateCatalog(input: unknown, opts: MigrateOptions = {}): MigrateResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const empty = (catalog: Record<string, unknown>): MigrateResult =>
    ({ catalog, changes: [], unchanged: [], stubbed: [], other: [], stubs: 0, references: 0, warnings, errors });
  if (!isObject(input) || !Array.isArray(input.entries)) {
    errors.push("not an AI Catalog: expected a JSON object with an entries array");
    return empty(isObject(input) ? input : {});
  }
  if (opts.stubsUntil !== undefined && !DATE_RE.test(opts.stubsUntil)) {
    errors.push(`stubs need an ISO 8601 end-of-life date, got ${opts.stubsUntil}`);
  }
  const entries = input.entries as unknown[];
  // Distinct identifiers, in catalog order (a multi-version entry repeats its identifier).
  const objs = entries.filter(isObject);
  const ids = [...new Set(objs.map((e) => e.identifier).filter((x): x is string => typeof x === "string"))];
  const onlyStubs = new Set(ids.filter((id) => objs.filter((e) => e.identifier === id).every((e) => isStub(e, objs))));
  const rename: Record<string, string> = {
    ...Object.fromEntries(Object.entries(opts.map ?? {}).filter(([old]) => ids.includes(old) && !onlyStubs.has(old))),
    ...opts.rename,
  };
  for (const old of Object.keys(rename)) {
    if (!ids.includes(old)) errors.push(`rename: ${old} is not an identifier in this catalog`);
    else if (!parse(old)) errors.push(`rename: ${old} is not urn:air with a domain publisher; this tool re-issues only those`);
  }
  const unchanged: string[] = [];
  const stubbed: string[] = [];
  const other: string[] = [];
  const pending: { from: string; publisher: string; name: string; qualifiers: string[] }[] = [];
  for (const id of ids) {
    const p = parse(id);
    if (!p) { other.push(id); continue; }
    if (onlyStubs.has(id) && !(id in rename)) { stubbed.push(id); continue; }
    if (p.segments.length === 1 && !(id in rename)) { unchanged.push(id); continue; }
    if (p.segments.length > 1 && !(id in rename) && !opts.order) {
      errors.push(`${id} has ${p.segments.length} segments after the publisher, which read differently before and after v0.9: pass --order namespace-name (pre-v0.9) or --order name-kind (v0.9)`);
      continue;
    }
    if (opts.order === "name-kind" && p.segments.length > 2 && !(id in rename)) {
      errors.push(`${id} has ${p.segments.length} segments after the publisher, more than v0.9's {name}:{kind}: name it with --rename`);
      continue;
    }
    const [name, qualifiers] = opts.order === "name-kind" || p.segments.length === 1
      ? [p.segments[0], p.segments.slice(1)]
      : [p.segments[p.segments.length - 1], p.segments.slice(0, -1)];
    pending.push({ from: id, publisher: p.publisher, name, qualifiers });
  }

  // The bare name when no other identifier from the same publisher wants it; otherwise name-qualifiers.
  // Names depend on the other identifiers in this catalog: pass one rename map to keep several catalogs alike.
  const key = (pub: string, name: string) => `${pub.toLowerCase()}:${name}`;
  const wanted = new Map<string, number>();
  for (const p of pending) wanted.set(key(p.publisher, p.name), (wanted.get(key(p.publisher, p.name)) ?? 0) + 1);
  const taken = new Set([...unchanged, ...stubbed, ...other].map((id) => id.toLowerCase()));
  const changes: IdChange[] = [];
  for (const p of pending) {
    let to = rename[p.from];
    if (to === undefined) {
      const bare = (wanted.get(key(p.publisher, p.name)) ?? 0) === 1 || p.qualifiers.length === 0;
      to = `urn:air:${p.publisher}:${bare ? p.name : [p.name, ...p.qualifiers].join("-")}`;
    } else if (!URN_RE.test(to)) {
      errors.push(`rename: ${to} is not urn:air:{publisher-domain}:{name}[:{kind}]`);
      continue;
    } else if (parse(to)!.publisher.toLowerCase() !== p.publisher.toLowerCase()) {
      errors.push(`rename: ${p.from} → ${to} changes the publisher; a re-issue keeps it`);
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
  const signed = { n: 0 };
  const stubs: Record<string, unknown>[] = [];
  const digested = { n: 0 };
  // Inline data with a digest: a rewrite would break the digest (§ Catalog Entry: digest), so it stays whole.
  const rewrite = (e: Record<string, unknown>): Record<string, unknown> => {
    if (!("data" in e) || typeof e.digest !== "string") return replaceDeep(e, map, count, signed) as Record<string, unknown>;
    const probe = { n: 0 };
    replaceDeep(e.data, map, probe, { n: 0 });
    if (probe.n) digested.n++;
    const { data, ...rest } = e;
    return { ...(replaceDeep(rest, map, count, signed) as Record<string, unknown>), data };
  };
  const migrated = entries.map((e) => {
    if (!isObject(e)) return e;
    const old = typeof e.identifier === "string" ? e.identifier : undefined;
    if (!old || !map.has(old) || isStub(e, objs)) return rewrite(e);
    const next = rewrite(e);
    count.n--; // the identifier itself is a change, not a reference
    const pub = parse(old)!.publisher.toLowerCase();
    const formerKey = opts.formerKey ?? `${pub.split(".").reverse().join(".")}.former-identifiers`;
    const ext = isObject(next.extensions) ? next.extensions : {};
    const prior = Array.isArray(ext[formerKey]) ? (ext[formerKey] as unknown[]) : [];
    next.extensions = { ...ext, [formerKey]: [...prior.filter((x) => x !== old), old] };
    if (opts.stubsUntil) {
      const stubExt = isObject(e.extensions) ? e.extensions : {};
      stubs.push({
        ...e,
        extensions: {
          ...stubExt,
          [LIFECYCLE_EXT]: {
            status: "deprecated",
            deprecated: {
              replacedBy: map.get(old),
              deprecationDate: opts.today ?? new Date().toISOString().slice(0, 10),
              endOfLifeDate: opts.stubsUntil,
            },
          },
        },
      });
    }
    return next;
  });
  if (signed.n) warnings.push(`${signed.n} signed Trust Manifest${signed.n === 1 ? "" : "s"} name an old identifier and were left unchanged: re-issue and re-sign them`);
  if (digested.n) warnings.push(`${digested.n} entr${digested.n === 1 ? "y has" : "ies have"} inline data with a digest that names an old identifier; the data was left unchanged: update it and its digest`);
  const outside = { n: 0 };
  replaceDeep(Object.fromEntries(Object.entries(input).filter(([k]) => k !== "entries")), map, outside, { n: 0 });
  if (outside.n) warnings.push(`${outside.n} value${outside.n === 1 ? "" : "s"} outside the entries (host, extensions) name an old identifier and were left unchanged`);
  if (changes.length && "signature" in input) warnings.push("the catalog is signed: its signature no longer verifies after this change; re-sign it");
  return {
    catalog: { ...input, entries: [...migrated, ...stubs] },
    changes,
    unchanged,
    stubbed,
    other,
    stubs: stubs.length,
    references: count.n,
    warnings,
    errors,
  };
}
