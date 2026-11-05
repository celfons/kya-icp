"""
Offline analysis of the CRLs collected by kya-icp.

Input: a local copy of the R2 bucket (the lcr/ folder), e.g. synced with rclone (see README).
Output (CSV, in --out):

  monthly_revocations.csv   source, month, revocations
      From the latest snapshot of each source: revocations per month of revocationDate. A CRL drops expired
      certificates, so older months are a lower bound; recent months are close to complete.

  first_seen.csv            source, serial, revocation_date, first_this_update, delay_hours
      For each serial that appears AFTER the first snapshot of its source (so it was revoked during the
      collection): the thisUpdate of the first CRL that lists it. delay_hours = first_this_update - revocation_date,
      the publication delay. Serials already in the first snapshot have no measurable delay and are left out.

  summary.csv               source, snapshots, first_this_update, last_this_update, entries_last,
                            measured_delays, delay_median_h, delay_p95_h, delay_max_h, with_reason

Requires: Python 3.10+, cryptography (pip install cryptography).
Usage: python3 -I analysis/analyze.py --lcr data/lcr --out data/out
"""
from __future__ import annotations

import argparse
import csv
import os
import statistics
import sys
from collections import Counter, defaultdict
from datetime import timezone

from cryptography import x509


def load(path: str) -> x509.CertificateRevocationList:
    with open(path, "rb") as f:
        return x509.load_der_x509_crl(f.read())


def utc(dt):
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


def this_update(crl) -> object:
    return utc(getattr(crl, "last_update_utc", None) or crl.last_update)


def revocation_date(entry) -> object:
    return utc(getattr(entry, "revocation_date_utc", None) or entry.revocation_date)


def has_reason(entry) -> bool:
    try:
        entry.extensions.get_extension_for_class(x509.CRLReason)
        return True
    except x509.ExtensionNotFound:
        return False


def percentile(values: list[float], p: float) -> float:
    s = sorted(values)
    k = (len(s) - 1) * p
    lo = int(k)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)


def analyze(lcr_dir: str, out_dir: str) -> None:
    os.makedirs(out_dir, exist_ok=True)
    monthly_rows, first_rows, summary_rows = [], [], []
    for source in sorted(os.listdir(lcr_dir)):
        sdir = os.path.join(lcr_dir, source)
        if not os.path.isdir(sdir):
            continue
        snaps = []
        for name in os.listdir(sdir):
            if name.endswith(".crl"):
                try:
                    crl = load(os.path.join(sdir, name))
                except ValueError as e:
                    print(f"skip {source}/{name}: {e}", file=sys.stderr)
                    continue
                snaps.append((this_update(crl), crl))
        if not snaps:
            continue
        snaps.sort(key=lambda s: s[0])

        latest = snaps[-1][1]
        months = Counter(revocation_date(e).strftime("%Y-%m") for e in latest)
        monthly_rows += [{"source": source, "month": m, "revocations": n} for m, n in sorted(months.items())]

        seen = {e.serial_number for e in snaps[0][1]}
        delays = []
        for tu, crl in snaps[1:]:
            for e in crl:
                if e.serial_number in seen:
                    continue
                seen.add(e.serial_number)
                rd = revocation_date(e)
                h = (tu - rd).total_seconds() / 3600
                delays.append(h)
                first_rows.append({"source": source, "serial": format(e.serial_number, "x"), "revocation_date": rd.isoformat(), "first_this_update": tu.isoformat(), "delay_hours": round(h, 3)})

        summary_rows.append({
            "source": source,
            "snapshots": len(snaps),
            "first_this_update": snaps[0][0].isoformat(),
            "last_this_update": snaps[-1][0].isoformat(),
            "entries_last": len(latest),
            "measured_delays": len(delays),
            "delay_median_h": round(statistics.median(delays), 3) if delays else "",
            "delay_p95_h": round(percentile(delays, 0.95), 3) if delays else "",
            "delay_max_h": round(max(delays), 3) if delays else "",
            "with_reason": sum(1 for e in latest if has_reason(e)),
        })

    for name, rows, fields in [
        ("monthly_revocations.csv", monthly_rows, ["source", "month", "revocations"]),
        ("first_seen.csv", first_rows, ["source", "serial", "revocation_date", "first_this_update", "delay_hours"]),
        ("summary.csv", summary_rows, ["source", "snapshots", "first_this_update", "last_this_update", "entries_last", "measured_delays", "delay_median_h", "delay_p95_h", "delay_max_h", "with_reason"]),
    ]:
        with open(os.path.join(out_dir, name), "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=fields)
            w.writeheader()
            w.writerows(rows)
        print(f"{name}: {len(rows)} rows")


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--lcr", required=True, help="folder with one subfolder per source (the lcr/ prefix of the bucket)")
    ap.add_argument("--out", required=True, help="folder for the CSV files")
    a = ap.parse_args(argv)
    analyze(a.lcr, a.out)


if __name__ == "__main__":
    main()
