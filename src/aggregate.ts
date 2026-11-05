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
 */
import type { Bucket, Source } from "./collector.js";
import { type CrlHeader, forEachEntry } from "./der.js";

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
  let withReason = 0;
  forEachEntry(body, (e) => {
    serials.push(e.serialHex);
    const month = e.revocationDate.slice(0, 7);
    monthly[month] = (monthly[month] ?? 0) + 1;
    if (e.hasReason) withReason++;
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
    measured_delays: delays.length,
    delay_median_h: quantile(sorted, 0.5),
    delay_p95_h: quantile(sorted, 0.95),
    delay_max_h: sorted.length ? sorted[sorted.length - 1]! : null,
    updated_at: now.toISOString(),
    monthly: Object.fromEntries(Object.entries(monthly).sort(([a], [b]) => a.localeCompare(b))),
    delays_h: delays
  };
  await bucket.put(`seen/${src.id}.txt`, serials.join("\n"), { httpMetadata: { contentType: "text/plain" } });
  await bucket.put(`agg/${src.id}.json`, JSON.stringify(agg), { httpMetadata: { contentType: "application/json" } });
  return agg;
}

export function summaryOf(a: SourceAgg): SourceSummary {
  const { monthly: _m, delays_h: _d, ...s } = a;
  return s;
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
