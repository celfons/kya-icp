/// <reference types="node" />
/**
 * Live smoke test against the real sources (network). Skipped unless LIVE=1:
 *   LIVE=1 pnpm vitest run test/live.test.ts
 * Downloads every source once into an in-memory bucket and prints a table of outcomes and timings.
 */
import { describe, expect, it } from "vitest";
import sources from "../sources.json";
import { type Bucket, runCollection, validateSources } from "../src/collector.js";
import { parseCrlHeader } from "../src/der.js";

describe.skipIf(!process.env.LIVE)("live sources", () => {
  it("downloads the real CRLs and parses their headers", async () => {
    const stored = new Map<string, Uint8Array>();
    const bucket: Bucket = {
      get: async () => null,
      list: async () => ({ objects: [], truncated: false }),
      put: async (k, v) => void stored.set(k, typeof v === "string" ? new TextEncoder().encode(v) : new Uint8Array(v as ArrayBuffer))
    };
    const { attempts } = await runCollection({ sources: validateSources(sources), bucket, fetch, now: () => new Date(), timeoutMs: 60_000, maxBytes: 64 * 1024 * 1024, concurrency: 6, userAgent: "kya-icp-collector/0.1 (+https://github.com/celfons/kya-icp)" });
    console.table(attempts.map((a) => ({ source: a.source, outcome: a.outcome, status: a.http_status, kB: a.bytes ? Math.round(a.bytes / 1024) : null, entries: a.entries, this_update: a.this_update, ms: a.ms })));
    // Header parsing cost on the largest file actually downloaded.
    const biggest = [...stored.entries()].filter(([k]) => k.startsWith("lcr/")).sort((a, b) => b[1].length - a[1].length)[0];
    if (biggest) {
      const t0 = performance.now();
      const h = parseCrlHeader(biggest[1]);
      console.log(`header of ${biggest[0]} (${Math.round(biggest[1].length / 1024)} kB, ${h.entries} entries) parsed in ${(performance.now() - t0).toFixed(1)} ms`);
    }
    expect(attempts.some((a) => a.outcome === "stored")).toBe(true);
  }, 600_000);
});
