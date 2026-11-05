/**
 * Per-source aggregates, updated whenever a new CRL version is stored, so the dashboard reads small JSON files
 * instead of parsing CRLs on each visit.
 *
 *   seen/<source>.txt   serial numbers of the last aggregated version, one hex per line
 *   agg/<source>.json   SourceAgg: monthly revocations (from the latest version), the publication delay of every
 *                       revocation that appeared during the collection, and their summary
 *   agg/index.json      one SourceSummary per source (rebuilt at the end of a run that stored something)
 *
 * The delay of a serial is the thisUpdate of the first collected version that lists it minus its revocation date.
 * Serials already in the first collected version have no measurable delay and are not counted.
 *
 * Each aggregate also keeps the signature algorithm of every stored version as runs of equal OIDs (`algorithms`),
 * so a change of algorithm or chain by an AC shows up with the hour it happened. Aggregates written before this
 * field existed start the history at the first version stored after it.
 */
import type { Bucket, Source } from "./collector.js";
import { type CrlHeader, SIGNATURE_ALGORITHMS, forEachEntry } from "./der.js";

export interface SourceSummary {
  source: string;
  ac: string;
  kind: Source["kind"];
  url: string;
  versions: number;
  first_this_update: string;
  last_this_update: string;
  next_update: string | null;
  entries: number;
  entries_with_reason: number;
  /** Signature algorithm (dotted OID) and size in bytes of the latest version; null in aggregates written before. */
  signature_algorithm: string | null;
  /** Name of signature_algorithm (SIGNATURE_ALGORITHMS), or the OID when unknown. */
  signature_algorithm_name: string | null;
  bytes: number | null;
  measured_delays: number;
  delay_median_h: number | null;
  delay_p95_h: number | null;
  delay_max_h: number | null;
  updated_at: string;
}

export interface SourceAgg extends SourceSummary {
  /** Revocations per month (YYYY-MM) in the latest version. Older months are a floor: expired certificates leave the CRL. */
  monthly: Record<string, number>;
  /** Publication delay in hours of each revocation first seen during the collection, oldest first. */
  delays_h: number[];
  /**
   * Revocations of the latest version by weekday and hour in Brasília time (UTC-3), 168 counts: index = weekday * 24
   * + hour, weekday 0 = Sunday. Shows whether revocation is a human, office-hours process or an automatic one.
   */
  weekday_hour?: number[];
  /** Signature algorithm of the stored versions, oldest first, one run per change. */
  algorithms?: AlgorithmRun[];
}

export interface AlgorithmRun {
  /** Dotted OID. */
  oid: string;
  /** Name from SIGNATURE_ALGORITHMS, or the OID itself when unknown. */
  name: string;
  /** thisUpdate of the first and last stored version signed with it. */
  first_this_update: string;
  last_this_update: string;
  versions: number;
}

/** Appends one stored version to the algorithm history (a new run when the OID changed). */
export function addAlgorithm(runs: AlgorithmRun[], oid: string, thisUpdate: string): AlgorithmRun[] {
  const last = runs[runs.length - 1];
  if (last?.oid === oid) return [...runs.slice(0, -1), { ...last, last_this_update: thisUpdate, versions: last.versions + 1 }];
  return [...runs, { oid, name: SIGNATURE_ALGORITHMS[oid] ?? oid, first_this_update: thisUpdate, last_this_update: thisUpdate, versions: 1 }];
}

