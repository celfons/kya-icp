import { describe, expect, it } from "vitest";
import type { Bucket } from "../src/collector.js";
import { CHECK_EVERY_MS, acsOf, latestAcs, parseAtualizado, rowOf, snapshotEstrutura } from "../src/estrutura.js";

const TREE = {
  tipo: "ac-root",
  nome: "AC RAIZ",
  situacao: 4002,
  atualizado_data: "29/10/2026",
  atualizado_hora: "10:21",
  entidades_vinculadas: [
    {
      tipo: "ac-1",
      nome: "AC RFB",
      situacao: 4002,
      entidades_vinculadas: [
        { tipo: "ac-2", nome: "AC SERPRO RFB", situacao: 4002, entidades_vinculadas: [{ tipo: "ar", nome: "AR SERPRO" }, { tipo: "ar", nome: "AR X" }] },
        { tipo: "ac-2", nome: "AC NOVA RFB", situacao: 4001, entidades_vinculadas: [] }
      ]
    },
    { tipo: "ac-1", nome: "AC SOLUTI", situacao: 4002, entidades_vinculadas: [{ tipo: "ac-2", nome: "AC SOLUTI MULTIPLA", situacao: 4002, entidades_vinculadas: [{ tipo: "ar", nome: "AR S" }] }] }
  ]
};

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
const T = new Date("2026-11-07T03:23:00Z");

describe("ICP-Brasil tree (ITI)", () => {
  it("parses the update stamp as UTC-3", () => {
    expect(parseAtualizado("29/10/2026", "10:21")).toBe("2026-10-29T13:21:00Z");
    expect(parseAtualizado("29/10/2026", undefined)).toBe("2026-10-29T03:00:00Z");
    expect(parseAtualizado("ontem", "10:21")).toBeNull();
  });

  it("walks the ACs and counts the ARs", () => {
    const { acs, ar } = acsOf(TREE);
    expect(ar).toBe(3);
    expect(acs).toEqual([
      { name: "AC RFB", level: 1, status: 4002, parent: "AC RAIZ" },
      { name: "AC SERPRO RFB", level: 2, status: 4002, parent: "AC RFB" },
      { name: "AC NOVA RFB", level: 2, status: 4001, parent: "AC RFB" },
      { name: "AC SOLUTI", level: 1, status: 4002, parent: "AC RAIZ" },
      { name: "AC SOLUTI MULTIPLA", level: 2, status: 4002, parent: "AC SOLUTI" }
    ]);
    expect(() => acsOf([{ tipo: "ar" }])).toThrow();
    expect(() => acsOf({ tipo: "ac-1" })).toThrow();
  });

  it("counts the row", () => {
    expect(rowOf(TREE, { fetched_at: "f", sha256: "s", key: "k" })).toEqual({ updated_on: "2026-10-29T13:21:00Z", fetched_at: "f", sha256: "s", key: "k", ac_level_1: 2, ac_level_2: 3, ac_level_2_accredited: 2, ac_level_2_rfb: 2, ar: 3 });
  });

  it("stores a new version once, reports unchanged after a day, and skips in between", async () => {
    const { b, m } = memoryBucket();
    const first = await snapshotEstrutura(b, fetchOf(JSON.stringify(TREE)), T);
    expect(first.outcome).toBe("stored");
    expect([...m.keys()].some((k) => /^iti\/estrutura\/20261029T132100Z_[0-9a-f]{16}\.json$/.test(k))).toBe(true);
    expect(JSON.parse(m.get("agg/estrutura.json")!)).toHaveLength(1);
    const hourLater = await snapshotEstrutura(b, fetchOf("must not be fetched"), new Date(T.getTime() + 3600_000));
    expect(hourLater.outcome).toBe("skipped");
    const dayLater = await snapshotEstrutura(b, fetchOf(JSON.stringify(TREE)), new Date(T.getTime() + CHECK_EVERY_MS));
    expect(dayLater.outcome).toBe("unchanged");
    expect(JSON.parse(m.get("agg/estrutura.json")!)).toHaveLength(1);
    const changed = { ...TREE, atualizado_data: "30/10/2026" };
    const twoDays = await snapshotEstrutura(b, fetchOf(JSON.stringify(changed)), new Date(T.getTime() + 2 * CHECK_EVERY_MS));
    expect(twoDays.outcome).toBe("stored");
    expect(JSON.parse(m.get("agg/estrutura.json")!)).toHaveLength(2);
    const latest = await latestAcs(b);
    expect(latest?.updated_on).toBe("2026-10-30T13:21:00Z");
    expect(latest?.acs.filter((a) => a.level === 2)).toHaveLength(3);
  });

  it("never throws, and serves nothing before the first version", async () => {
    const { b } = memoryBucket();
    expect(await latestAcs(b)).toBeNull();
    expect(await snapshotEstrutura(b, fetchOf("x", 503), T)).toEqual({ outcome: "error", error: "HTTP 503" });
    expect((await snapshotEstrutura(b, fetchOf("not json"), T)).outcome).toBe("error");
    expect((await snapshotEstrutura(b, fetchOf(JSON.stringify([{ tipo: "ar" }])), T)).outcome).toBe("error");
  });
});
