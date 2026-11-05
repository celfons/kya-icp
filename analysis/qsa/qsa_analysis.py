"""Aggregate-only analysis of the Receita Federal open CNPJ data (QSA / Socios).
Usage: python3 -I qsa_analysis.py WORKDIR LATEST PREV   (e.g. 2026-10 2026-09)
Never stores or prints names or CPFs: personal fields are only hashed in memory
with a random per-run salt, and only counts are written to results.json."""
import sys, os, io, csv, json, zipfile, time, hashlib, secrets, collections, re
import numpy as np
from array import array
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fetch import fetch

WORK, LATEST, PREV = sys.argv[1], sys.argv[2], sys.argv[3]
OUT = os.path.dirname(os.path.abspath(__file__))
SALT = secrets.token_bytes(16)
IDX = [int(x) for x in os.environ.get("QSA_IDX", "0123456789")]
N = 100_000_000  # CNPJ base numbers are 8 digits
t0 = time.time()
def log(*a): print(f"[{time.time()-t0:7.0f}s]", *a, flush=True)
def h64(s): return int.from_bytes(hashlib.blake2b(s.encode("latin1", "replace"), digest_size=8, key=SALT).digest(), "little")

def rows(month, name):
    path = os.path.join(WORK, name)
    fetch(f"{month}/{name}", path)
    with zipfile.ZipFile(path) as z:
        for member in z.namelist():
            meta["inner_files"][f"{month}/{name}"] = member
            with z.open(member) as f:
                yield from csv.reader(io.TextIOWrapper(f, encoding="latin1", newline=""), delimiter=";")
    os.remove(path)

meta = {"inner_files": {}}
R = {}

# ---------- Estabelecimentos (latest): active headquarters ----------
active = np.zeros(N, np.uint8)       # 1 = matriz with situacao 02 (ATIVA)
sit_counter = collections.Counter(); max_dt_sit = "0"
for i in IDX:
    for r in rows(LATEST, f"Estabelecimentos{i}.zip"):
        if r[3] != "1": continue
        sit_counter[r[5]] += 1
        if r[5] == "02": active[int(r[0])] = 1
        if r[6] > max_dt_sit and r[6] <= "20991231": max_dt_sit = r[6]
    log("estab", i)
R["estabelecimentos_matriz_por_situacao"] = dict(sit_counter)
R["max_data_situacao_cadastral"] = max_dt_sit
R["n_empresas_ativas_matriz"] = int(active.sum())

# ---------- Empresas (latest): natureza juridica ----------
nat = np.zeros(N, np.uint16)
for i in IDX:
    for r in rows(LATEST, f"Empresas{i}.zip"):
        b = int(r[0])
        if active[b]: nat[b] = int(r[2] or 0)
    log("empresas", i)

# ---------- Simples (latest): MEI flag ----------
mei = np.zeros(N, np.uint8)
for r in rows(LATEST, "Simples.zip"):
    if r[4] == "S": mei[int(r[0])] = 1
log("simples")

def group(b):
    n = nat[b]
    if n == 2062: return "LTDA (2062)"
    if n in (2046, 2054): return "SA (2046/2054)"
    if n == 2135: return "MEI (2135 + opcao MEI)" if mei[b] else "EI nao-MEI (2135)"
    if n in (2305, 2313): return "EIRELI (2305/2313)"
    if n == 2240: return "Soc. Simples Ltda (2240)"
    if n in (2143, 2330) : return "Cooperativa"
    if n == 3999: return "Associacao privada (3999)"
    return "outras"

REP_CORE = {"05", "10", "16", "49"}  # administrador, diretor, presidente, socio-administrador
REP_EXT = REP_CORE | {"28", "50", "65", "66", "67", "68", "70", "72", "73", "74", "11", "12", "13", "19", "43", "64", "34"}

