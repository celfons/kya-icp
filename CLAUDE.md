# CLAUDE.md — kya-icp

Contexto para sessões de IA. Regras editoriais e decisões do autor: **kya-paper/CLAUDE.md**. Aqui, só o coletor.

## O que é

Worker da Cloudflare (cron no minuto 23 de cada hora) que baixa as LCR da ICP-Brasil listadas em `sources.json`,
guarda cada versão nova em R2 byte a byte (`lcr/<fonte>/<thisUpdate>_<sha256>.crl`), registra toda tentativa em
`log/AAAA/MM/DD/HHMMSSZ.ndjson` e mantém agregados pequenos para a API. É a fonte dos dados dos artigos.

- `src/collector.ts`: download, `hostPacer` (2 s entre requisições ao mesmo host), `interleaveByHost`, `mirror`
  (espelho tentado quando o host principal recusa ou cai), deduplicação por SHA-256.
- `src/der.ts`: só o cabeçalho da LCR; as entradas são analisadas offline. `src/aggregate.ts`: agregados.
- `src/estrutura.ts`, `src/iti.ts`, `src/pix.ts`: instantâneos da árvore do ITI, do painel de ativos e do Pix.
- API: `/api/status`, `/api/summary`, `/api/source/<id>`, `/api/monthly.csv`, `/api/weekday-hour.csv`,
  `/api/iti.csv`, `/api/estrutura.csv`, `/files/<chave>`. Tudo público e sem autenticação.

## Regras

- **Deploy é automático a partir de `main`.** Mesclar um PR muda o coletor em produção na próxima execução. Por
  isso: typecheck e testes limpos, e nada de fonte não verificada.
- **Fonte nova**: `{id, ac, url, kind, mirror?}`. `id` casa com `^[a-z0-9][a-z0-9-]{0,63}$` e começa com `uf-`
  (usuário final) ou `ac-`; `kind` é `usuario-final` ou `ac`. Antes de adicionar, baixar a URL e conferir com
  `openssl crl -inform DER -in x.crl -noout -issuer -nextupdate` que é LCR válida e de qual AC. Geração encerrada
  entra com "(encerrada, ...)" no `ac`. Se o id gerar nome diferente do do ITI, acrescentar o apelido em
  `ALIAS_ITI` de `figuras.py` (kya-paper e kya-brasil).
- **Nunca** descartar nem reescrever objetos do R2; só se acrescenta. O `state/<fonte>.json` é o único que muda.
- Hosts que bloqueiam clientes (Serasa barra qualquer coisa que não pareça navegador; Soluti devolve 403 a
  rajadas) são fatos operacionais: ficam no README, não nos artigos.
- Onde achar LCR que faltam: repositório público da própria AC (índice da Certisign, páginas da Serasa, DPC em PDF
  da DigitalSign), padrões de host conhecidos (Certisign, Soluti, Valid, Safeweb, SyngularID) ou um certificado
  emitido pela AC (campo CRL Distribution Points). O ITI publica só os certificados das AC, sem índice de LCR.
- PR para `main`, squash; merge autorizado pelo autor. Branch de trabalho realinhada com `main` depois.
- Release `vAAAA.MM` no GitHub vira versão no Zenodo (DOI conceito 10.5281/zenodo.23973109).
