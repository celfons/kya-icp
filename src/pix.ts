/**
 * Context for the research's value scale: monthly totals of Pix payments to companies, from the Central Bank's open
 * data (Pix_DadosAbertos / EstatisticasTransacoesPix). B2B is company to company, P2B person to company. The service
 * has no value bands, so the research uses the mean value per transaction (kya-brasil, research/freshness-sim).
 *
 * Once a month: the previous month, as soon as the Central Bank publishes it (tried at most once a day until then).
 *
 *   bcb/pix/<YYYYMM>.json   the month: the raw rows the service returned for each nature, and their totals
 *   agg/pix.json            one compact row per stored month (PixRow[]), for /api/pix
 *   state/pix.json          the last stored month and the last attempt
 */
import type { Bucket } from "./collector.js";

export const PIX_URL = "https://olinda.bcb.gov.br/olinda/servico/Pix_DadosAbertos/versao/v1/odata/EstatisticasTransacoesPix(Database=@Database)";
export const NATURES = ["B2B", "P2B"] as const;
const DAY_MS = 86_400_000;

export interface PixTotals {
  value_brl: number;
  count: number;
  mean_brl: number | null;
}

export interface PixRow {
  month: string;
  fetched_at: string;
  key: string;
  natures: Record<string, PixTotals>;
}

interface PixState {
  month: string | null;
  last_attempt: string | null;
}

/** The previous calendar month of `now`, as YYYYMM. */
export function previousMonth(now: Date): string {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth(); // 0-based: the previous month is m (1-based)
  return m === 0 ? `${y - 1}12` : `${y}${String(m).padStart(2, "0")}`;
}

/** The service's query URL for one month and nature (fixed host; both values are validated). */
export function queryUrl(month: string, nature: string): string {
  if (!/^\d{6}$/.test(month) || !(NATURES as readonly string[]).includes(nature)) throw new Error("bad month or nature");
  const q = [`@Database='${month}'`, `$filter=NATUREZA eq '${nature}'`, "$select=AnoMes,VALOR,QUANTIDADE", "$format=json", "$top=100000"];
  return `${PIX_URL}?${q.map((p) => encodeURI(p).replace(/'/g, "%27")).join("&")}`;
}

/** Totals of the rows of one month (rows of other months, which the service may return, are left out). */
export function totals(rows: unknown, month: string): PixTotals {
  if (!Array.isArray(rows)) throw new Error("value is not an array");
  let value = 0;
  let count = 0;
  for (const r of rows as { AnoMes?: unknown; VALOR?: unknown; QUANTIDADE?: unknown }[]) {
    if (String(r?.AnoMes) !== month || typeof r.VALOR !== "number" || typeof r.QUANTIDADE !== "number") continue;
    value += r.VALOR;
    count += r.QUANTIDADE;
  }
  return { value_brl: Math.round(value * 100) / 100, count, mean_brl: count ? Math.round((value / count) * 100) / 100 : null };
}

export type PixOutcome =
  | { outcome: "stored"; row: PixRow }
  | { outcome: "unchanged" | "not_due" | "not_published"; month: string }
  | { outcome: "error"; error: string };

/** Stores the previous month once it is published. Never throws. */
export async function snapshotPix(bucket: Bucket, f: typeof fetch, now: Date, timeoutMs = 60_000): Promise<PixOutcome> {
  try {
    const month = previousMonth(now);
    const stateObj = await bucket.get("state/pix.json");
    const state: PixState = stateObj ? (JSON.parse(await stateObj.text()) as PixState) : { month: null, last_attempt: null };
    if (state.month !== null && state.month >= month) return { outcome: "unchanged", month };
    if (state.last_attempt && now.getTime() - Date.parse(state.last_attempt) < DAY_MS) return { outcome: "not_due", month };
    const saveAttempt = () => bucket.put("state/pix.json", JSON.stringify({ ...state, last_attempt: now.toISOString() }), { httpMetadata: { contentType: "application/json" } });

    const raw: Record<string, unknown[]> = {};
    const natures: Record<string, PixTotals> = {};
    for (const nature of NATURES) {
      const res = await f(queryUrl(month, nature), { headers: { "user-agent": "kya-icp-collector (+https://github.com/celfons/kya-icp)" }, signal: AbortSignal.timeout(timeoutMs) });
      if (!res.ok) {
        await saveAttempt();
        return { outcome: "error", error: `HTTP ${res.status} (${nature})` };
      }
      const rows = ((await res.json()) as { value?: unknown }).value;
      natures[nature] = totals(rows, month);
      raw[nature] = (rows as unknown[]).filter((r) => String((r as { AnoMes?: unknown })?.AnoMes) === month);
    }
    if (NATURES.some((n) => natures[n]!.count === 0)) {
      await saveAttempt();
      return { outcome: "not_published", month };
    }
    const key = `bcb/pix/${month}.json`;
    const row: PixRow = { month, fetched_at: now.toISOString(), key, natures };
    await bucket.put(key, JSON.stringify({ source: PIX_URL, ...row, raw }), { httpMetadata: { contentType: "application/json" }, customMetadata: { url: PIX_URL, fetched_at: row.fetched_at } });
    const seriesObj = await bucket.get("agg/pix.json");
    const series = (seriesObj ? (JSON.parse(await seriesObj.text()) as PixRow[]) : []).filter((r) => r.month !== month);
    series.push(row);
    series.sort((a, b) => a.month.localeCompare(b.month));
    await bucket.put("agg/pix.json", JSON.stringify(series), { httpMetadata: { contentType: "application/json" } });
    await bucket.put("state/pix.json", JSON.stringify({ month, last_attempt: now.toISOString() }), { httpMetadata: { contentType: "application/json" } });
    return { outcome: "stored", row };
  } catch (e) {
    return { outcome: "error", error: (e as Error)?.message ?? String(e) };
  }
}
