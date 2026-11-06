/**
 * kya-icp collector: every hour, download the ICP-Brasil CRLs listed in sources.json, keep each new version raw in
 * R2 and fold it into small per-source aggregates (collector.ts, aggregate.ts).
 *
 * HTTP, read-only (the data is public):
 *   GET /                      dashboard (HTML)
 *   GET /api/status            latest run: outcome counts
 *   GET /api/summary           agg/index.json: one summary per source
 *   GET /api/source/<id>       agg/<id>.json: monthly series and publication delays of one source
 *   GET /api/files/<id>        raw versions stored for one source (?cursor= to page)
 *   GET /files/<key>           a raw CRL (lcr/...) or a run log (log/...)
 *   GET /api/source/<id>/monthly.csv   monthly revocations of one source, CSV
 *   GET /api/monthly.csv       monthly revocations of every source, CSV
 *   GET /api/source/<id>/weekday-hour.csv, /api/weekday-hour.csv   revocations by weekday and hour (Brasília), CSV
 *   GET /api/algorithms.csv    signature algorithm of every source over time (one row per run of equal OIDs), CSV
 *   GET /api/iti, /api/iti.csv national certificate counts from ITI, one row per stored version (iti.ts)
 *   GET /api/pix, /api/pix.csv monthly Pix payments to companies (B2B, P2B), one row per stored month (pix.ts)
 *   GET /sources               the configured sources
 *   POST /api/run              run a collection now (needs the RUN_TOKEN secret as a bearer token; run.ts)
 *
 * Research support, separate from the collection (no page, nothing served back):
 *   POST /study/reports        the H3 case study inbox: an anonymous kya-study report, kept in R2 (study.ts)
 */
import sourcesJson from "../sources.json";
import { ID_RE, runCollection, validateSources } from "./collector.js";
import { DASHBOARD_HTML } from "./dashboard.js";
import type { SourceAgg } from "./aggregate.js";
import { toCsv } from "./csv.js";
import { type ItiRow, snapshotIti } from "./iti.js";
import { type PixRow, snapshotPix } from "./pix.js";
import { gateRun } from "./run.js";
import { receiveReport } from "./study.js";

export interface Env {
  LCR: R2Bucket;
  /** Secret. When set, POST /api/run with "Authorization: Bearer <RUN_TOKEN>" runs a collection now. */
  RUN_TOKEN?: string;
}

const sources = validateSources(sourcesJson);

const OPTIONS = {
  timeoutMs: 60_000,
  maxBytes: 64 * 1024 * 1024,
  concurrency: 6,
  userAgent: "kya-icp-collector/0.2 (+https://github.com/celfons/kya-icp)"
};

/** One collection run; returns where its log went and the outcome counts. */
async function collect(env: Env) {
  const { logKey, attempts } = await runCollection({ ...OPTIONS, sources, bucket: env.LCR, fetch: (input, init) => fetch(input, init), now: () => new Date() });
  const iti = await snapshotIti(env.LCR, (input, init) => fetch(input, init), new Date());
  const pix = await snapshotPix(env.LCR, (input, init) => fetch(input, init), new Date());
  const outcomes: Record<string, number> = {};
  for (const a of attempts) outcomes[a.outcome] = (outcomes[a.outcome] ?? 0) + 1;
  return { logKey, iti: iti.outcome === "error" ? { outcome: "error", error: iti.error } : { outcome: iti.outcome, as_of: iti.row.as_of, active: iti.row.active }, pix: pix.outcome === "stored" ? { outcome: "stored", month: pix.row.month } : pix, outcomes, aggregated: attempts.filter((a) => a.aggregated).length, aggregate_errors: attempts.filter((a) => a.aggregated === false && a.error).map((a) => ({ source: a.source, error: a.error })) };
}

const COMMON = { "access-control-allow-origin": "*", "x-content-type-options": "nosniff" };
const json = (body: unknown, status = 200, maxAge = 60) =>
  new Response(JSON.stringify(body), { status, headers: { ...COMMON, "content-type": "application/json; charset=utf-8", "cache-control": `public, max-age=${maxAge}` } });
const notFound = () => json({ error: "not found" }, 404, 0);
const csv = (body: string, filename: string) =>
  new Response(body, { headers: { ...COMMON, "content-type": "text/csv; charset=utf-8", "cache-control": "public, max-age=300", "content-disposition": `attachment; filename="${filename}"` } });

