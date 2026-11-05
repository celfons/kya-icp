/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { type SourceAgg, weekdayHourIndex } from "../src/aggregate.js";
import { type Bucket, type Source, runCollection } from "../src/collector.js";
import { type CrlEntry, forEachEntry, parseCrlHeader } from "../src/der.js";

const fx = (n: string) => new Uint8Array(readFileSync(new URL(`./fixtures/${n}`, import.meta.url)));
// seq-1..3: three versions of one test CRL, 6 hours apart from 2026-11-05T00:00Z (generated with Python cryptography):
//   seq-1 lists 01 (2026-09-10) and 02 (2026-10-01, keyCompromise)
//   seq-2 adds 0303, revoked at 01:00, so first seen 5 h later
//   seq-3 adds 0404, revoked at 02:00 (superseded), first seen 10 h later
const seq = [fx("seq-1.crl"), fx("seq-2.crl"), fx("seq-3.crl")];

function memoryBucket() {
  const objects = new Map<string, Uint8Array>();
  const bucket: Bucket = {
    get: async (k) => (objects.has(k) ? { text: async () => new TextDecoder().decode(objects.get(k)) } : null),
    list: async ({ prefix }) => ({ objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).map((key) => ({ key, size: 0, uploaded: new Date(0) })), truncated: false }),
    put: async (k, v) => void objects.set(k, typeof v === "string" ? new TextEncoder().encode(v) : new Uint8Array(v as ArrayBuffer))
  };
  return { bucket, objects, json: <T>(k: string) => JSON.parse(new TextDecoder().decode(objects.get(k))) as T };
}

describe("forEachEntry", () => {
  it("lists serial, revocation date and reason presence of every entry", () => {
    const got: CrlEntry[] = [];
    forEachEntry(seq[2]!, (e) => got.push(e));
    expect(got).toEqual([
      { serialHex: "01", revocationDate: "2026-09-10T00:00:00Z", hasReason: false },
      { serialHex: "02", revocationDate: "2026-10-01T00:00:00Z", hasReason: true },
      { serialHex: "0303", revocationDate: "2026-11-05T01:00:00Z", hasReason: false },
      { serialHex: "0404", revocationDate: "2026-11-05T02:00:00Z", hasReason: true }
    ]);
  });

  it("agrees with the header count on real ICP-Brasil CRLs", () => {
    for (const n of ["ac-small.crl", "ac-larger.crl"]) {
      const b = fx(n);
      let count = 0;
      forEachEntry(b, () => count++);
      expect(count).toBe(parseCrlHeader(b).entries);
    }
  });
});

describe("aggregates", () => {
  const src: Source = { id: "uf-teste", ac: "AC Teste", url: "http://lcr.example/t.crl", kind: "usuario-final" };

  it("measures the publication delay of revocations that appear during the collection, and the monthly series", async () => {
    const { bucket, json } = memoryBucket();
    let current = 0;
    let clock = Date.parse("2026-11-05T00:30:00Z");
    const run = () => runCollection({ sources: [src], bucket, fetch: (async () => new Response(seq[current])) as typeof fetch, now: () => new Date(clock), timeoutMs: 1000, maxBytes: 1e6, concurrency: 1, userAgent: "t" });

    expect((await run()).attempts[0]).toMatchObject({ outcome: "stored", aggregated: true });
    let agg = json<SourceAgg>("agg/uf-teste.json");
    expect(agg).toMatchObject({ versions: 1, entries: 2, measured_delays: 0, delay_median_h: null, monthly: { "2026-09": 1, "2026-10": 1 } });
    expect(agg.weekday_hour).toHaveLength(168);
    expect(agg.weekday_hour!.reduce((a, b) => a + b, 0)).toBe(2);

    current = 1;
    clock += 6 * 3_600_000;
    await run();
    current = 2;
    clock += 6 * 3_600_000;
    await run();
    agg = json<SourceAgg>("agg/uf-teste.json");
    expect(agg).toMatchObject({
      versions: 3,
      first_this_update: "2026-11-05T00:00:00Z",
      last_this_update: "2026-11-05T12:00:00Z",
      entries: 4,
      entries_with_reason: 2,
      delays_h: [5, 10],
      measured_delays: 2,
      delay_median_h: 7.5,
      delay_max_h: 10,
      monthly: { "2026-09": 1, "2026-10": 1, "2026-11": 2 }
    });
    const index = json<{ sources: { source: string; delay_median_h: number }[] }>("agg/index.json");
    expect(index.sources).toEqual([expect.objectContaining({ source: "uf-teste", delay_median_h: 7.5 })]);

    // A mirror serving an older version: stored raw (it is a different file), but never folded into the aggregate.
    current = 1;
    clock += 3_600_000;
    expect((await run()).attempts[0]).toMatchObject({ outcome: "stored", aggregated: false });
    expect(json<SourceAgg>("agg/uf-teste.json").versions).toBe(3);
  });
});

describe("weekdayHourIndex", () => {
  it("uses Brasília time", () => {
    // Thursday 2026-11-05 02:00Z is Wednesday 23:00 in Brasília
    expect(weekdayHourIndex("2026-11-05T02:00:00Z")).toBe(3 * 24 + 23);
    expect(weekdayHourIndex("2026-11-05T13:00:00Z")).toBe(4 * 24 + 10);
  });
});
