/**
 * The ICP-Brasil tree published by ITI (https://estrutura.iti.gov.br): the AC Raiz, the certification authorities
 * of first and second level and the registration authorities (AR), with each AC's accreditation status. It is the
 * denominator of the collection's coverage (how many of the end-user ACs the sources reach) and, kept over time,
 * the record of accreditations and exits. ITI keeps no history of it; the app reads one public JSON file, checked
 * here once a day (the tree changes rarely) and stored whenever it changes:
 *
 *   iti/estrutura/<atualizado>_<sha256[0:16]>.json   the raw structure.json, whenever it changes
 *   agg/estrutura.json                               one compact row per stored version (EstruturaRow[])
 *   state/estrutura.json                             sha256 and key of the last stored version, time of the last check
 */
import type { Bucket } from "./collector.js";

export const ESTRUTURA_URL = "https://estrutura.iti.gov.br/assets/jsons/structure.json";
/** Minimum interval between two downloads: the collection runs hourly, this file is checked about once a day. */
export const CHECK_EVERY_MS = 23 * 3600_000;
/** `situacao` as observed in November 2026: 4002 for every AC the app lists as accredited, 4001 for the ones under accreditation. */
export const ACCREDITED = 4002;

export interface EstruturaAc {
  name: string;
  level: 1 | 2;
  status: number | null;
  /** The AC one level up (the AC Raiz for level 1). */
  parent: string | null;
}

export interface EstruturaRow {
  /** The "atualizado_data" and "atualizado_hora" the file carries (Brasília, UTC-3), as ISO 8601 UTC. */
  updated_on: string | null;
  fetched_at: string;
  sha256: string;
  key: string;
  ac_level_1: number;
  ac_level_2: number;
  ac_level_2_accredited: number;
  /** Second-level ACs under "AC RFB", the chain of the e-CNPJ and e-CPF certificates. */
  ac_level_2_rfb: number;
  ar: number;
}

const hex = (buf: ArrayBuffer) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");

/** "29/10/2026" and "10:21" (Brasília, UTC-3) to ISO 8601 UTC; null when unparseable. */
export function parseAtualizado(date: unknown, time: unknown): string | null {
  const d = typeof date === "string" ? /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(date.trim()) : null;
  const t = typeof time === "string" ? /^(\d{2}):(\d{2})$/.exec(time.trim()) : null;
  if (!d) return null;
  const ms = Date.UTC(Number(d[3]), Number(d[2]) - 1, Number(d[1]), (t ? Number(t[1]) : 0) + 3, t ? Number(t[2]) : 0, 0);
  return Number.isFinite(ms) ? new Date(ms).toISOString().replace(".000Z", "Z") : null;
}

interface Node {
  tipo?: unknown;
  nome?: unknown;
  situacao?: unknown;
  entidades_vinculadas?: unknown;
}

/** Walks the tree: the ACs of level 1 and 2 with their status and parent, and the number of ARs. Throws when the file is not the tree. */
export function acsOf(tree: unknown): { acs: EstruturaAc[]; ar: number } {
  const root = tree as Node;
  if (!root || typeof root !== "object" || root.tipo !== "ac-root") throw new Error("structure.json does not start at the AC Raiz");
  const acs: EstruturaAc[] = [];
  let ar = 0;
  const walk = (node: Node, parent: string | null) => {
    const name = typeof node.nome === "string" ? node.nome : null;
    if (node.tipo === "ar") ar += 1;
    else if ((node.tipo === "ac-1" || node.tipo === "ac-2") && name) acs.push({ name, level: node.tipo === "ac-1" ? 1 : 2, status: typeof node.situacao === "number" ? node.situacao : null, parent });
    const children = Array.isArray(node.entidades_vinculadas) ? (node.entidades_vinculadas as Node[]) : [];
    for (const child of children) if (child && typeof child === "object") walk(child, name);
  };
  walk(root, null);
  return { acs, ar };
}

