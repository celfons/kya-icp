import { describe, expect, it } from "vitest";
import type { Bucket } from "../src/collector.js";
import { parseFinalizado, rowOf, snapshotIti } from "../src/iti.js";

const PANELS = [
  { finalizado: "04/11/2026, 06:47:04" },
  { cerVisGerAtivos: 17175212 },
  { cerVisGerEmitidos: 900 },
  { cerVisGerDisAssinatura: [{ tipo_usuario: "Pessoa Fisica", qtdcertificado: 8 }] },
  { cerVisGerDisTipo: [{ tipo_certificado: "A1", qtdcertificado: 5 }] },
  { cerVisGerCompMenAnoAtual: [1, 2] }
];

function memoryBucket() {
  const m = new Map<string, string>();
  const b: Bucket = {
    get: async (k) => (m.has(k) ? { text: async () => m.get(k)! } : null),
    list: async () => ({ objects: [], truncated: false }),
    put: async (k, v) => void m.set(k, typeof v === "string" ? v : new TextDecoder().decode(v as Uint8Array))
  };
  return { b, m };
}
const fetchOf = (body: string, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch;
const T = new Date("2026-11-05T04:00:00Z");

describe("ITI denominator", () => {
  it("parses finalizado as UTC-3", () => {
    expect(parseFinalizado("04/11/2026, 06:47:04")).toBe("2026-11-04T09:47:04Z");
    expect(parseFinalizado("ontem")).toBeNull();
  });

  it("extracts the counts", () => {
    const r = rowOf(PANELS, { fetched_at: "f", sha256: "s", key: "k" });
    expect(r).toMatchObject({ active: 17175212, issued_this_year: 900, active_by_holder: { "Pessoa Fisica": 8 }, active_by_type: { A1: 5 }, issued_monthly_this_year: [1, 2], issued_monthly_last_year: null });
    expect(() => rowOf([{}], { fetched_at: "f", sha256: "s", key: "k" })).toThrow();
  });

  it("stores a new version once, then reports unchanged", async () => {
    const { b, m } = memoryBucket();
    const first = await snapshotIti(b, fetchOf(JSON.stringify(PANELS)), T);
    expect(first.outcome).toBe("stored");
    expect([...m.keys()].some((k) => /^iti\/panels\/20261104T094704Z_[0-9a-f]{16}\.json$/.test(k))).toBe(true);
    expect(JSON.parse(m.get("agg/iti.json")!)).toHaveLength(1);
    const second = await snapshotIti(b, fetchOf(JSON.stringify(PANELS)), T);
    expect(second.outcome).toBe("unchanged");
    expect(JSON.parse(m.get("agg/iti.json")!)).toHaveLength(1);
  });

  it("never throws", async () => {
    const { b } = memoryBucket();
    expect(await snapshotIti(b, fetchOf("x", 503), T)).toEqual({ outcome: "error", error: "HTTP 503" });
    expect((await snapshotIti(b, fetchOf("not json"), T)).outcome).toBe("error");
  });
});