/** Index into weekday_hour of an ISO 8601 UTC instant, in Brasília time (UTC-3, no daylight saving since 2019). */
export function weekdayHourIndex(iso: string): number {
  const d = new Date(Date.parse(iso) - 3 * 3_600_000);
  return d.getUTCDay() * 24 + d.getUTCHours();
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

export function quantile(sorted: number[], p: number): number | null {
  if (!sorted.length) return null;
  const k = (sorted.length - 1) * p;
  const lo = Math.floor(k);
  const hi = Math.min(lo + 1, sorted.length - 1);
  return round3(sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (k - lo));
}

async function readJson<T>(bucket: Bucket, key: string): Promise<T | null> {
  try {
    const o = await bucket.get(key);
    return o ? (JSON.parse(await o.text()) as T) : null;
  } catch {
    return null;
  }
}

/**
 * Folds a newly stored version into the source's aggregate. A version that is not newer than the last aggregated
 * one (a mirror serving an older list) is ignored. Returns the aggregate, or null when ignored.
 */
export async function updateAggregate(bucket: Bucket, src: Source, body: Uint8Array, h: CrlHeader, now: Date): Promise<SourceAgg | null> {
  const prev = await readJson<SourceAgg>(bucket, `agg/${src.id}.json`);
  if (prev && Date.parse(h.thisUpdate) <= Date.parse(prev.last_this_update)) return null;
  const seenObj = await bucket.get(`seen/${src.id}.txt`);
  const seen = seenObj ? new Set((await seenObj.text()).split("\n").filter(Boolean)) : null;
  const thisUpdate = Date.parse(h.thisUpdate);
  const monthly: Record<string, number> = {};
  const serials: string[] = [];
  const newDelays: number[] = [];
  const weekdayHour = new Array<number>(168).fill(0);
  let withReason = 0;
  forEachEntry(body, (e) => {
    serials.push(e.serialHex);
    const month = e.revocationDate.slice(0, 7);
    monthly[month] = (monthly[month] ?? 0) + 1;
    if (e.hasReason) withReason++;
    const wh = weekdayHourIndex(e.revocationDate);
    if (wh >= 0 && wh < 168) weekdayHour[wh]!++;
    if (seen && !seen.has(e.serialHex)) newDelays.push(round3((thisUpdate - Date.parse(e.revocationDate)) / 3_600_000));
  });
  const delays = [...(prev?.delays_h ?? []), ...newDelays];
  const sorted = [...delays].sort((a, b) => a - b);
  const agg: SourceAgg = {
    source: src.id,
    ac: src.ac,
    kind: src.kind,
    url: src.url,
    versions: (prev?.versions ?? 0) + 1,
    first_this_update: prev?.first_this_update ?? h.thisUpdate,
    last_this_update: h.thisUpdate,
    next_update: h.nextUpdate,
    entries: serials.length,
    entries_with_reason: withReason,
    signature_algorithm: h.signatureAlgorithm,
    signature_algorithm_name: SIGNATURE_ALGORITHMS[h.signatureAlgorithm] ?? h.signatureAlgorithm,
    bytes: body.length,
    measured_delays: delays.length,
    delay_median_h: quantile(sorted, 0.5),
    delay_p95_h: quantile(sorted, 0.95),
    delay_max_h: sorted.length ? sorted[sorted.length - 1]! : null,
    updated_at: now.toISOString(),
    monthly: Object.fromEntries(Object.entries(monthly).sort(([a], [b]) => a.localeCompare(b))),
    delays_h: delays,
    weekday_hour: weekdayHour,
    algorithms: addAlgorithm(prev?.algorithms ?? [], h.signatureAlgorithm, h.thisUpdate)
  };
  await bucket.put(`seen/${src.id}.txt`, serials.join("\n"), { httpMetadata: { contentType: "text/plain" } });
  await bucket.put(`agg/${src.id}.json`, JSON.stringify(agg), { httpMetadata: { contentType: "application/json" } });
  return agg;
}

export function summaryOf(a: SourceAgg): SourceSummary {
  const { monthly: _m, delays_h: _d, weekday_hour: _w, algorithms: _a, ...s } = a;
  return { ...s, signature_algorithm: s.signature_algorithm ?? null, signature_algorithm_name: s.signature_algorithm_name ?? null, bytes: s.bytes ?? null };
}

/** Rebuilds agg/index.json from the per-source aggregates of the given sources. */
export async function writeIndex(bucket: Bucket, sources: Source[], now: Date): Promise<SourceSummary[]> {
  const out: SourceSummary[] = [];
  for (const s of sources) {
    const a = await readJson<SourceAgg>(bucket, `agg/${s.id}.json`);
    if (a) out.push(summaryOf(a));
  }
  await bucket.put("agg/index.json", JSON.stringify({ generated_at: now.toISOString(), sources: out }), { httpMetadata: { contentType: "application/json" } });
  return out;
}
