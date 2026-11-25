/**
 * Re-issue a catalog's urn:air identifiers that read differently before and after AI Catalog v0.9.
 *
 * AI Catalog v0.9 (ADR-0030) reads urn:air:{publisher}:{name}[:{kind}]. Before v0.9 the same shape
 * was urn:air:{publisher}:{namespace}:{name}. So an identifier with two segments after the publisher
 * reads differently in each version: urn:air:example.com:hr:benefits-agent has the name "hr" in v0.9.
 * Nothing in the string says which reading its publisher meant, so the caller states it (`order`).
 * With the pre-v0.9 reading, ids are re-issued as urn:air:{publisher}:{name}, which can't be read the
 * wrong way round (v0.9 reads it as a name with no kind), or as the caller names them. With the v0.9 reading, ids are already valid and only
 * the caller's renames apply.
 *
 * The spec defines no migration mechanism (§ Catalog Projection: "Adopting a different primary
 * identifier after publication requires an explicit migration mechanism, which this specification
 * does not define"). This module records the former identifier on the new entry in a namespaced
 * extension, borrowing the pattern § Catalog Projection gives operators for replaced source
 * identifiers. On request it also keeps the old entry as a time-boxed stub, marked with the lifecycle
 * extension proposed in ai-catalog PR #97 (proposed, not adopted: experimental). A conformant consumer
 * still reads a stub as a listing of the artifact, so stubs are off by default.
 *
 * Only identifiers the caller publishes are re-issued (§ Catalog Projection: an operator MUST preserve
 * a publisher-authorized urn:air identifier). Inline `data` is opaque (§ Catalog Entry) and never
 * rewritten; nor are signed Trust Manifests.
 */
import { URN_AIR_RE } from "./discovery.js";

/** How to read two or more segments after the publisher. */
export type SegmentOrder = "namespace-name" | "name-kind";

