"""Download one file from the Receita Federal Nextcloud public share using
parallel HTTP range requests (the server gives ~0.6 MB/s per connection)."""
import subprocess, sys, os, re, concurrent.futures as cf

SHARE = "gn672Ad4CF8N6TK"  # public share token of arquivos.receitafederal.gov.br
BASE = "https://arquivos.receitafederal.gov.br/public.php/webdav/Dados/Cadastros/CNPJ"

def size(path):
    out = subprocess.run(["curl", "-sSI", "-u", SHARE + ":", f"{BASE}/{path}"],
                         capture_output=True, text=True, check=True).stdout
    return int(re.search(r"(?i)content-length:\s*(\d+)", out).group(1))

def fetch(path, dest, nconn=16):
    n = size(path)
    step = -(-n // nconn)
    parts = [(i, i * step, min(n, (i + 1) * step) - 1) for i in range(nconn) if i * step < n]
    def get(p):
        i, a, b = p
        for _ in range(5):
            r = subprocess.run(["curl", "-sS", "--retry", "5", "-u", SHARE + ":", "-r", f"{a}-{b}",
                                f"{BASE}/{path}", "-o", f"{dest}.part{i}"])
            if r.returncode == 0 and os.path.getsize(f"{dest}.part{i}") == b - a + 1:
                return
        raise RuntimeError(f"failed {path} part {i}")
    with cf.ThreadPoolExecutor(nconn) as ex:
        list(ex.map(get, parts))
    with open(dest, "wb") as o:
        for i, _, _ in parts:
            with open(f"{dest}.part{i}", "rb") as f:
                while (c := f.read(1 << 24)):
                    o.write(c)
            os.remove(f"{dest}.part{i}")
    assert os.path.getsize(dest) == n
    return dest

if __name__ == "__main__":
    fetch(sys.argv[1], sys.argv[2])