# ---------- Socios (both months) ----------
def socios(month, detail):
    sethash = np.zeros(N, np.uint64); cnt = np.zeros(N, np.uint16)
    flags = np.zeros(N, np.uint8) if detail else None  # 1 any, 2 PF, 4 PF rep_core, 8 any rep_ext, 16 PF rep_ext
    rowkeys, rowbase, rowym = array('Q'), array('l'), array('l')
    st = collections.Counter(); fmt = collections.Counter(); qual = collections.Counter(); faixa = collections.Counter()
    pf_name, pf_name_mask, base_mask, base_mask_name = array('Q'), array('Q'), array('Q'), array('Q')
    for i in IDX:
        for r in rows(month, f"Socios{i}.zip"):
            b = int(r[0]); ident = r[1]; doc = r[3]; q = r[4]; de = r[5]
            k = h64("|".join(r[:5]))  # base, ident, name, doc, qual
            rowkeys.append(k)
            sethash[b] ^= np.uint64(k); cnt[b] += 1
            if not detail: continue
            rowbase.append(b); rowym.append(int(de[:6]) if de[:6].isdigit() else 0)
            st["linhas"] += 1; st[f"ident_{ident}"] += 1
            fmt[(ident, re.sub(r"\d", "9", doc))] += 1
            fmt[("rep", re.sub(r"\d", "9", r[7]))] += 1
            if r[7] and r[7] != "***000000**": st["rep_legal_cpf_preenchido"] += 1; st[f"rep_legal_qual_{r[9]}"] += 1
            if r[8].strip(): st["rep_legal_nome_preenchido"] += 1
            if r[9] and r[9] != "00": st["rep_legal_qual_nao00"] += 1
            if q in ("29", "30", "67", "68"): st["socio_incapaz_ou_menor"] += 1; st["socio_incapaz_ou_menor_com_rep"] += (r[7] not in ("", "***000000**"))
            if ident == "3": st["estrangeiro"] += 1; st["estrangeiro_com_rep"] += (r[7] not in ("", "***000000**"))
            qual[(ident, q)] += 1; faixa[r[10]] += 1
            f = 1
            if ident == "2":
                f |= 2
                if q in REP_CORE: f |= 4
                if q in REP_EXT: f |= 16
                pf_name.append(h64(r[2])); pf_name_mask.append(h64(r[2] + "|" + doc))
                base_mask.append(h64(r[0] + "|" + doc)); base_mask_name.append(h64(r[0] + "|" + doc + "|" + r[2]))
            if q in REP_EXT: f |= 8
            flags[b] |= f
        log("socios", month, i)
    out = {"sethash": sethash, "cnt": cnt, "rowkeys": np.unique(np.frombuffer(rowkeys, np.uint64))}
    if detail:
        out.update(flags=flags, rk=np.frombuffer(rowkeys, np.uint64), rowbase=np.frombuffer(rowbase, np.int64),
                   rowym=np.frombuffer(rowym, np.int64), st=st, fmt=fmt, qual=qual, faixa=faixa,
                   pf=dict(name=np.frombuffer(pf_name, np.uint64), name_mask=np.frombuffer(pf_name_mask, np.uint64),
                           base_mask=np.frombuffer(base_mask, np.uint64), base_mask_name=np.frombuffer(base_mask_name, np.uint64)))
    return out

P = socios(PREV, False) if PREV != "-" else None; log("prev done")
import gc; gc.collect()
L = socios(LATEST, True); log("latest done")

def pct(a, b): return {"n": int(a), "den": int(b), "pct": round(100 * a / b, 2) if b else None}

# masking format
R["formato_campo_cpf_cnpj_socio"] = {f"{k[0]}:{k[1]}": v for k, v in L["fmt"].most_common(20)}
R["socios_linhas_stats"] = dict(L["st"])
R["qualificacoes_latest"] = {f"ident{k[0]}_q{k[1]}": v for k, v in L["qual"].most_common()}
R["faixa_etaria"] = dict(L["faixa"])