/** The lifecycle extension key proposed in ai-catalog PR #97: proposed, not adopted (experimental). */
const LIFECYCLE_EXT = "https://ai-catalog.org/extensions/lifecycle";
/** § Extensions: Format and Key Naming: a URL or a reverse-DNS string. */
const EXT_KEY_RE = /^(https?:\/\/\S+|[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+)$/;

export interface MigrateOptions {
  /** Required when any identifier has two or more segments after the publisher. */
  order?: SegmentOrder;
  /** Publisher domains whose identifiers to re-issue. Required when the catalog holds more than one. */
  publishers?: string[];
  /** Exact new identifiers, by old identifier. Each old identifier must be in the catalog. */
  rename?: Record<string, string>;
  /** A shared map of renames for several catalogs: entries for identifiers not in this catalog are ignored. */
  map?: Record<string, string>;
  /** Keep each re-issued entry as a deprecated stub until this future date, YYYY-MM-DD (its endOfLifeDate). */
  stubsUntil?: string;
  /** Extension key for the former identifiers, a URL or reverse-DNS. Default: the publisher's reverse-DNS + ".former-identifiers". */
  formerKey?: string;
  /** Today's date, YYYY-MM-DD (tests). */
  today?: string;
}

export interface IdChange { from: string; to: string }

/** Why an urn:air identifier stays as it is. */
export type StayReason = "one-segment" | "valid-v0.9" | "already-reissued" | "renamed-to-itself";
export interface IdStay { id: string; reason: StayReason }

export interface MigrateResult {
  /** The migrated catalog (a copy; the input is not changed). */
  catalog: Record<string, unknown>;
  changes: IdChange[];
  /** The publishers whose identifiers are being re-issued. */
  publishers: string[];
  /** urn:air identifiers of those publishers that stay, and why. */
  unchanged: IdStay[];
  /** --rename pairs an earlier run already applied: the old id is gone and the new one is here. */
  appliedRenames: IdChange[];
  /** Old identifiers kept only by stubs from an earlier run. */
  skippedStubs: string[];
  /** urn:air identifiers from publishers not being re-issued, left as they are. */
  otherPublishers: string[];
  /** Identifiers that are not urn:air with a domain publisher, left as they are. */
  other: string[];
  stubCount: number;
  /** String values elsewhere in the entries that named an old identifier and now name the new one. */
  references: number;
  /** Things the caller should act on: data, signatures and values left unchanged. */
  warnings: string[];
  /** Problems that stop the migration (the catalog is then returned unchanged). */
  errors: string[];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `publisher` is lower-cased for comparison; `written` keeps the case the id was written in. */
function parse(id: string): { publisher: string; written: string; segments: string[] } | null {
  const m = /^urn:air:([^:]+):(.+)$/i.exec(id);
  if (!m || !m[1].includes(".")) return null;
  const segments = m[2].split(":");
  return segments.every((s) => s.length > 0) ? { publisher: m[1].toLowerCase(), written: m[1], segments } : null;
}

/** A real calendar date, YYYY-MM-DD. */
function isDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Some extension value on the entry is an array that lists this identifier. */
const listsFormer = (o: Record<string, unknown>, id: string) =>
  isObject(o.extensions) && Object.values(o.extensions).some((v) => Array.isArray(v) && v.includes(id));

/**
 * An entry an earlier run left as a stub: deprecated, and its successor in this catalog lists this
 * identifier among its former identifiers. A deprecated entry without that record is a real entry.
 */
function isStub(e: Record<string, unknown>, objs: Record<string, unknown>[]): boolean {
  const lc = isObject(e.extensions) ? e.extensions[LIFECYCLE_EXT] : undefined;
  if (!isObject(lc) || lc.status !== "deprecated" || !isObject(lc.deprecated)) return false;
  const next = lc.deprecated.replacedBy;
  if (typeof next !== "string" || typeof e.identifier !== "string") return false;
  return objs.some((o) => o.identifier === next && listsFormer(o, e.identifier as string));
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
  const empty = (catalog: Record<string, unknown>): MigrateResult => ({
    catalog, changes: [], publishers: [], unchanged: [], appliedRenames: [], skippedStubs: [], otherPublishers: [], other: [], stubCount: 0, references: 0, warnings, errors,
  });
  if (!isObject(input) || !Array.isArray(input.entries)) {
    errors.push("not an AI Catalog: expected a JSON object with an entries array");
    return empty(isObject(input) ? input : {});
  }
  const today = opts.today ?? new Date().toISOString().slice(0, 10);
  if (opts.stubsUntil !== undefined && (!isDate(opts.stubsUntil) || opts.stubsUntil <= today)) {
    errors.push(`stubs need a future end-of-life date, YYYY-MM-DD, got ${opts.stubsUntil}`);
  }
  if (opts.formerKey !== undefined && !EXT_KEY_RE.test(opts.formerKey)) {
    errors.push(`the former-identifiers key must be a URL or reverse-DNS (§ Extensions: Format and Key Naming), got "${opts.formerKey}"`);
  }
  const entries = input.entries as unknown[];
  // Distinct identifiers, in catalog order (a multi-version entry repeats its identifier).
  const objs = entries.filter(isObject);
  const ids = [...new Set(objs.map((e) => e.identifier).filter((x): x is string => typeof x === "string"))];
  const onlyStubs = new Set(ids.filter((id) => objs.filter((e) => e.identifier === id).every((e) => isStub(e, objs))));

  // Whose identifiers to re-issue: the caller's publishers, or the catalog's only one.
  const publishersHere = [...new Set(ids.map(parse).filter((p) => p !== null).map((p) => p!.publisher))];
  let mine: Set<string>;
  if (opts.publishers?.length) {
    mine = new Set(opts.publishers.map((p) => p.toLowerCase()));
    for (const p of mine) if (!publishersHere.includes(p)) errors.push(`--publisher ${p} matches no urn:air identifier in this catalog (publishers here: ${publishersHere.join(", ") || "none"})`);
  } else if (publishersHere.length > 1) {
    errors.push(`this catalog holds urn:air identifiers from ${publishersHere.length} publishers (${publishersHere.join(", ")}): pass --publisher for the ones you publish; others' identifiers stay as they are (§ Catalog Projection)`);
    mine = new Set();
  } else mine = new Set(publishersHere);

  // A rename whose old id is gone and whose new id is here was applied by an earlier run: done.
  const done = ([old, to]: [string, string]) => !ids.includes(old) && ids.includes(to);
  const appliedRenames: IdChange[] = Object.entries(opts.rename ?? {}).filter(done).map(([from, to]) => ({ from, to }));
  const explicit = Object.fromEntries(Object.entries(opts.rename ?? {}).filter((e) => !done(e)));
  const fromMap = Object.fromEntries(Object.entries(opts.map ?? {}).filter(([old]) => ids.includes(old) && !onlyStubs.has(old)));
  const rename: Record<string, string> = { ...fromMap, ...explicit };
  const label = (old: string) => (old in explicit ? "rename" : "map");
  for (const old of Object.keys(rename)) {
    const p = parse(old);
    if (!ids.includes(old)) errors.push(`${label(old)}: ${old} is not an identifier in this catalog`);
    else if (!p) errors.push(`${label(old)}: ${old} is not urn:air with a domain publisher; this tool re-issues only those`);
    else if (mine.size && !mine.has(p.publisher)) errors.push(`${label(old)}: ${old} belongs to ${p.publisher}, not a publisher being re-issued (--publisher)`);
  }
  // Already re-issued: an id a rename or the map produces, or an entry that records former identifiers.
  const targets = new Set(Object.values({ ...opts.map, ...explicit }).map((t) => t.toLowerCase()));
  // Independent of the record's key name: an extension array holding another id of the same publisher
  // that is no longer a live id here (a list of related live ids doesn't count),
  // or a stub from an earlier run that points here (a genuinely deprecated entry doesn't count).
  const reissued = (id: string) => {
    if (targets.has(id.toLowerCase())) return true;
    const pub = parse(id)?.publisher;
    return objs.some((o) => o.identifier === id && isObject(o.extensions) && Object.values(o.extensions).some((v) =>
      Array.isArray(v) && v.some((x) => typeof x === "string" && x !== id && parse(x)?.publisher === pub && (!ids.includes(x) || onlyStubs.has(x))))) ||
      objs.some((o) => isStub(o, objs) &&
        (((o.extensions as Record<string, unknown>)[LIFECYCLE_EXT] as Record<string, Record<string, unknown>>).deprecated.replacedBy === id));
  };

  const unchanged: IdStay[] = [];
  const skippedStubs: string[] = [];
  const otherPublishers: string[] = [];
  const other: string[] = [];
  const pending: { from: string; publisher: string; name: string; qualifiers: string[] }[] = [];
  for (const id of ids) {
    const p = parse(id);
    if (!p) { other.push(id); continue; }
    if (!mine.has(p.publisher)) { otherPublishers.push(id); continue; }
    if (onlyStubs.has(id) && (!(id in rename) || ids.includes(rename[id]))) { skippedStubs.push(id); continue; }
    if (id in rename) { pending.push({ from: id, publisher: p.written, name: "", qualifiers: [] }); continue; }
    if (reissued(id)) { unchanged.push({ id, reason: "already-reissued" }); continue; }
    if (p.segments.length === 1) { unchanged.push({ id, reason: "one-segment" }); continue; }
    if (!opts.order) {
      errors.push(`${id} has ${p.segments.length} segments after the publisher, which read differently before and after v0.9: pass --order namespace-name (pre-v0.9) or --order name-kind (v0.9)`);
      continue;
    }
    if (opts.order === "name-kind") {
      if (p.segments.length > 2) errors.push(`${id} has ${p.segments.length} segments after the publisher, more than v0.9's {name}:{kind}: name it with --rename`);
      else unchanged.push({ id, reason: "valid-v0.9" }); // only a rename changes it
      continue;
    }
    pending.push({ from: id, publisher: p.written, name: p.segments[p.segments.length - 1], qualifiers: p.segments.slice(0, -1) });
  }

  // The bare name when no other identifier from the same publisher wants it; otherwise name-qualifiers.
  // Names depend on the other identifiers in this catalog: pass one map to keep several catalogs alike.
  const key = (pub: string, name: string) => `${pub.toLowerCase()}:${name}`;
  const wanted = new Map<string, number>();
  for (const p of pending) if (!(p.from in rename)) wanted.set(key(p.publisher, p.name), (wanted.get(key(p.publisher, p.name)) ?? 0) + 1);
  const taken = new Set([...unchanged.map((u) => u.id), ...skippedStubs, ...otherPublishers, ...other].map((id) => id.toLowerCase()));
  const changes: IdChange[] = [];
  for (const p of pending) {
    let to = rename[p.from];
    if (to === undefined) {
      const bare = (wanted.get(key(p.publisher, p.name)) ?? 0) === 1 || p.qualifiers.length === 0;
      to = `urn:air:${p.publisher}:${bare ? p.name : [p.name, ...p.qualifiers].join("-")}`;
    } else if (!URN_AIR_RE.test(to)) {
      errors.push(`${label(p.from)}: ${to} is not urn:air:{publisher-domain}:{name}[:{kind}]`);
      continue;
    } else if (parse(to)!.publisher !== p.publisher.toLowerCase()) {
      errors.push(`${label(p.from)}: ${p.from} → ${to} changes the publisher; a re-issue keeps it`);
      continue;
    }
    if (taken.has(to.toLowerCase()) || ids.some((id) => id !== p.from && id.toLowerCase() === to!.toLowerCase())) {
      errors.push(`${p.from} → ${to} collides with an identifier already in use: name it with --rename ${p.from}=<new>`);
      continue;
    }
    taken.add(to.toLowerCase());
    if (to !== p.from) changes.push({ from: p.from, to });
    else unchanged.push({ id: p.from, reason: "renamed-to-itself" });
  }
  if (errors.length) return empty(input);

  const map = new Map(changes.map((c) => [c.from, c.to]));
  const count = { n: 0 };
  const signed = { n: 0 };
  const inData = { n: 0 };
  const theirs = { n: 0 };
  const stubs: Record<string, unknown>[] = [];
  // Inline data is opaque (§ Catalog Entry) and may carry a digest or signatures: it is never rewritten.
  const rewrite = (e: Record<string, unknown>): Record<string, unknown> => {
    if (!("data" in e)) return replaceDeep(e, map, count, signed) as Record<string, unknown>;
    const probe = { n: 0 };
    replaceDeep(e.data, map, probe, { n: 0 });
    if (probe.n) inData.n++;
    // Keep every member in place, so a second run is byte-identical.
    return Object.fromEntries(Object.entries(e).map(([k, v]) => [k, k === "data" ? v : replaceDeep(v, map, count, signed, [k])]));
  };
  const migrated = entries.map((e) => {
    if (!isObject(e)) return e;
    const old = typeof e.identifier === "string" ? e.identifier : undefined;
    const owner = old ? parse(old) : null;
    if (owner && !mine.has(owner.publisher)) {
      // Another publisher's entry is theirs to change (§ Catalog Projection): report, don't rewrite.
      const probe = { n: 0 };
      replaceDeep(e, map, probe, { n: 0 });
      if (probe.n) theirs.n++;
      return e;
    }
    if (!old || !map.has(old) || isStub(e, objs)) return rewrite(e);
    const next = rewrite(e);
    count.n--; // the identifier itself is a change, not a reference
    const pub = owner!.publisher;
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
            deprecated: { replacedBy: map.get(old), deprecationDate: today, endOfLifeDate: opts.stubsUntil },
          },
        },
      });
    }
    return next;
  });
  if (signed.n) warnings.push(`${signed.n} signed Trust Manifest${signed.n === 1 ? "" : "s"} name an old identifier and were left unchanged: re-issue and re-sign them`);
  if (inData.n) warnings.push(`${inData.n} entr${inData.n === 1 ? "y's" : "ies'"} inline data name an old identifier; inline data is never rewritten: update it (and any digest or signature) yourself`);
  if (theirs.n) warnings.push(`${theirs.n} other publisher${theirs.n === 1 ? "'s entry names" : "s' entries name"} an old identifier and ${theirs.n === 1 ? "was" : "were"} left unchanged: those publishers update their own entries`);
  const outside = { n: 0 };
  replaceDeep(Object.fromEntries(Object.entries(input).filter(([k]) => k !== "entries")), map, outside, { n: 0 });
  if (outside.n) warnings.push(`${outside.n} value${outside.n === 1 ? "" : "s"} outside the entries (host, extensions) name an old identifier and were left unchanged`);
  if (changes.length && "signature" in input) warnings.push("the catalog is signed: its signature no longer verifies after this change; re-sign it");
  return {
    catalog: { ...input, entries: [...migrated, ...stubs] },
    changes,
    publishers: [...mine],
    unchanged,
    appliedRenames,
    skippedStubs,
    otherPublishers,
    other,
    stubCount: stubs.length,
    references: count.n,
    warnings,
    errors,
  };
}
