import { describe, expect, it } from "vitest";
import type { Bucket } from "../src/collector.js";
import { previousMonth, queryUrl, snapshotPix, totals } from "../src/pix.js";

function memoryBucket() {
  const m = new Map<string, string>();
  const b: Bucket = {
    get: async (k) => (m.has(k) ? { text: async () => m.get(k)! } : null),
    list: async () => ({ objects: [], truncated: false }),
    put: async (k, v) => void m.set(k, typeof v === "string" ? v : new TextDecoder().decode(v as Uint8Array))
  };
  return { b, m };
}

const rows = (month: number) => [
  { AnoMes: month, VALOR: 1000, QUANTIDADE: 4 },
  { AnoMes: month, VALOR: 500, QUANTIDADE: 1 },
  { AnoMes: month + 1, VALOR: 9999, QUANTIDADE: 9 } // another month the service may return: left out
];
const fetchRows = (value: unknown[], calls: string[] = [], status = 200) =>
  (async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify({ value }), { status });
  }) as unknown as typeof fetch;

describe("Pix monthly snapshot", () => {
  it("targets the previous month, also across a year", () => {
    expect(previousMonth(new Date("2026-11-06T04:00:00Z"))).toBe("202610");
    expect(previousMonth(new Date("2027-01-02T00:00:00Z"))).toBe("202612");
  });

  it("builds the query for one month and nature only", () => {
    const u = queryUrl("202610", "B2B");
    expect(u).toContain("olinda.bcb.gov.br");
    expect(decodeURIComponent(u)).toContain("NATUREZA eq 'B2B'");
    expect(() => queryUrl("2026-10", "B2B")).toThrow();
    expect(() => queryUrl("202610", "P2P")).toThrow();
  });

  it("totals only the month asked for", () => {
    expect(totals(rows(202610), "202610")).toEqual({ value_brl: 1500, count: 5, mean_brl: 300 });
    expect(() => totals({}, "202610")).toThrow();
  });

  it("stores the month once, then reports unchanged", async () => {
    const { b, m } = memoryBucket();
    const now = new Date("2026-11-06T04:00:00Z");
    const first = await snapshotPix(b, fetchRows(rows(202610)), now);
    expect(first).toMatchObject({ outcome: "stored", row: { month: "202610", natures: { B2B: { mean_brl: 300 }, P2B: { mean_brl: 300 } } } });
    expect(m.has("bcb/pix/202610.json")).toBe(true);
    expect(JSON.parse(m.get("agg/pix.json")!)).toHaveLength(1);
    const calls: string[] = [];
    expect(await snapshotPix(b, fetchRows(rows(202610), calls), new Date("2026-11-06T05:00:00Z"))).toMatchObject({ outcome: "unchanged" });
    expect(calls).toHaveLength(0);
  });

  it("when the month is not published yet, tries again only after a day", async () => {
    const { b, m } = memoryBucket();
    const now = new Date("2026-11-01T01:00:00Z");
    expect(await snapshotPix(b, fetchRows([]), now)).toMatchObject({ outcome: "not_published", month: "202610" });
    expect(m.has("bcb/pix/202610.json")).toBe(false);
    const calls: string[] = [];
    expect(await snapshotPix(b, fetchRows(rows(202610), calls), new Date("2026-11-01T05:00:00Z"))).toMatchObject({ outcome: "not_due" });
    expect(calls).toHaveLength(0);
    expect(await snapshotPix(b, fetchRows(rows(202610)), new Date("2026-11-02T02:00:00Z"))).toMatchObject({ outcome: "stored" });
  });

  it("never throws: an HTTP error is an outcome", async () => {
    const { b } = memoryBucket();
    expect(await snapshotPix(b, fetchRows([], [], 503), new Date("2026-11-06T04:00:00Z"))).toMatchObject({ outcome: "error" });
  });
});
