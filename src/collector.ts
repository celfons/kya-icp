/**
 * One collection run: download every source CRL, keep the raw file in R2 when it changed, record every attempt.
 *
 * R2 layout (nothing is ever overwritten except the per-source state):
 *   lcr/<source>/<thisUpdate>_<sha256[0:16]>.crl   raw DER, exactly as served, with its header in customMetadata
 *   state/<source>.json                           last stored version (sha256, thisUpdate, key), for deduplication
 *   log/<YYYY>/<MM>/<DD>/<HHMMSS>Z.ndjson         one line per source and run, failures included
 *
 * The CRL entries are never decoded here (see der.ts): the analysis runs offline from the raw files.
 */
import { updateAggregate, writeIndex } from "./aggregate.js";
import { type CrlHeader, DerError, parseCrlHeader } from "./der.js";

export interface Source {
  /** Stable id used in R2 keys: lowercase letters, digits and "-". */
  id: string;
  /** AC name, for people. */
  ac: string;
  url: string;
  /** "usuario-final": revoked end-user certificates; "ac": revoked AC certificates. */
  kind: "usuario-final" | "ac";
  /** Same CRL on another host of the AC, tried when `url` refuses or fails (Soluti publishes on ccd and ccd2). */
  mirror?: string;
}

/** The subset of the R2 binding used here, so tests can pass an in-memory bucket. */
export interface Bucket {
  get(key: string): Promise<{ text(): Promise<string> } | null>;
  list(options: { prefix: string; cursor?: string; limit?: number }): Promise<{ objects: { key: string; size: number; uploaded: Date }[]; truncated: boolean; cursor?: string }>;
  put(key: string, value: ArrayBuffer | Uint8Array | string, options?: { httpMetadata?: { contentType?: string }; customMetadata?: Record<string, string> }): Promise<unknown>;
}

export interface Attempt {
  source: string;
  url: string;
  fetched_at: string;
  outcome: "stored" | "unchanged" | "http_error" | "network_error" | "not_a_crl" | "too_large";
  http_status: number | null;
  bytes: number | null;
  ms: number;
  sha256: string | null;
  this_update: string | null;
  next_update: string | null;
  crl_number: string | null;
  entries: number | null;
  /** Signature algorithm of the CRL (dotted OID), when it parsed. */
  signature_algorithm: string | null;
  key: string | null;
  error: string | null;
  /** Whether the stored version was folded into agg/<source>.json (null when nothing was stored). */
  aggregated: boolean | null;
  /** True when `url` is the source's mirror, because the primary host refused or failed. */
  fallback: boolean;
}

export interface RunOptions {
  sources: Source[];
  bucket: Bucket;
  fetch: typeof fetch;
  now: () => Date;
  /** Abort one download after this many milliseconds. */
  timeoutMs: number;
  /** Refuse bodies larger than this (bytes). */
  maxBytes: number;
  /** Downloads in flight at once. */
  concurrency: number;
  /**
   * Minimum spacing between two requests to the same host. The ACs rate-limit bursts: on 7 Nov 2026 the Soluti
   * host answered 403 to all of its 24 lists once they were fetched within seconds, and 200 to each one alone.
   */
  hostGapMs: number;
  /** Waits; tests replace it. */
  sleep?: (ms: number) => Promise<void>;
  userAgent: string;
}

/** Hands out start times per host so that requests to one host stay `hostGapMs` apart. */
export function hostPacer(o: Pick<RunOptions, "hostGapMs" | "now" | "sleep">) {
  const nextAt = new Map<string, number>();
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return async (url: string): Promise<number> => {
    const host = new URL(url).host;
    const now = o.now().getTime();
    const wait = Math.max(0, (nextAt.get(host) ?? 0) - now);
    nextAt.set(host, now + wait + o.hostGapMs);
    if (wait > 0) await sleep(wait);
    return wait;
  };
}

