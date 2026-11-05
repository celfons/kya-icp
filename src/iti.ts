/**
 * The denominator: national certificate counts published by ITI (https://numeros.iti.gov.br). The panel reads
 * one public JSON file; ITI keeps no history of it, so each new version is stored here:
 *
 *   iti/panels/<finalizado>_<sha256[0:16]>.json   the raw file, whenever it changes
 *   agg/iti.json                                 one compact row per stored version (ItiRow[]), for the dashboard
 *   state/iti.json                               sha256 of the last stored version
 *
 * There is no per-AC count in it: a per-AC rate needs ITI's answer to an access-to-information request.
 */
import type { Bucket } from "./collector.js";

export const ITI_PANELS_URL = "https://numeros.iti.gov.br/assets/paneljson/panels.json";

export interface ItiRow {
  /** When ITI finished computing the numbers (its "finalizado", as ISO 8601 in UTC-3 converted to UTC). */
  as_of: string | null;
  fetched_at: string;
  sha256: string;
  key: string;
  active: number | null;
  /** Certificates issued in the current year so far. */
  issued_this_year: number | null;
  active_by_holder: Record<string, number>;
  active_by_type: Record<string, number>;
  /** Issued per month of the current year (January first); the last months can still be partial. */
  issued_monthly_this_year: number[] | null;
  issued_monthly_last_year: number[] | null;
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** "04/11/2026, 06:47:04" (Brasília, UTC-3, as the panel shows it) to ISO 8601 UTC; null when unparseable. */
export function parseFinalizado(s: unknown): string | null {
  const m = typeof s === "string" ? /^(\d{2})\/(\d{2})\/(\d{4}),?\s+(\d{2}):(\d{2}):(\d{2})$/.exec(s.trim()) : null;
  if (!m) return null;
  const t = Date.UTC(Number(m[3]), Number(m[2]) - 1, Number(m[1]), Number(m[4]) + 3, Number(m[5]), Number(m[6]));
  return Number.isFinite(t) ? new Date(t).toISOString().replace(".000Z", "Z") : null;
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const nums = (v: unknown) => (Array.isArray(v) && v.every((x) => typeof x === "number") ? (v as number[]) : null);

/** Flattens the panel's array of single-key objects and extracts the counts used by the research. */
export function rowOf(panels: unknown, meta: { fetched_at: string; sha256: string; key: string }): ItiRow {
  if (!Array.isArray(panels)) throw new Error("panels.json is not an array");
  const f: Record<string, unknown> = Object.assign({}, ...panels.filter((x) => x && typeof x === "object"));
  if (num(f.cerVisGerAtivos) === null) throw new Error("panels.json has no cerVisGerAtivos");
  const group = (v: unknown, label: string) => {
    const out: Record<string, number> = {};
    if (Array.isArray(v)) for (const o of v as Record<string, unknown>[]) if (typeof o?.[label] === "string" && typeof o.qtdcertificado === "number") out[o[label] as string] = o.qtdcertificado;
    return out;
  };
  return {
    as_of: parseFinalizado(f.finalizado),
    ...meta,
    active: num(f.cerVisGerAtivos),
    issued_this_year: num(f.cerVisGerEmitidos),
    active_by_holder: group(f.cerVisGerDisAssinatura, "tipo_usuario"),
    active_by_type: group(f.cerVisGerDisTipo, "tipo_certificado"),
    issued_monthly_this_year: nums(f.cerVisGerCompMenAnoAtual),
    issued_monthly_last_year: nums(f.cerVisGerCompMenAnoPassado)
  };
}

export type ItiOutcome = { outcome: "stored" | "unchanged"; row: ItiRow } | { outcome: "error"; error: string };

/** Downloads panels.json and stores it when it changed. Never throws. */
export async function snapshotIti(bucket: Bucket, f: typeof fetch, now: Date, timeoutMs = 30_000): Promise<ItiOutcome> {
  try {
    const res = await f(ITI_PANELS_URL, { headers: { "user-agent": "kya-icp-collector (+https://github.com/celfons/kya-icp)" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { outcome: "error", error: `HTTP ${res.status}` };
    const text = await res.text();
    const sha256 = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
    const panels = JSON.parse(text) as unknown;
    const state = await bucket.get("state/iti.json");
    const prev = state ? (JSON.parse(await state.text()) as { sha256: string; key: string }) : null;
    const probe = rowOf(panels, { fetched_at: now.toISOString(), sha256, key: prev?.key ?? "" });
    if (prev?.sha256 === sha256) return { outcome: "unchanged", row: probe };
    const stamp = (probe.as_of ?? now.toISOString()).replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const key = `iti/panels/${stamp}_${sha256.slice(0, 16)}.json`;
    const row = { ...probe, key };
    await bucket.put(key, text, { httpMetadata: { contentType: "application/json" }, customMetadata: { url: ITI_PANELS_URL, fetched_at: row.fetched_at, as_of: row.as_of ?? "" } });
    const seriesObj = await bucket.get("agg/iti.json");
    const series = seriesObj ? (JSON.parse(await seriesObj.text()) as ItiRow[]) : [];
    series.push(row);
    await bucket.put("agg/iti.json", JSON.stringify(series), { httpMetadata: { contentType: "application/json" } });
    await bucket.put("state/iti.json", JSON.stringify({ sha256, key }), { httpMetadata: { contentType: "application/json" } });
    return { outcome: "stored", row };
  } catch (e) {
    return { outcome: "error", error: (e as Error)?.message ?? String(e) };
  }
}
