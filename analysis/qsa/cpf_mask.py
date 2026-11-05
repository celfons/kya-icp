"""How many valid CPFs match a masked CPF ***DDDDDD** (Receita's open-data mask)?
Hidden: digits 1-3 and the two check digits (10-11). Visible: digits 4-9."""
import random, json, sys
def dv(d9):
    s = sum(int(c) * w for c, w in zip(d9, range(10, 1, -1))); a = (s * 10) % 11 % 10
    s = sum(int(c) * w for c, w in zip(d9 + str(a), range(11, 1, -1))); b = (s * 10) % 11 % 10
    return f"{a}{b}"
def valid(c): return len(set(c)) > 1 and dv(c[:9]) == c[9:]
rng = random.Random(20261105)
counts = []
for _ in range(2000):
    mid = f"{rng.randrange(10**6):06d}"
    n = sum(valid(f"{p:03d}{mid}{d}") for p in range(1000) for d in [dv(f"{p:03d}{mid}")])
    counts.append(n)
# brute force: every 11-digit string matching mask -> 1000*100 candidates, of which valid:
mid = "123456"; brute = sum(valid(f"{p:03d}{mid}{x:02d}") for p in range(1000) for x in range(100))
res = {"mascaras_amostradas": len(counts), "min": min(counts), "max": max(counts),
       "media": sum(counts) / len(counts), "brute_force_mascara_exemplo_candidatos": 100000,
       "brute_force_validos": brute,
       "nota": "digitos 1-3 livres (1000 combinacoes); DV determinados -> 1000 CPFs validos por mascara (menos 1 se houver repetidos, ex. 111111111-11); o 9o digito visivel e a regiao fiscal"}
json.dump(res, open(sys.argv[1], "w"), indent=1, ensure_ascii=False); print(res)
