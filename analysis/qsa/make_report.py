"""Builds results.json (raw aggregates + cpf_mask + file dates) and RESULTS.md skeleton tables."""
import json, os
D = os.path.dirname(os.path.abspath(__file__))
R = json.load(open(os.path.join(D, "results_raw.json")))
R["cpf_mascara"] = json.load(open(os.path.join(D, "cpf_mask.json")))
R["publicacao"] = {"2026-10": "Last-Modified 2026-10-13 22:00-22:09 GMT (WebDAV); nome interno D61010 = 2026-10-10",
                   "2026-09": "Last-Modified 2026-09-14 14:59-15:08 GMT (WebDAV)",
                   "consulta": "2026-11-05; pasta 2026-11 ainda inexistente"}
json.dump(R, open(os.path.join(D, "results.json"), "w"), indent=1, ensure_ascii=False)
rows = ["| Grupo | Empresas ativas (matriz) | ≥1 sócio | ≥1 PF | PF adm/dir/pres/sócio-adm (05,10,16,49) | PF qualif. ampla |", "|---|---:|---:|---:|---:|---:|"]
for g, v in R["cobertura"].items():
    if g.startswith("_"): continue
    f = lambda k: f'{v[k]["pct"]}% ({v[k]["n"]:,})'
    rows.append(f'| {g} | {v["empresas"]:,} | {f("com_qualquer_socio")} | {f("com_socio_PF")} | {f("com_PF_qual_admin_dir_pres_socioadm")} | {f("com_PF_qual_representacao_ampla")} |')
open(os.path.join(D, "coverage_table.md"), "w").write("\n".join(rows) + "\n")
print("\n".join(rows))
