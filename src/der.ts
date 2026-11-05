/**
 * Just enough DER to read the header of an X.509 CRL (RFC 5280, section 5.1) without decoding its entries:
 *
 *   CertificateList ::= SEQUENCE { tbsCertList TBSCertList, signatureAlgorithm, signatureValue }
 *   TBSCertList ::= SEQUENCE {
 *     version INTEGER OPTIONAL, signature AlgorithmIdentifier, issuer Name,
 *     thisUpdate Time, nextUpdate Time OPTIONAL,
 *     revokedCertificates SEQUENCE OF SEQUENCE {...} OPTIONAL,
 *     crlExtensions [0] EXPLICIT Extensions OPTIONAL }
 *
 * The revoked list is skipped by length (entries are only counted, never parsed), so a CRL with hundreds of
 * thousands of entries costs a few milliseconds. The full analysis runs offline, from the raw files kept in R2.
 */

export interface Tlv {
  tag: number;
  /** Offset of the tag byte. */
  pos: number;
  /** Offset of the value (after tag and length). */
  start: number;
  /** Offset just past the value. */
  end: number;
}

export class DerError extends Error {}

/** Reads one TLV at `pos` (single-byte tags only, which is all X.509 uses). */
export function readTlv(b: Uint8Array, pos: number, limit = b.length): Tlv {
  if (pos + 2 > limit) throw new DerError(`truncated TLV at ${pos}`);
  const tag = b[pos]!;
  if ((tag & 0x1f) === 0x1f) throw new DerError(`multi-byte tag at ${pos}`);
  let len = b[pos + 1]!;
  let start = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new DerError(`unsupported length form at ${pos}`);
    if (start + n > limit) throw new DerError(`truncated length at ${pos}`);
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + b[start + i]!;
    start += n;
  }
  const end = start + len;
  if (end > limit) throw new DerError(`value overruns its container at ${pos} (${end} > ${limit})`);
  return { tag, pos, start, end };
}

/** The TLVs directly inside a constructed value. */
export function children(b: Uint8Array, parent: Tlv): Tlv[] {
  const out: Tlv[] = [];
  for (let p = parent.start; p < parent.end; ) {
    const t = readTlv(b, p, parent.end);
    out.push(t);
    p = t.end;
  }
  return out;
}

const ascii = (b: Uint8Array, t: Tlv) => String.fromCharCode(...b.subarray(t.start, t.end));

/** UTCTime (0x17, YYMMDDHHMMSSZ; years 50-99 are 19xx) or GeneralizedTime (0x18, YYYYMMDDHHMMSSZ) as ISO 8601. */
export function readTime(b: Uint8Array, t: Tlv): string {
  const s = ascii(b, t);
  let m: RegExpExecArray | null;
  if (t.tag === 0x17 && (m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s))) {
    const yy = Number(m[1]);
    return `${yy >= 50 ? 1900 + yy : 2000 + yy}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  }
  if (t.tag === 0x18 && (m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.\d+)?Z$/.exec(s))) {
    return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`;
  }
  throw new DerError(`not a DER time: tag ${t.tag} "${s}"`);
}

const isTime = (t: Tlv) => t.tag === 0x17 || t.tag === 0x18;
const hex = (u: Uint8Array) => [...u].map((x) => x.toString(16).padStart(2, "0")).join("");
/** 2.5.29.20 cRLNumber */
const OID_CRL_NUMBER = Uint8Array.of(0x55, 0x1d, 0x14);

export interface CrlHeader {
  /** Raw DER of the issuer Name, hex: compare issuers byte for byte, map them to names offline. */
  issuerDerHex: string;
  thisUpdate: string;
  nextUpdate: string | null;
  /** cRLNumber extension as a decimal string (it can exceed 2^53), or null when absent. */
  crlNumber: string | null;
  /** Number of revoked entries listed. */
  entries: number;
}

