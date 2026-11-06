/**
 * Inbox of the H3 case study (kya-brasil, packages/study-kit): `npx kya-study send` posts the participant's anonymous
 * report here and it is kept in R2. Separate from the CRL collection; nothing here is served back.
 *
 *   POST /study/reports    body: the kya-study-report/1 JSON (at most MAX_BYTES), content-type application/json
 *
 *   study/reports/<participant_id>/<received_at>.json   every report as received; a later send adds a new file and
 *                                                        never overwrites (the analysis keeps the most complete one)
 *   study/state/hour-<YYYYMMDDHH>.json                  how many reports this hour, for the hourly cap
 *
 * Privacy: the report carries no identifier of the person (see the kit). This handler stores only the report and the
 * time it arrived: no IP address, no header, no log line.
 */
import type { Bucket } from "./collector.js";

export const MAX_BYTES = 64 * 1024;
export const HOURLY_CAP = 120;
const ID = /^p-[0-9a-f]{10}$/;

export type StudyResult =
  | { status: 201; body: { ok: true; participant_id: string; received_at: string } }
  | { status: 400 | 405 | 413 | 415 | 429; body: { ok: false; error: string } };

const fail = (status: 400 | 405 | 413 | 415 | 429, error: string): StudyResult => ({ status, body: { ok: false, error } });

/** Structural check of a kya-study report; returns the participant id or an error. */
export function checkReport(v: unknown): { id: string } | { error: string } {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { error: "not a JSON object" };
  const r = v as Record<string, unknown>;
  if (r.schema !== "kya-study-report/1") return { error: "not a kya-study-report/1" };
  if (typeof r.participant_id !== "string" || !ID.test(r.participant_id)) return { error: "bad participant_id" };
  if (typeof r.kit_version !== "string" || r.kit_version.length > 32) return { error: "bad kit_version" };
  if (!r.tasks || typeof r.tasks !== "object" || Array.isArray(r.tasks)) return { error: "tasks is not an object" };
  if (typeof r.finished !== "boolean") return { error: "finished is not a boolean" };
  return { id: r.participant_id };
}

export async function receiveReport(req: Request, bucket: Bucket, now: Date): Promise<StudyResult> {
  if (req.method !== "POST") return fail(405, "use POST");
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return fail(415, "content-type must be application/json");
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > MAX_BYTES) return fail(413, `at most ${MAX_BYTES} bytes`);
  const bytes = new Uint8Array(await req.arrayBuffer());
  if (bytes.byteLength > MAX_BYTES) return fail(413, `at most ${MAX_BYTES} bytes`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return fail(400, "not valid JSON");
  }
  const checked = checkReport(parsed);
  if ("error" in checked) return fail(400, checked.error);

  const hourKey = `study/state/hour-${now.toISOString().slice(0, 13).replace(/[-T]/g, "")}.json`;
  const hourObj = await bucket.get(hourKey);
  const count = hourObj ? Number((JSON.parse(await hourObj.text()) as { count?: number }).count ?? 0) : 0;
  if (count >= HOURLY_CAP) return fail(429, "too many reports this hour; try again later");
  await bucket.put(hourKey, JSON.stringify({ count: count + 1 }), { httpMetadata: { contentType: "application/json" } });

  const receivedAt = now.toISOString();
  const key = `study/reports/${checked.id}/${receivedAt.replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.json`;
  await bucket.put(key, bytes, { httpMetadata: { contentType: "application/json" }, customMetadata: { received_at: receivedAt } });
  return { status: 201, body: { ok: true, participant_id: checked.id, received_at: receivedAt } };
}