async function readJson<T>(env: Env, key: string): Promise<T | null> {
  const o = await env.LCR.get(key);
  return o ? ((await o.json()) as T) : null;
}

const WEEKDAYS = ["domingo", "segunda", "terca", "quarta", "quinta", "sexta", "sabado"];
const weekdayHourRows = (a: SourceAgg) => (a.weekday_hour ?? []).map((n, i) => [a.source, a.ac, a.kind, WEEKDAYS[Math.floor(i / 24)]!, i % 24, n]);
const WH_HEADER = ["fonte", "ac", "tipo", "dia_da_semana", "hora_brasilia", "revogacoes"];
const algorithmRows = (a: SourceAgg) => (a.algorithms ?? []).map((r) => [a.source, a.ac, a.kind, r.oid, r.name, r.first_this_update, r.last_this_update, r.versions]);
const ALG_HEADER = ["fonte", "ac", "tipo", "algoritmo_oid", "algoritmo", "primeira_lcr", "ultima_lcr", "versoes"];
const monthlyRows = (a: SourceAgg) => Object.entries(a.monthly).map(([month, n]) => [a.source, a.ac, a.kind, month, n]);

async function latestRun(env: Env): Promise<{ key: string; outcomes: Record<string, number> } | null> {
  const now = Date.now();
  for (const back of [0, 1]) {
    const d = new Date(now - back * 86_400_000).toISOString();
    const list = await env.LCR.list({ prefix: `log/${d.slice(0, 4)}/${d.slice(5, 7)}/${d.slice(8, 10)}/` });
    const key = list.objects.map((o) => o.key).sort().pop();
    if (!key) continue;
    const obj = await env.LCR.get(key);
    const outcomes: Record<string, number> = {};
    for (const line of obj ? (await obj.text()).split("\n") : []) {
      if (!line.trim()) continue;
      const o = (JSON.parse(line) as { outcome: string }).outcome;
      outcomes[o] = (outcomes[o] ?? 0) + 1;
    }
    return { key, outcomes };
  }
  return null;
}

async function serveObject(env: Env, key: string, contentType: string): Promise<Response> {
  const obj = await env.LCR.get(key);
  if (!obj) return notFound();
  return new Response(obj.body, { headers: { ...COMMON, "content-type": contentType, "cache-control": "public, max-age=86400, immutable", "content-disposition": `attachment; filename="${key.split("/").pop()}"` } });
}

