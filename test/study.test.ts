import { describe, expect, it } from "vitest";
import type { Bucket } from "../src/collector.js";
import { HOURLY_CAP, MAX_BYTES, checkReport, receiveReport } from "../src/study.js";

function memoryBucket() {
  const m = new Map<string, string>();
  const b: Bucket = {
    get: async (k) => (m.has(k) ? { text: async () => m.get(k)! } : null),
    list: async () => ({ objects: [], truncated: false }),
    put: async (k, v) => void m.set(k, typeof v === "string" ? v : new TextDecoder().decode(v as Uint8Array))
  };
  return { b, m };
}
const report = (over: Record<string, unknown> = {}) => ({ schema: "kya-study-report/1", participant_id: "p-0123456789", kit_version: "0.1.3", finished: true, tasks: {}, ...over });
const post = (body: string, headers: Record<string, string> = { "content-type": "application/json" }) =>
  new Request("https://x/study/reports", { method: "POST", headers, body });
const T = new Date("2026-11-06T10:15:30.123Z");

describe("study inbox", () => {
  it("checks the report's structure", () => {
    expect(checkReport(report())).toEqual({ id: "p-0123456789" });
    expect(checkReport([])).toMatchObject({ error: expect.any(String) });
    expect(checkReport(report({ schema: "x" }))).toMatchObject({ error: "not a kya-study-report/1" });
    expect(checkReport(report({ participant_id: "../etc" }))).toMatchObject({ error: "bad participant_id" });
    expect(checkReport(report({ tasks: [] }))).toMatchObject({ error: "tasks is not an object" });
  });

  it("stores a valid report under its id and time, and nothing else about the request", async () => {
    const { b, m } = memoryBucket();
    const body = JSON.stringify(report());
    const r = await receiveReport(post(body, { "content-type": "application/json", "x-forwarded-for": "203.0.113.9", "cf-connecting-ip": "203.0.113.9" }), b, T);
    expect(r).toMatchObject({ status: 201, body: { ok: true, participant_id: "p-0123456789" } });
    expect(m.get("study/reports/p-0123456789/20261106T101530Z.json")).toBe(body);
    expect([...m.values()].join("")).not.toContain("203.0.113.9");
  });

  it("a second send adds a file instead of overwriting", async () => {
    const { b, m } = memoryBucket();
    await receiveReport(post(JSON.stringify(report())), b, T);
    await receiveReport(post(JSON.stringify(report({ finished: false }))), b, new Date("2026-11-06T11:00:00Z"));
    expect([...m.keys()].filter((k) => k.startsWith("study/reports/"))).toHaveLength(2);
  });

  it("refuses wrong methods, types, sizes and shapes", async () => {
    const { b, m } = memoryBucket();
    expect((await receiveReport(new Request("https://x/study/reports"), b, T)).status).toBe(405);
    expect((await receiveReport(post(JSON.stringify(report()), { "content-type": "text/plain" }), b, T)).status).toBe(415);
    expect((await receiveReport(post("x".repeat(MAX_BYTES + 1)), b, T)).status).toBe(413);
    expect((await receiveReport(post("{ nope"), b, T)).status).toBe(400);
    expect((await receiveReport(post(JSON.stringify(report({ participant_id: "x" }))), b, T)).status).toBe(400);
    expect([...m.keys()].some((k) => k.startsWith("study/reports/"))).toBe(false);
  });

  it("caps the reports per hour", async () => {
    const { b, m } = memoryBucket();
    m.set("study/state/hour-2026110610.json", JSON.stringify({ count: HOURLY_CAP }));
    expect((await receiveReport(post(JSON.stringify(report())), b, T)).status).toBe(429);
  });
});