/** Parses the header of a DER CRL. Throws DerError when the bytes are not a CRL. */
export function parseCrlHeader(b: Uint8Array): CrlHeader {
  const outer = readTlv(b, 0);
  if (outer.tag !== 0x30 || outer.end !== b.length) throw new DerError("not a DER SEQUENCE spanning the input");
  const [tbs] = children(b, outer);
  if (!tbs || tbs.tag !== 0x30) throw new DerError("missing TBSCertList");
  const f = children(b, tbs);
  let i = 0;
  if (f[i]?.tag === 0x02) i++; // version
  if (f[i]?.tag !== 0x30) throw new DerError("missing signature algorithm");
  i++;
  const issuer = f[i++];
  if (!issuer || issuer.tag !== 0x30) throw new DerError("missing issuer");
  const thisT = f[i++];
  if (!thisT || !isTime(thisT)) throw new DerError("missing thisUpdate");
  let nextUpdate: string | null = null;
  if (f[i] && isTime(f[i]!)) nextUpdate = readTime(b, f[i++]!);
  let entries = 0;
  if (f[i]?.tag === 0x30) entries = children(b, f[i++]!).length;
  let crlNumber: string | null = null;
  const extWrap = f[i];
  if (extWrap?.tag === 0xa0) {
    const [exts] = children(b, extWrap);
    for (const ext of exts ? children(b, exts) : []) {
      const parts = children(b, ext);
      const oid = parts[0];
      if (!oid || oid.tag !== 0x06) continue;
      const oidBytes = b.subarray(oid.start, oid.end);
      if (oidBytes.length !== OID_CRL_NUMBER.length || !oidBytes.every((x, k) => x === OID_CRL_NUMBER[k])) continue;
      const octets = parts[parts.length - 1]!;
      const int = readTlv(b, octets.start, octets.end);
      if (int.tag === 0x02) crlNumber = BigInt("0x" + (hex(b.subarray(int.start, int.end)) || "0")).toString();
    }
  }
  return { issuerDerHex: hex(b.subarray(issuer.pos, issuer.end)), thisUpdate: readTime(b, thisT), nextUpdate, crlNumber, entries };
}

/** The revokedCertificates SEQUENCE of a CRL, or null when the CRL lists nothing. */
function revokedList(b: Uint8Array): Tlv | null {
  const outer = readTlv(b, 0);
  const [tbs] = children(b, outer);
  if (!tbs) throw new DerError("missing TBSCertList");
  const f = children(b, tbs);
  let i = f[0]?.tag === 0x02 ? 1 : 0;
  i += 2; // signature algorithm, issuer
  i++; // thisUpdate
  if (f[i] && isTime(f[i]!)) i++; // nextUpdate
  return f[i]?.tag === 0x30 ? f[i]! : null;
}

export interface CrlEntry {
  /** Serial number, lowercase hex as encoded (leading zero bytes kept). */
  serialHex: string;
  revocationDate: string;
  /** Whether the entry carries a reasonCode extension (2.5.29.21). */
  hasReason: boolean;
}

/** 2.5.29.21 reasonCode, as the DER of its OBJECT IDENTIFIER. */
const OID_REASON_TLV = Uint8Array.of(0x06, 0x03, 0x55, 0x1d, 0x15);

function contains(b: Uint8Array, from: number, to: number, needle: Uint8Array): boolean {
  outer: for (let p = from; p + needle.length <= to; p++) {
    for (let k = 0; k < needle.length; k++) if (b[p + k] !== needle[k]) continue outer;
    return true;
  }
  return false;
}

/** Calls `fn` for every revoked entry of a DER CRL (call parseCrlHeader first to validate it). */
export function forEachEntry(b: Uint8Array, fn: (e: CrlEntry) => void): void {
  const list = revokedList(b);
  if (!list) return;
  for (let p = list.start; p < list.end; ) {
    const entry = readTlv(b, p, list.end);
    p = entry.end;
    const serial = readTlv(b, entry.start, entry.end);
    if (serial.tag !== 0x02) throw new DerError(`entry at ${entry.pos} has no serial number`);
    const date = readTlv(b, serial.end, entry.end);
    if (!isTime(date)) throw new DerError(`entry at ${entry.pos} has no revocation date`);
    fn({ serialHex: hex(b.subarray(serial.start, serial.end)), revocationDate: readTime(b, date), hasReason: date.end < entry.end && contains(b, date.end, entry.end, OID_REASON_TLV) });
  }
}