export function rowOf(tree: unknown, meta: { fetched_at: string; sha256: string; key: string }): EstruturaRow {
  const { acs, ar } = acsOf(tree);
  const t = tree as { atualizado_data?: unknown; atualizado_hora?: unknown };
  const l2 = acs.filter((a) => a.level === 2);
  return {
    updated_on: parseAtualizado(t.atualizado_data, t.atualizado_hora),
    ...meta,
    ac_level_1: acs.filter((a) => a.level === 1).length,
    ac_level_2: l2.length,
    ac_level_2_accredited: l2.filter((a) => a.status === ACCREDITED).length,
    ac_level_2_rfb: l2.filter((a) => a.parent === "AC RFB").length,
    ar
  };
}

interface State {
  sha256: string;
  key: string;
  /** When the file was last downloaded (stored or unchanged); the daily gate. */
  checked_at?: string;
}

export type EstruturaOutcome = { outcome: "stored" | "unchanged"; row: EstruturaRow } | { outcome: "skipped"; next_check_after: string } | { outcome: "error"; error: string };

/** Downloads structure.json at most once a day and stores it when it changed. Never throws. */
export async function snapshotEstrutura(bucket: Bucket, f: typeof fetch, now: Date, timeoutMs = 30_000): Promise<EstruturaOutcome> {
  try {
    const stateObj = await bucket.get("state/estrutura.json");
    const prev = stateObj ? (JSON.parse(await stateObj.text()) as State) : null;
    const last = prev?.checked_at ? Date.parse(prev.checked_at) : NaN;
    if (Number.isFinite(last) && now.getTime() - last < CHECK_EVERY_MS) return { outcome: "skipped", next_check_after: new Date(last + CHECK_EVERY_MS).toISOString() };
    const res = await f(ESTRUTURA_URL, { headers: { "user-agent": "kya-icp-collector (+https://github.com/celfons/kya-icp)" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { outcome: "error", error: `HTTP ${res.status}` };
    const text = await res.text();
    const sha256 = hex(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)));
    const tree = JSON.parse(text) as unknown;
    const fetched_at = now.toISOString();
    const probe = rowOf(tree, { fetched_at, sha256, key: prev?.key ?? "" });
    const state = (key: string) => bucket.put("state/estrutura.json", JSON.stringify({ sha256, key, checked_at: fetched_at }), { httpMetadata: { contentType: "application/json" } });
    if (prev?.sha256 === sha256) {
      await state(prev.key);
      return { outcome: "unchanged", row: probe };
    }
    const stamp = (probe.updated_on ?? fetched_at).replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
    const key = `iti/estrutura/${stamp}_${sha256.slice(0, 16)}.json`;
    const row = { ...probe, key };
    await bucket.put(key, text, { httpMetadata: { contentType: "application/json" }, customMetadata: { url: ESTRUTURA_URL, fetched_at, updated_on: row.updated_on ?? "" } });
    const seriesObj = await bucket.get("agg/estrutura.json");
    const series = seriesObj ? (JSON.parse(await seriesObj.text()) as EstruturaRow[]) : [];
    series.push(row);
    await bucket.put("agg/estrutura.json", JSON.stringify(series), { httpMetadata: { contentType: "application/json" } });
    await state(key);
    return { outcome: "stored", row };
  } catch (e) {
    return { outcome: "error", error: (e as Error)?.message ?? String(e) };
  }
}

/** The ACs of the last stored version, for the coverage computation (research/paper in kya-brasil, kya-paper). */
export async function latestAcs(bucket: Bucket): Promise<{ updated_on: string | null; fetched_at: string | null; key: string; source_url: string; ar: number; acs: EstruturaAc[] } | null> {
  const stateObj = await bucket.get("state/estrutura.json");
  const st = stateObj ? (JSON.parse(await stateObj.text()) as State) : null;
  const raw = st?.key ? await bucket.get(st.key) : null;
  if (!st || !raw) return null;
  const tree = JSON.parse(await raw.text()) as { atualizado_data?: unknown; atualizado_hora?: unknown };
  const { acs, ar } = acsOf(tree);
  return { updated_on: parseAtualizado(tree.atualizado_data, tree.atualizado_hora), fetched_at: st.checked_at ?? null, key: st.key, source_url: ESTRUTURA_URL, ar, acs };
}