# name+mask uniqueness (PF rows)
pf = L["pf"]
un = len(np.unique(pf["name"])); unm = len(np.unique(pf["name_mask"]))
R["pf_unicidade"] = {
    "linhas_pf": int(len(pf["name"])), "nomes_distintos": un, "pares_nome_mascara_distintos": unm,
    "nomes_com_mais_de_uma_mascara_aprox": None,
    "pares_empresa_mascara_distintos": int(len(np.unique(pf["base_mask"]))),
    "pares_empresa_mascara_nome_distintos": int(len(np.unique(pf["base_mask_name"]))),
}
# names with >1 distinct mask: unique (name,mask) pairs -> count per name
nm = np.unique(np.stack([pf["name"], pf["name_mask"]], 1), axis=0)
_, c = np.unique(nm[:, 0], return_counts=True)
R["pf_unicidade"]["nomes_com_mais_de_uma_mascara_aprox"] = int((c > 1).sum())
# masks (globally) shared by several distinct names
mm = np.unique(np.stack([pf["base_mask"], pf["base_mask_name"]], 1), axis=0)
_, c2 = np.unique(mm[:, 0], return_counts=True)
R["pf_unicidade"]["empresa_mascara_com_mais_de_um_nome"] = int((c2 > 1).sum())
del pf, nm, mm

# coverage over active companies
act = np.nonzero(active)[0]
fl = L["flags"][act]
cov = {"_denominador_empresas_ativas_matriz": int(len(act))}
def cover(mask_sel, label):
    f = fl[mask_sel]; d = len(f)
    cov[label] = {"empresas": d, "com_qualquer_socio": pct((f & 1 > 0).sum(), d),
                  "com_socio_PF": pct((f & 2 > 0).sum(), d),
                  "com_PF_qual_admin_dir_pres_socioadm": pct((f & 4 > 0).sum(), d),
                  "com_PF_qual_representacao_ampla": pct((f & 16 > 0).sum(), d),
                  "com_qualquer_qual_representacao_ampla": pct((f & 8 > 0).sum(), d)}
cover(np.ones(len(act), bool), "TODAS")
groups = np.array([group(b) for b in act]) if len(act) < 80_000_000 else None
for g in sorted(set(groups)):
    cover(groups == g, g)
R["cobertura"] = cov

ym = L["rowym"]
if P is not None:
    lat_has = L["cnt"] > 0; prev_has = P["cnt"] > 0
    both = np.nonzero(lat_has & prev_has)[0]
    changed = (L["sethash"][both] != P["sethash"][both]) | (L["cnt"][both] != P["cnt"][both])
    R["mudanca"] = {"empresas_com_socios_em_ambos": pct(changed.sum(), len(both))}
# freshness from data_entrada_sociedade (single month)
ref = int(LATEST.replace("-", ""))  # reference YYYYMM
def back(m, k):
    y, mo = divmod(m, 100); t = y * 12 + mo - 1 - k; return (t // 12) * 100 + t % 12 + 1
okd = (ym > 190000) & (ym <= ref)
R["frescor_entrada"] = {"linhas_com_data_valida": pct(okd.sum(), len(ym)),
    "linhas_data_futura_ou_invalida": int((~okd).sum())}
for k in (1, 3, 6, 12):
    R["frescor_entrada"][f"entrada_ultimos_{k}_meses"] = pct((okd & (ym > back(ref, k))).sum(), okd.sum())
R["frescor_entrada"]["entrada_no_mes_ref"] = pct((ym == ref).sum(), okd.sum())
hist = collections.Counter(ym[(ym >= back(ref, 13)) & (ym <= 209912)].tolist())
R["frescor_entrada"]["linhas_por_mes_entrada"] = {str(k): v for k, v in sorted(hist.items())}
# companies (active) with any partner entering in last 3 months
rb = L["rowbase"]; recent = np.zeros(N, np.uint8); recent[rb[okd & (ym > back(ref, 3))]] = 1
R["frescor_entrada"]["empresas_ativas_com_entrada_ultimos_3m"] = pct(int(recent[act].sum()), len(act))
R["max_data_entrada_sociedade_latest"] = int(ym[ym <= 209912].max())
R["max_data_entrada_raw_ate_2099"] = R["max_data_entrada_sociedade_latest"]

meta["seconds"] = round(time.time() - t0)
R["_meta"] = meta; R["_meses"] = {"latest": LATEST, "prev": PREV}
R["_qualificacoes_contadas"] = {"REP_CORE": sorted(REP_CORE), "REP_EXT": sorted(REP_EXT)}
with open(os.path.join(OUT, "results_raw.json"), "w") as f: json.dump(R, f, indent=1, ensure_ascii=False, default=int)
log("done")
