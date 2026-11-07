/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import sources from "../sources.json";
import { type Bucket, type RunOptions, type Source, hostPacer, interleaveByHost, runCollection, validateSources } from "../src/collector.js";

const small = new Uint8Array(readFileSync(new URL("./fixtures/ac-small.crl", import.meta.url)));
const larger = new Uint8Array(readFileSync(new URL("./fixtures/ac-larger.crl", import.meta.url)));

/** In-memory stand-in for the R2 binding. */
function memoryBucket() {
  const objects = new Map<string, { body: Uint8Array; meta?: Record<string, string> }>();
  const bucket: Bucket = {
    async get(key) {
      const o = objects.get(key);
      return o ? { text: async () => new TextDecoder().decode(o.body) } : null;
    },
    async list({ prefix }) {
      return { objects: [...objects.keys()].filter((k) => k.startsWith(prefix)).sort().map((key) => ({ key, size: objects.get(key)!.body.length, uploaded: new Date(0) })), truncated: false };
    },
    async put(key, value, options) {
      const body = typeof value === "string" ? new TextEncoder().encode(value) : value instanceof Uint8Array ? value : new Uint8Array(value);
      objects.set(key, { body: body.slice(), meta: options?.customMetadata });
    }
  };
  return { bucket, objects };
}

const src = (id: string, url = `http://lcr.example/${id}.crl`): Source => ({ id, ac: `AC ${id}`, url, kind: "usuario-final" });

/** A fetch that serves a fixed table of responses and counts calls. */
function fakeFetch(table: Record<string, () => Response | Promise<Response>>) {
  const calls: string[] = [];
  const f = (async (input: RequestInfo | URL) => {
    const url = String(input);
    calls.push(url);
    const r = table[url];
    if (!r) throw new TypeError("network down");
    return r();
  }) as typeof fetch;
  return { f, calls };
}

let clock = Date.parse("2026-11-05T04:23:00Z");
const opts = (o: Partial<RunOptions> & Pick<RunOptions, "sources" | "bucket" | "fetch">): RunOptions => ({ now: () => new Date(clock), timeoutMs: 1000, maxBytes: 1_000_000, concurrency: 3, hostGapMs: 0, userAgent: "test", ...o });
const crl = (b: Uint8Array) => () => new Response(b, { status: 200 });