export default {
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(collect(env).then((r) => console.log(JSON.stringify(r))));
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const { pathname, searchParams } = new URL(req.url);
    if (pathname === "/api/run") {
      const gate = await gateRun(req, env.RUN_TOKEN, env.LCR, new Date());
      if (!gate.ok) {
        const r = json({ error: gate.error }, gate.status, 0);
        if (gate.retry_after_s) r.headers.set("retry-after", String(gate.retry_after_s));
        return r;
      }
      return json(await collect(env), 200, 0);
    }
    if (pathname === "/study/reports") {
      const r = await receiveReport(req, env.LCR, new Date());
      return json(r.body, r.status, 0);
    }
    if (req.method !== "GET" && req.method !== "HEAD") return json({ error: "method not allowed" }, 405, 0);
    if (pathname === "/") {
      return new Response(DASHBOARD_HTML, { headers: { ...COMMON, "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=300", "content-security-policy": "default-src 'none'; script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'" } });
    }
    if (pathname === "/sources") return json(sources, 200, 300);
    if (pathname === "/api/status") return json({ service: "kya-icp collector", sources: sources.length, latest_run: await latestRun(env), repository: "https://github.com/celfons/kya-icp" }, 200, 60);
    if (pathname === "/api/summary") {
      const obj = await env.LCR.get("agg/index.json");
      return obj ? new Response(obj.body, { headers: { ...COMMON, "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300" } }) : json({ generated_at: null, sources: [] }, 200, 60);
    }
    const allCsv = { "/api/monthly.csv": [["fonte", "ac", "tipo", "mes", "revogacoes"], monthlyRows, "revogacoes-mensais.csv"], "/api/weekday-hour.csv": [WH_HEADER, weekdayHourRows, "revogacoes-dia-hora.csv"], "/api/algorithms.csv": [ALG_HEADER, algorithmRows, "algoritmos-de-assinatura.csv"] } as const;
    if (pathname in allCsv) {
      const [header, rowsOf, filename] = allCsv[pathname as keyof typeof allCsv];
      const index = await readJson<{ sources: { source: string }[] }>(env, "agg/index.json");
      const rows: (string | number)[][] = [];
      for (const s of index?.sources ?? []) {
        const a = await readJson<SourceAgg>(env, `agg/${s.source}.json`);
        if (a) rows.push(...rowsOf(a));
      }
      return csv(toCsv([...header], rows), filename);
    }
    if (pathname === "/api/iti" || pathname === "/api/iti.csv") {
      const series = (await readJson<ItiRow[]>(env, "agg/iti.json")) ?? [];
      if (pathname === "/api/iti") return json(series, 200, 300);
      const h = (r: ItiRow, k: string) => r.active_by_holder[k] ?? null;
      const t = (r: ItiRow, k: string) => r.active_by_type[k] ?? null;
      return csv(toCsv(["dados_de", "coletado_em", "ativos", "emitidos_no_ano", "ativos_pessoa_fisica", "ativos_pessoa_juridica", "ativos_equipamento", "ativos_a1", "ativos_a3"], series.map((r) => [r.as_of, r.fetched_at, r.active, r.issued_this_year, h(r, "Pessoa Fisica"), h(r, "Pessoa Juridica"), h(r, "Equipamentos/Aplicação"), t(r, "A1"), t(r, "A3")])), "iti-certificados-ativos.csv");
    }
    if (pathname === "/api/pix" || pathname === "/api/pix.csv") {
      const series = (await readJson<PixRow[]>(env, "agg/pix.json")) ?? [];
      if (pathname === "/api/pix") return json(series, 200, 300);
      const n = (r: PixRow, k: string, f: "value_brl" | "count" | "mean_brl") => r.natures[k]?.[f] ?? null;
      return csv(toCsv(["mes", "coletado_em", "b2b_valor", "b2b_quantidade", "b2b_media", "p2b_valor", "p2b_quantidade", "p2b_media"], series.map((r) => [r.month, r.fetched_at, n(r, "B2B", "value_brl"), n(r, "B2B", "count"), n(r, "B2B", "mean_brl"), n(r, "P2B", "value_brl"), n(r, "P2B", "count"), n(r, "P2B", "mean_brl")])), "pix-pagamentos-a-empresas.csv");
    }
    let m = /^\/api\/source\/([^/]+)\/weekday-hour\.csv$/.exec(pathname);
    if (m) {
      if (!ID_RE.test(m[1]!)) return notFound();
      const a = await readJson<SourceAgg>(env, `agg/${m[1]}.json`);
      return a ? csv(toCsv(WH_HEADER, weekdayHourRows(a)), `revogacoes-dia-hora-${m[1]}.csv`) : notFound();
    }
    m = /^\/api\/source\/([^/]+)\/monthly\.csv$/.exec(pathname);
    if (m) {
      if (!ID_RE.test(m[1]!)) return notFound();
      const a = await readJson<SourceAgg>(env, `agg/${m[1]}.json`);
      return a ? csv(toCsv(["fonte", "ac", "tipo", "mes", "revogacoes"], monthlyRows(a)), `revogacoes-mensais-${m[1]}.csv`) : notFound();
    }
    m = /^\/api\/source\/([^/]+)$/.exec(pathname);
    if (m) {
      if (!ID_RE.test(m[1]!)) return notFound();
      const obj = await env.LCR.get(`agg/${m[1]}.json`);
      return obj ? new Response(obj.body, { headers: { ...COMMON, "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300" } }) : notFound();
    }
    m = /^\/api\/files\/([^/]+)$/.exec(pathname);
    if (m) {
      if (!ID_RE.test(m[1]!)) return notFound();
      const cursor = searchParams.get("cursor") ?? undefined;
      const list = await env.LCR.list({ prefix: `lcr/${m[1]}/`, cursor, limit: 500 });
      return json({ files: list.objects.map((o) => ({ key: o.key, size: o.size, uploaded: o.uploaded })), cursor: list.truncated ? list.cursor : null }, 200, 60);
    }
    m = /^\/files\/((?:lcr\/[a-z0-9-]+\/[0-9TZ]+_[0-9a-f]{16}\.crl)|(?:log\/\d{4}\/\d{2}\/\d{2}\/\d{6}Z\.ndjson))$/.exec(pathname);
    if (m) return serveObject(env, m[1]!, m[1]!.endsWith(".crl") ? "application/pkix-crl" : "application/x-ndjson");
    return notFound();
  }
} satisfies ExportedHandler<Env>;
