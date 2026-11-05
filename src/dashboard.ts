/** The dashboard page: static HTML that reads the JSON API. No external scripts; charts are plain SVG. */
export const DASHBOARD_HTML = /* html */ `<!doctype html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Revogações ICP-Brasil</title>
<meta name="description" content="Coleta horária das listas de certificados revogados (LCR) da ICP-Brasil: revogações por mês e atraso de publicação por autoridade certificadora.">
<style>
  :root { --bg:#fbfbfa; --fg:#1d1f21; --muted:#5f6368; --line:#e3e3e0; --card:#ffffff; --accent:#1f6feb; --accent2:#9a6700; --bad:#cf222e; }
  @media (prefers-color-scheme: dark) { :root { --bg:#111315; --fg:#e8e8e6; --muted:#a0a4a8; --line:#2b2f33; --card:#181b1e; --accent:#58a6ff; --accent2:#d4a72c; --bad:#ff7b72; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg); font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif; }
  main { max-width: 1100px; margin: 0 auto; padding: 24px 16px 48px; }
  h1 { font-size: 1.5rem; margin: 0 0 4px; }
  h2 { font-size: 1.1rem; margin: 28px 0 8px; }
  p { margin: 6px 0; }
  .muted { color: var(--muted); }
  .cards { display:grid; grid-template-columns: repeat(auto-fit, minmax(170px,1fr)); gap:12px; margin-top:16px; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:10px; padding:12px 14px; }
  .card b { display:block; font-size:1.4rem; font-variant-numeric: tabular-nums; }
  .toolbar { display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin:8px 0; }
  select { font:inherit; padding:4px 8px; border-radius:6px; border:1px solid var(--line); background:var(--card); color:var(--fg); }
  .scroll { overflow-x:auto; border:1px solid var(--line); border-radius:10px; background:var(--card); }
  table { border-collapse: collapse; width:100%; font-variant-numeric: tabular-nums; }
  th, td { padding:7px 10px; border-bottom:1px solid var(--line); text-align:right; white-space:nowrap; }
  th:first-child, td:first-child { text-align:left; white-space:normal; min-width: 220px; }
  th { font-weight:600; font-size:.85rem; color:var(--muted); position:sticky; top:0; background:var(--card); }
  tbody tr { cursor:pointer; }
  tbody tr:hover, tbody tr[aria-selected="true"] { background: color-mix(in srgb, var(--accent) 10%, transparent); }
  .tag { font-size:.75rem; border:1px solid var(--line); border-radius:999px; padding:0 7px; color:var(--muted); margin-left:6px; }
  svg { width:100%; height:auto; display:block; }
  svg text { fill: var(--muted); font-size: 11px; }
  .bar { fill: var(--accent); } .bar2 { fill: var(--accent2); }
  .axis { stroke: var(--line); }
  .grid2 { display:grid; grid-template-columns: 1fr 1fr; gap:16px; } @media (max-width: 760px) { .grid2 { grid-template-columns: 1fr; } }
  ul.files { list-style:none; padding:0; margin:0; max-height:260px; overflow:auto; border:1px solid var(--line); border-radius:10px; background:var(--card); }
  ul.files li { padding:6px 10px; border-bottom:1px solid var(--line); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size:.8rem; display:flex; justify-content:space-between; gap:8px; }
  a { color: var(--accent); }
  .note { border-left:3px solid var(--accent2); padding:6px 12px; background:var(--card); border-radius:0 8px 8px 0; }
  .err { color: var(--bad); }
</style>
</head>
<body>
<main>
  <h1>Revogações de certificados ICP-Brasil</h1>
  <p class="muted">Coleta horária das listas de certificados revogados (LCR) publicadas pelas autoridades certificadoras. Base empírica da política de atualidade do status do <a href="https://github.com/celfons/kya-brasil">KYA Brasil</a>.</p>
  <p class="muted" id="status">Carregando…</p>

  <div class="cards" id="cards"></div>

  <h2>Fontes</h2>
  <div class="toolbar">
    <label>Tipo <select id="kind"><option value="usuario-final">Usuário final</option><option value="ac">Certificados de AC</option><option value="">Todas</option></select></label>
    <span class="muted">Clique numa linha para ver a série e o atraso.</span>
  </div>
  <div class="scroll"><table>
    <thead><tr><th>Fonte</th><th>Versões</th><th>Última LCR (UTC)</th><th>Entradas</th><th>Com motivo</th><th>Atrasos medidos</th><th>Mediana (h)</th><th>p95 (h)</th><th>Máx. (h)</th></tr></thead>
    <tbody id="rows"><tr><td colspan="9" class="muted">Sem dados ainda.</td></tr></tbody>
  </table></div>

  <section id="detail" hidden>
    <h2 id="dtitle"></h2>
    <p class="muted" id="dsub"></p>
    <div class="grid2">
      <div><p><b>Revogações por mês</b> <span class="muted">(últimos 36 meses da LCR mais recente)</span></p><div id="monthly"></div></div>
      <div><p><b>Atraso de publicação</b> <span class="muted">(da revogação à primeira LCR coletada que a lista)</span></p><div id="delays"></div></div>
    </div>
    <h2>Arquivos brutos</h2>
    <ul class="files" id="files"></ul>
  </section>

  <h2>Como ler</h2>
  <p class="note">Meses antigos são um piso: as autoridades retiram da LCR os certificados que expiram. O atraso só é medido para revogações que surgem depois do início da coleta. O motivo da revogação depende da autoridade: em 5 nov. 2026, as LCR do SERPRO e da Soluti v5 não o informavam em nenhuma entrada, e as da Certisign e da Serasa em quase todas. Dados públicos; código e metodologia em <a href="https://github.com/celfons/kya-icp">github.com/celfons/kya-icp</a>.</p>
</main>
<script>
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
  const fmt = (n) => n === null || n === undefined || n === "" ? "–" : Number(n).toLocaleString("pt-BR");
  const fmtH = (n) => n === null || n === undefined ? "–" : Number(n).toLocaleString("pt-BR", { maximumFractionDigits: 1 });
  const when = (iso) => iso ? iso.replace("T", " ").replace(/:\\d\\dZ$|Z$/, "") : "–";
  let summary = [];
  let selected = null;

  function bars(values, labels, cls, unit) {
    const W = 520, H = 200, pad = 28, n = values.length;
    if (!n) return '<p class="muted">Sem dados.</p>';
    const max = Math.max(1, ...values), bw = (W - pad) / n;
    let s = '<svg viewBox="0 0 ' + W + ' ' + (H + 34) + '" role="img">';
    s += '<line class="axis" x1="' + pad + '" y1="' + H + '" x2="' + W + '" y2="' + H + '"/>';
    s += '<text x="0" y="12">' + fmt(max) + '</text><text x="0" y="' + H + '">0</text>';
    values.forEach((v, i) => {
      const h = (v / max) * (H - 10), x = pad + i * bw;
      s += '<rect class="' + cls + '" x="' + (x + 1).toFixed(1) + '" y="' + (H - h).toFixed(1) + '" width="' + Math.max(1, bw - 2).toFixed(1) + '" height="' + h.toFixed(1) + '"><title>' + esc(labels[i]) + ': ' + fmt(v) + (unit || '') + '</title></rect>';
      const every = Math.ceil(n / 9);
      if (i % every === 0) s += '<text x="' + (x + bw / 2).toFixed(1) + '" y="' + (H + 14) + '" text-anchor="middle">' + esc(labels[i]) + '</text>';
    });
    return s + '</svg>';
  }

  function render() {
    const kind = $("kind").value;
    const list = summary.filter((s) => !kind || s.kind === kind).sort((a, b) => b.entries - a.entries);
    $("rows").innerHTML = list.length ? list.map((s) =>
      '<tr data-id="' + esc(s.source) + '" aria-selected="' + (s.source === selected) + '"><td>' + esc(s.ac) + '<span class="tag">' + esc(s.source) + '</span></td><td>' + fmt(s.versions) + '</td><td>' + when(s.last_this_update) + '</td><td>' + fmt(s.entries) + '</td><td>' + fmt(s.entries_with_reason) + '</td><td>' + fmt(s.measured_delays) + '</td><td>' + fmtH(s.delay_median_h) + '</td><td>' + fmtH(s.delay_p95_h) + '</td><td>' + fmtH(s.delay_max_h) + '</td></tr>'
    ).join("") : '<tr><td colspan="9" class="muted">Sem dados ainda: a primeira coleta acontece no minuto 23 de cada hora.</td></tr>';
    const uf = summary.filter((s) => s.kind === "usuario-final");
    const total = uf.reduce((a, s) => a + s.entries, 0), delays = uf.reduce((a, s) => a + s.measured_delays, 0), reasons = uf.reduce((a, s) => a + s.entries_with_reason, 0);
    $("cards").innerHTML =
      '<div class="card"><span class="muted">Revogações listadas (usuário final)</span><b>' + fmt(total) + '</b></div>' +
      '<div class="card"><span class="muted">Fontes com dados</span><b>' + fmt(summary.length) + '</b></div>' +
      '<div class="card"><span class="muted">Atrasos medidos</span><b>' + fmt(delays) + '</b></div>' +
      '<div class="card"><span class="muted">Entradas com motivo</span><b>' + fmt(reasons) + '</b></div>';
  }

  async function detail(id) {
    selected = id; render();
    const [agg, files] = await Promise.all([fetch("/api/source/" + encodeURIComponent(id)).then((r) => r.json()), fetch("/api/files/" + encodeURIComponent(id)).then((r) => r.json())]);
    $("detail").hidden = false;
    $("dtitle").textContent = agg.ac;
    $("dsub").textContent = agg.url + " · " + agg.versions + " versões desde " + when(agg.first_this_update);
    const months = Object.keys(agg.monthly).slice(-36);
    $("monthly").innerHTML = bars(months.map((m) => agg.monthly[m]), months, "bar");
    const bins = [[0,1,"<1h"],[1,2,"1–2h"],[2,4,"2–4h"],[4,6,"4–6h"],[6,12,"6–12h"],[12,24,"12–24h"],[24,72,"1–3d"],[72,Infinity,">3d"]];
    const counts = bins.map(([a, b]) => agg.delays_h.filter((d) => d >= a && d < b).length);
    $("delays").innerHTML = agg.delays_h.length ? bars(counts, bins.map((b) => b[2]), "bar2", " revogações") : '<p class="muted">Ainda não há revogações novas desde o início da coleta desta fonte.</p>';
    $("files").innerHTML = files.files.slice().reverse().map((f) => '<li><a href="/files/' + esc(f.key) + '">' + esc(f.key.split("/").pop()) + '</a><span class="muted">' + fmt(Math.round(f.size / 1024)) + ' kB</span></li>').join("") || '<li class="muted">Nenhum arquivo.</li>';
    $("detail").scrollIntoView({ behavior: "smooth", block: "start" });
  }

  $("rows").addEventListener("click", (e) => { const tr = e.target.closest("tr[data-id]"); if (tr) detail(tr.dataset.id).catch((err) => { $("dsub").innerHTML = '<span class="err">' + esc(err.message) + '</span>'; }); });
  $("kind").addEventListener("change", render);

  Promise.all([fetch("/api/summary").then((r) => r.json()), fetch("/api/status").then((r) => r.json())]).then(([s, st]) => {
    summary = s.sources || [];
    const run = st.latest_run;
    $("status").textContent = run ? "Última coleta: " + when(run.key.replace(/^log\\/(\\d{4})\\/(\\d{2})\\/(\\d{2})\\/(\\d{2})(\\d{2})(\\d{2})Z\\.ndjson$/, "$1-$2-$3T$4:$5:$6Z")) + " UTC · " + Object.entries(run.outcomes).map(([k, v]) => v + " " + ({ stored: "novas", unchanged: "sem mudança", http_error: "erro HTTP", network_error: "erro de rede", not_a_crl: "não é LCR", too_large: "grandes demais" }[k] || k)).join(", ") + " · " + st.sources + " fontes configuradas" : "Nenhuma coleta registrada ainda.";
    render();
  }).catch((err) => { $("status").innerHTML = '<span class="err">Erro ao carregar: ' + esc(err.message) + '</span>'; });
})();
</script>
</body>
</html>
`;
