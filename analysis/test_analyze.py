"""Tests for analyze.py with CRLs generated on the fly (no network). Run: python3 -I -m unittest discover analysis"""
import csv
import os
import sys
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import analyze  # noqa: E402

KEY = ec.generate_private_key(ec.SECP256R1())
ISSUER = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "AC Teste")])
T0 = datetime(2026, 11, 5, 0, 0, tzinfo=timezone.utc)


def crl(this_update, revoked):
    b = x509.CertificateRevocationListBuilder().issuer_name(ISSUER).last_update(this_update).next_update(this_update + timedelta(hours=6))
    for serial, when in revoked:
        b = b.add_revoked_certificate(x509.RevokedCertificateBuilder().serial_number(serial).revocation_date(when).build())
    return b.sign(KEY, hashes.SHA256()).public_bytes(serialization.Encoding.DER)


class AnalyzeTest(unittest.TestCase):
    def test_monthly_counts_and_publication_delay(self):
        with tempfile.TemporaryDirectory() as d:
            src = os.path.join(d, "lcr", "uf-teste")
            os.makedirs(src)
            old = [(1, datetime(2026, 9, 10, tzinfo=timezone.utc)), (2, datetime(2026, 10, 1, tzinfo=timezone.utc))]
            # Snapshot 1 at T0: two old revocations (no measurable delay).
            open(os.path.join(src, "a.crl"), "wb").write(crl(T0, old))
            # Snapshot 2 at T0+6h: serial 3 revoked at T0+1h appears (delay 5 h).
            s3 = (3, T0 + timedelta(hours=1))
            open(os.path.join(src, "b.crl"), "wb").write(crl(T0 + timedelta(hours=6), old + [s3]))
            # Snapshot 3 at T0+12h: serial 4 revoked at T0+2h shows up late (delay 10 h); serial 3 not counted again.
            s4 = (4, T0 + timedelta(hours=2))
            open(os.path.join(src, "c.crl"), "wb").write(crl(T0 + timedelta(hours=12), old + [s3, s4]))
            out = os.path.join(d, "out")
            analyze.analyze(os.path.join(d, "lcr"), out)

            rows = lambda n: list(csv.DictReader(open(os.path.join(out, n), encoding="utf-8")))
            monthly = {(r["month"]): int(r["revocations"]) for r in rows("monthly_revocations.csv")}
            self.assertEqual(monthly, {"2026-09": 1, "2026-10": 1, "2026-11": 2})
            first = {r["serial"]: float(r["delay_hours"]) for r in rows("first_seen.csv")}
            self.assertEqual(first, {"3": 5.0, "4": 10.0})
            s = rows("summary.csv")[0]
            self.assertEqual((s["snapshots"], s["entries_last"], s["measured_delays"], s["delay_max_h"], s["with_reason"]), ("3", "4", "2", "10.0", "0"))


if __name__ == "__main__":
    unittest.main()