describe("runCollection", () => {
  it("stores a new CRL raw, with its header in metadata, then skips it while unchanged and stores the next version", async () => {
    const { bucket, objects } = memoryBucket();
    let body = small;
    const { f } = fakeFetch({ "http://lcr.example/a.crl": () => new Response(body) });
    const r1 = await runCollection(opts({ sources: [src("a")], bucket, fetch: f }));
    expect(r1.attempts[0]).toMatchObject({ outcome: "stored", http_status: 200, bytes: small.length, this_update: "2026-09-24T14:52:04Z", crl_number: "74", entries: 2, signature_algorithm: "1.2.840.113549.1.1.13" });
    const key1 = r1.attempts[0]!.key!;
    expect(key1).toMatch(/^lcr\/a\/20260924T145204Z_[0-9a-f]{16}\.crl$/);
    expect([...objects.get(key1)!.body]).toEqual([...small]); // byte for byte
    expect(objects.get(key1)!.meta).toMatchObject({ source: "a", url: "http://lcr.example/a.crl", entries: "2", crl_number: "74", next_update: "2026-12-23T14:52:04Z", signature_algorithm: "1.2.840.113549.1.1.13" });

    clock += 3_600_000;
    const r2 = await runCollection(opts({ sources: [src("a")], bucket, fetch: f }));
    expect(r2.attempts[0]).toMatchObject({ outcome: "unchanged", key: key1 });
    expect([...objects.keys()].filter((k) => k.startsWith("lcr/"))).toHaveLength(1);

    clock += 3_600_000;
    body = larger;
    const r3 = await runCollection(opts({ sources: [src("a")], bucket, fetch: f }));
    expect(r3.attempts[0]).toMatchObject({ outcome: "stored", crl_number: "28" });
    expect([...objects.keys()].filter((k) => k.startsWith("lcr/"))).toHaveLength(2); // the old version is kept
  });

  it("records every failure without storing anything, and logs one line per source", async () => {
    const { bucket, objects } = memoryBucket();
    const { f } = fakeFetch({
      "http://lcr.example/ok.crl": crl(small),
      "http://lcr.example/missing.crl": () => new Response("no", { status: 404 }),
      "http://lcr.example/html.crl": () => new Response("<html>maintenance</html>", { status: 200 }),
      "http://lcr.example/huge.crl": () => new Response("x", { status: 200, headers: { "content-length": "999999999" } })
    });
    const sources = ["ok", "missing", "html", "huge", "down"].map((id) => src(id));
    const { logKey, attempts } = await runCollection(opts({ sources, bucket, fetch: f }));
    const by = Object.fromEntries(attempts.map((a) => [a.source, a]));
    expect(by.ok!.outcome).toBe("stored");
    expect(by.missing).toMatchObject({ outcome: "http_error", http_status: 404, key: null });
    expect(by.html).toMatchObject({ outcome: "not_a_crl", key: null });
    expect(by.html!.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(by.huge).toMatchObject({ outcome: "too_large", bytes: 999999999 });
    expect(by.down).toMatchObject({ outcome: "network_error", error: "network down" });
    expect([...objects.keys()].filter((k) => k.startsWith("lcr/"))).toEqual([by.ok!.key]);
    expect(logKey).toMatch(/^log\/\d{4}\/\d{2}\/\d{2}\/\d{6}Z\.ndjson$/);
    const lines = new TextDecoder().decode(objects.get(logKey)!.body).trim().split("\n").map((l) => JSON.parse(l));
    expect(lines.map((l) => l.source).sort()).toEqual(["down", "html", "huge", "missing", "ok"]);
  });

  it("does not let one slow or failing source stop the others", async () => {
    const { bucket } = memoryBucket();
    const many = Array.from({ length: 10 }, (_, i) => src(`s${i}`));
    const table: Record<string, () => Response | Promise<Response>> = {};
    many.forEach((s, i) => (table[s.url] = i % 3 === 0 ? () => Promise.reject(new Error("reset")) : crl(i % 2 ? small : larger)));
    const { f, calls } = fakeFetch(table);
    const { attempts } = await runCollection(opts({ sources: many, bucket, fetch: f, concurrency: 4 }));
    expect(calls).toHaveLength(10);
    expect(attempts.filter((a) => a.outcome === "network_error")).toHaveLength(4);
    expect(attempts.filter((a) => a.outcome === "stored")).toHaveLength(6);
  });
});

describe("host pacing", () => {
  it("keeps requests to one host hostGapMs apart and lets other hosts go at once", async () => {
    const waits: number[] = [];
    const pace = hostPacer({ hostGapMs: 2000, now: () => new Date(clock), sleep: async (ms) => void waits.push(ms) });
    expect(await pace("http://ccd.example/a.crl")).toBe(0);
    expect(await pace("http://ccd.example/b.crl")).toBe(2000);
    expect(await pace("http://other.example/c.crl")).toBe(0);
    expect(await pace("http://ccd.example/d.crl")).toBe(4000);
    expect(waits).toEqual([2000, 4000]);
  });

  it("interleaves the sources by host, biggest host first", () => {
    const list = [src("a1", "http://a/1"), src("a2", "http://a/2"), src("a3", "http://a/3"), src("b1", "http://b/1"), src("c1", "http://c/1")];
    expect(interleaveByHost(list).map((s) => s.id)).toEqual(["a1", "b1", "c1", "a2", "a3"]);
  });

  it("paces the real run: the 24 Soluti lists do not go out in one burst", async () => {
    const { bucket } = memoryBucket();
    const waits: number[] = [];
    const { f } = fakeFetch({ "http://ccd.example/a.crl": crl(small), "http://ccd.example/b.crl": crl(small), "http://ccd.example/c.crl": crl(small) });
    const sources = [src("a", "http://ccd.example/a.crl"), src("b", "http://ccd.example/b.crl"), src("c", "http://ccd.example/c.crl")];
    const r = await runCollection(opts({ sources, bucket, fetch: f, hostGapMs: 1500, sleep: async (ms) => void waits.push(ms) }));
    expect(r.attempts.every((a) => a.outcome === "stored")).toBe(true);
    expect(waits.sort((x, y) => x - y)).toEqual([1500, 3000]);
  });
});

describe("mirror", () => {
  const withMirror = { ...src("m", "http://ccd.example/m.crl"), mirror: "http://ccd2.example/m.crl" };

  it("falls back to the mirror when the primary host refuses, and records that", async () => {
    const { bucket, objects } = memoryBucket();
    const { f, calls } = fakeFetch({ "http://ccd.example/m.crl": () => new Response("no", { status: 403 }), "http://ccd2.example/m.crl": crl(small) });
    const r = await runCollection(opts({ sources: [withMirror], bucket, fetch: f }));
    expect(r.attempts[0]).toMatchObject({ outcome: "stored", url: "http://ccd2.example/m.crl", fallback: true, http_status: 200 });
    expect(calls).toEqual(["http://ccd.example/m.crl", "http://ccd2.example/m.crl"]);
    expect(objects.get(r.attempts[0]!.key!)!.meta).toMatchObject({ url: "http://ccd2.example/m.crl" });
  });

  it("falls back on a network failure too, and keeps the primary's answer when the mirror is also down", async () => {
    const { bucket } = memoryBucket();
    const { f } = fakeFetch({ "http://ccd2.example/m.crl": crl(small) });
    const r = await runCollection(opts({ sources: [withMirror], bucket, fetch: f }));
    expect(r.attempts[0]).toMatchObject({ outcome: "stored", fallback: true });

    const bothDown = fakeFetch({ "http://ccd.example/m.crl": () => new Response("no", { status: 503 }) });
    const r2 = await runCollection(opts({ sources: [withMirror], bucket, fetch: bothDown.f }));
    expect(r2.attempts[0]).toMatchObject({ outcome: "http_error", http_status: 503, url: "http://ccd.example/m.crl", fallback: false });
  });

  it("does not use the mirror when the primary answered with a body", async () => {
    const { bucket } = memoryBucket();
    const { f, calls } = fakeFetch({ "http://ccd.example/m.crl": () => new Response(new Uint8Array([1, 2, 3])), "http://ccd2.example/m.crl": crl(small) });
    const r = await runCollection(opts({ sources: [withMirror], bucket, fetch: f }));
    expect(r.attempts[0]).toMatchObject({ outcome: "not_a_crl", fallback: false });
    expect(calls).toEqual(["http://ccd.example/m.crl"]);
  });
});

describe("sources", () => {
  it("sources.json is valid: unique ids, http(s) URLs, known kinds", () => {
    const s = validateSources(sources);
    expect(s.length).toBeGreaterThan(10);
    expect(s.some((x) => x.kind === "usuario-final")).toBe(true);
  });

  it("refuses bad lists", () => {
    expect(() => validateSources([])).toThrow();
    expect(() => validateSources([src("a"), src("a")])).toThrow(/duplicated/);
    expect(() => validateSources([{ ...src("a"), id: "A b" }])).toThrow(/id/);
    expect(() => validateSources([{ ...src("a"), url: "ftp://x/y.crl" }])).toThrow(/url/);
    expect(() => validateSources([{ ...src("a"), kind: "other" }])).toThrow(/kind/);
    expect(() => validateSources([{ ...src("a"), mirror: "ftp://x/y.crl" }])).toThrow(/mirror/);
    expect(() => validateSources([{ ...src("a"), mirror: src("a").url }])).toThrow(/mirror/);
    expect(validateSources([{ ...src("a"), mirror: "http://m/a.crl" }])[0]).toMatchObject({ mirror: "http://m/a.crl" });
    expect(validateSources([src("a")])[0]).not.toHaveProperty("mirror");
  });
});
