/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DerError, parseCrlHeader, readTime, readTlv } from "../src/der.js";

// Two public ICP-Brasil CRLs of AC certificates, downloaded on 2026-11-05 (values checked with `openssl crl`).
const small = new Uint8Array(readFileSync(new URL("./fixtures/ac-small.crl", import.meta.url)));
const larger = new Uint8Array(readFileSync(new URL("./fixtures/ac-larger.crl", import.meta.url)));

describe("parseCrlHeader", () => {
  it("reads the header of real ICP-Brasil CRLs as openssl does", () => {
    expect(parseCrlHeader(small)).toMatchObject({ thisUpdate: "2026-09-24T14:52:04Z", nextUpdate: "2026-12-23T14:52:04Z", crlNumber: "74", entries: 2 });
    expect(parseCrlHeader(larger)).toMatchObject({ thisUpdate: "2026-10-16T14:00:53Z", nextUpdate: "2027-01-14T14:00:53Z", crlNumber: "28", entries: 5 });
  });

  it("returns the issuer's raw DER, which starts with a SEQUENCE and names the AC", () => {
    const h = parseCrlHeader(larger).issuerDerHex;
    expect(h.startsWith("30")).toBe(true);
    expect(Buffer.from(h, "hex").toString("latin1")).toContain("AC PRODESP SP");
  });

  it("refuses what is not a CRL: an HTML error page, a truncated file, trailing bytes, an empty body", () => {
    expect(() => parseCrlHeader(new TextEncoder().encode("<html><body>Not found</body></html>"))).toThrow(DerError);
    expect(() => parseCrlHeader(small.subarray(0, small.length - 10))).toThrow(DerError);
    expect(() => parseCrlHeader(new Uint8Array([...small, 0]))).toThrow(DerError);
    expect(() => parseCrlHeader(new Uint8Array())).toThrow(DerError);
  });
});

describe("DER primitives", () => {
  it("reads short and long lengths", () => {
    expect(readTlv(Uint8Array.of(0x04, 0x02, 0xaa, 0xbb), 0)).toEqual({ tag: 4, pos: 0, start: 2, end: 4 });
    const long = new Uint8Array(3 + 200);
    long.set([0x04, 0x81, 200]);
    expect(readTlv(long, 0)).toEqual({ tag: 4, pos: 0, start: 3, end: 203 });
    expect(() => readTlv(Uint8Array.of(0x04, 0x05, 0x00), 0)).toThrow(/overruns/);
  });

  it("converts UTCTime and GeneralizedTime to ISO 8601", () => {
    const tlv = (tag: number, s: string) => {
      const b = Uint8Array.of(tag, s.length, ...new TextEncoder().encode(s));
      return { b, t: readTlv(b, 0) };
    };
    let x = tlv(0x17, "261105023514Z");
    expect(readTime(x.b, x.t)).toBe("2026-11-05T02:35:14Z");
    x = tlv(0x17, "991231235959Z");
    expect(readTime(x.b, x.t)).toBe("1999-12-31T23:59:59Z");
    x = tlv(0x18, "20501231235959Z");
    expect(readTime(x.b, x.t)).toBe("2050-12-31T23:59:59Z");
    x = tlv(0x17, "2611050235Z");
    expect(() => readTime(x.b, x.t)).toThrow(DerError);
  });
});