/** Orders sources so that consecutive ones hit different hosts, which keeps the per-host spacing cheap. */
export function interleaveByHost(sources: Source[]): Source[] {
  const byHost = new Map<string, Source[]>();
  for (const s of sources) {
    const host = new URL(s.url).host;
    byHost.set(host, [...(byHost.get(host) ?? []), s]);
  }
  const groups = [...byHost.values()].sort((a, b) => b.length - a.length);
  const out: Source[] = [];
  for (let i = 0; out.length < sources.length; i++) for (const g of groups) if (i < g.length) out.push(g[i]!);
  return out;
}

interface State {
  sha256: string;
  this_update: string;
  key: string;
  stored_at: string;
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
const compact = (iso: string) => iso.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

export const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** Validates the source list; throws on a bad id, a duplicate id or a non-HTTP(S) URL. */
export function validateSources(input: unknown): Source[] {
  if (!Array.isArray(input) || input.length === 0) throw new Error("sources must be a non-empty array");
  const seen = new Set<string>();
  return input.map((s, i) => {
    const o = s as Partial<Source>;
    if (!o || typeof o.id !== "string" || !ID_RE.test(o.id)) throw new Error(`sources[${i}].id must match ${ID_RE}`);
    if (seen.has(o.id)) throw new Error(`sources[${i}].id duplicated: ${o.id}`);
    seen.add(o.id);
    if (typeof o.url !== "string" || !/^https?:\/\//.test(o.url)) throw new Error(`sources[${i}].url must be http(s)`);
    if (typeof o.ac !== "string" || !o.ac) throw new Error(`sources[${i}].ac is required`);
    if (o.kind !== "usuario-final" && o.kind !== "ac") throw new Error(`sources[${i}].kind must be usuario-final or ac`);
    if (o.mirror !== undefined && (typeof o.mirror !== "string" || !/^https?:\/\//.test(o.mirror) || o.mirror === o.url)) throw new Error(`sources[${i}].mirror must be an http(s) url other than url`);
    return o.mirror === undefined ? { id: o.id, ac: o.ac, url: o.url, kind: o.kind } : { id: o.id, ac: o.ac, url: o.url, kind: o.kind, mirror: o.mirror };
  });
}

/** Downloads one source and stores it when it changed. Never throws: every problem becomes an Attempt. */
type Download = { ok: true; body: Uint8Array; status: number } | { ok: false; attempt: Partial<Attempt> };

/** One HTTP download of `url`, as an outcome rather than an exception. */
async function download(url: string, o: RunOptions): Promise<Download> {
  try {
    const res = await o.fetch(url, { headers: { "user-agent": o.userAgent }, redirect: "follow", signal: AbortSignal.timeout(o.timeoutMs) });
    if (!res.ok) {
      await res.body?.cancel();
      return { ok: false, attempt: { outcome: "http_error", http_status: res.status } };
    }
    const declared = Number(res.headers.get("content-length") ?? "NaN");
    if (Number.isFinite(declared) && declared > o.maxBytes) {
      await res.body?.cancel();
      return { ok: false, attempt: { outcome: "too_large", http_status: res.status, bytes: declared } };
    }
    return { ok: true, body: new Uint8Array(await res.arrayBuffer()), status: res.status };
  } catch (e) {
    return { ok: false, attempt: { outcome: "network_error", error: (e as Error)?.message ?? String(e) } };
  }
}

/** Downloads one source and stores it when it changed. Never throws: every problem becomes an Attempt. */
export async function collectOne(src: Source, o: RunOptions, pace: (url: string) => Promise<number> = async () => 0): Promise<Attempt> {
  const started = o.now();
  const base: Attempt = { source: src.id, url: src.url, fetched_at: started.toISOString(), outcome: "network_error", http_status: null, bytes: null, ms: 0, sha256: null, this_update: null, next_update: null, crl_number: null, entries: null, signature_algorithm: null, key: null, error: null, aggregated: null, fallback: false };
  const done = (a: Partial<Attempt>): Attempt => ({ ...base, ...a, ms: o.now().getTime() - started.getTime() });
  await pace(src.url);
  let got = await download(src.url, o);
  // A refusal or a network failure on the primary host is retried once on the mirror; a body that arrived is not.
  if (!got.ok && src.mirror && (got.attempt.outcome === "network_error" || got.attempt.outcome === "http_error")) {
    await pace(src.mirror);
    const viaMirror = await download(src.mirror, o);
    if (viaMirror.ok || viaMirror.attempt.outcome !== "network_error") {
      base.url = src.mirror;
      base.fallback = true;
      got = viaMirror;
    }
  }
  if (!got.ok) return done(got.attempt);
  const body = got.body;
  base.http_status = got.status;
  if (body.length > o.maxBytes) return done({ outcome: "too_large", bytes: body.length });
  const sha256 = hex(await crypto.subtle.digest("SHA-256", body));
  let h: CrlHeader;
  try {
    h = parseCrlHeader(body);
  } catch (e) {
    return done({ outcome: "not_a_crl", bytes: body.length, sha256, error: e instanceof DerError ? e.message : String(e) });
  }
  const meta = { bytes: body.length, sha256, this_update: h.thisUpdate, next_update: h.nextUpdate, crl_number: h.crlNumber, entries: h.entries, signature_algorithm: h.signatureAlgorithm };
  const stateKey = `state/${src.id}.json`;
  let prev: State | null = null;
  try {
    const s = await o.bucket.get(stateKey);
    prev = s ? (JSON.parse(await s.text()) as State) : null;
  } catch {
    prev = null; // unreadable state: store again rather than lose a version
  }
  if (prev?.sha256 === sha256) return done({ outcome: "unchanged", ...meta, key: prev.key });
  const key = `lcr/${src.id}/${compact(h.thisUpdate)}_${sha256.slice(0, 16)}.crl`;
  await o.bucket.put(key, body, {
    httpMetadata: { contentType: "application/pkix-crl" },
    customMetadata: { source: src.id, ac: src.ac, url: base.url, fetched_at: base.fetched_at, sha256, this_update: h.thisUpdate, next_update: h.nextUpdate ?? "", crl_number: h.crlNumber ?? "", entries: String(h.entries), signature_algorithm: h.signatureAlgorithm, issuer_der_hex: h.issuerDerHex.slice(0, 1024) }
  });
  const state: State = { sha256, this_update: h.thisUpdate, key, stored_at: o.now().toISOString() };
  await o.bucket.put(stateKey, JSON.stringify(state), { httpMetadata: { contentType: "application/json" } });
  // The raw file is the data; an aggregate failure is logged and never loses it.
  try {
    const agg = await updateAggregate(o.bucket, src, body, h, o.now());
    return done({ outcome: "stored", ...meta, key, aggregated: agg !== null });
  } catch (e) {
    return done({ outcome: "stored", ...meta, key, aggregated: false, error: `aggregate: ${(e as Error)?.message ?? String(e)}` });
  }
}

/** Runs every source with bounded concurrency, writes the run log and returns the attempts. */
export async function runCollection(o: RunOptions): Promise<{ logKey: string; attempts: Attempt[] }> {
  const runAt = o.now();
  const queue = interleaveByHost(o.sources);
  const attempts: Attempt[] = [];
  const pace = hostPacer(o);
  const worker = async () => {
    for (let s = queue.shift(); s; s = queue.shift()) attempts.push(await collectOne(s, o, pace));
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(o.concurrency, queue.length)) }, worker));
  attempts.sort((a, b) => a.source.localeCompare(b.source));
  if (attempts.some((a) => a.aggregated)) await writeIndex(o.bucket, o.sources, o.now());
  const iso = runAt.toISOString();
  const logKey = `log/${iso.slice(0, 4)}/${iso.slice(5, 7)}/${iso.slice(8, 10)}/${compact(iso).slice(9)}.ndjson`;
  await o.bucket.put(logKey, attempts.map((a) => JSON.stringify(a)).join("\n") + "\n", { httpMetadata: { contentType: "application/x-ndjson" } });
  return { logKey, attempts };
}
