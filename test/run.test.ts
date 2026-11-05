import { describe, expect, it } from "vitest";
import type { Bucket } from "../src/collector.js";
import { MIN_INTERVAL_MS, gateRun, sameSecret } from "../src/run.js";

function memoryBucket(): Bucket {
  const m = new Map<string, string>();
  return {
    get: async (k) => (m.has(k) ? { text: async () => m.get(k)! } : null),
    list: async () => ({ objects: [], truncated: false }),
    put: async (k, v) => void m.set(k, typeof v === "string" ? v : new TextDecoder().decode(v as Uint8Array))
  };
}

const req = (method: string, auth?: string) => new Request("https://x/api/run", { method, headers: auth ? { authorization: auth } : {} });
const T = new Date("2026-11-05T04:00:00Z");

describe("POST /api/run gate", () => {
  it("does not exist without the RUN_TOKEN secret", async () => {
    expect(await gateRun(req("POST", "Bearer anything"), undefined, memoryBucket(), T)).toMatchObject({ ok: false, status: 404 });
    expect(await gateRun(req("POST", "Bearer anything"), "", memoryBucket(), T)).toMatchObject({ ok: false, status: 404 });
  });

  it("needs POST and the exact bearer token", async () => {
    const b = memoryBucket();
    expect(await gateRun(req("GET", "Bearer s3cret"), "s3cret", b, T)).toMatchObject({ ok: false, status: 405 });
    expect(await gateRun(req("POST"), "s3cret", b, T)).toMatchObject({ ok: false, status: 401 });
    expect(await gateRun(req("POST", "Bearer s3cre"), "s3cret", b, T)).toMatchObject({ ok: false, status: 401 });
    expect(await gateRun(req("POST", "Basic s3cret"), "s3cret", b, T)).toMatchObject({ ok: false, status: 401 });
    expect(await gateRun(req("POST", "Bearer s3cret"), "s3cret", b, T)).toEqual({ ok: true });
  });

  it("refuses a second run within 5 minutes, then allows it", async () => {
    const b = memoryBucket();
    expect((await gateRun(req("POST", "Bearer t"), "t", b, T)).ok).toBe(true);
    const again = await gateRun(req("POST", "Bearer t"), "t", b, new Date(T.getTime() + 60_000));
    expect(again).toMatchObject({ ok: false, status: 429, retry_after_s: 240 });
    expect((await gateRun(req("POST", "Bearer t"), "t", b, new Date(T.getTime() + MIN_INTERVAL_MS))).ok).toBe(true);
  });

  it("compares secrets fully, whatever the lengths", () => {
    expect(sameSecret("abc", "abc")).toBe(true);
    expect(sameSecret("abc", "abd")).toBe(false);
    expect(sameSecret("abc", "abcd")).toBe(false);
    expect(sameSecret("", "a")).toBe(false);
  });
});
