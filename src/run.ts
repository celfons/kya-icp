/**
 * On-demand collection (POST /api/run), for the first load or after fixing a source. Disabled unless the Worker has
 * a RUN_TOKEN secret; the caller must send it as a bearer token. A run is refused while another started less than
 * MIN_INTERVAL_MS ago (state in R2, run/last.json), so even a leaked token cannot hammer the CRL servers.
 */
import type { Bucket } from "./collector.js";

export const MIN_INTERVAL_MS = 5 * 60_000;
const LAST_KEY = "run/last.json";

/** Constant-time comparison of two strings (as UTF-8 bytes). */
export function sameSecret(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export type RunGate = { ok: true } | { ok: false; status: 401 | 404 | 405 | 429; error: string; retry_after_s?: number };

/** Decides whether a request may start a run, and records the start when it may. */
export async function gateRun(req: Request, token: string | undefined, bucket: Bucket, now: Date): Promise<RunGate> {
  if (!token) return { ok: false, status: 404, error: "not found" };
  if (req.method !== "POST") return { ok: false, status: 405, error: "use POST" };
  const auth = req.headers.get("authorization") ?? "";
  const given = auth.startsWith("Bearer ") ? auth.slice(7).trim() : "";
  if (!given || !sameSecret(given, token)) return { ok: false, status: 401, error: "missing or wrong bearer token" };
  let last: number | null = null;
  try {
    const o = await bucket.get(LAST_KEY);
    last = o ? Date.parse((JSON.parse(await o.text()) as { started_at: string }).started_at) : null;
  } catch {
    last = null;
  }
  if (last !== null && Number.isFinite(last) && now.getTime() - last < MIN_INTERVAL_MS) {
    return { ok: false, status: 429, error: "a run started less than 5 minutes ago", retry_after_s: Math.ceil((MIN_INTERVAL_MS - (now.getTime() - last)) / 1000) };
  }
  await bucket.put(LAST_KEY, JSON.stringify({ started_at: now.toISOString() }), { httpMetadata: { contentType: "application/json" } });
  return { ok: true };
}
