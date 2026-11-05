# kya-icp

Coleta horária das **listas de certificados revogados (LCR)** da ICP-Brasil, guardadas brutas no Cloudflare R2,
para medir **com que frequência** e **com que atraso** certificados ICP-Brasil são revogados.

É a base empírica da política de atualidade do status do [KYA Brasil](https://github.com/celfons/kya-brasil)
(SPEC §18): quão recente precisa ser a prova de status para aceitar uma ação de valor *v* com risco controlado.

## Por que não depende de usuários

As LCR são públicas e cobrem **todos** os certificados emitidos por cada autoridade certificadora (AC), não só os de
quem usa o KYA. Cada AC é obrigada a publicá-las (DOC-ICP-05, item 4.9.7: a de usuário final a cada 6 horas no
máximo). Baixá-las com regularidade basta para medir:

- **taxa de revogação:** revogações por mês e por AC; cada entrada traz a data da revogação, então a primeira coleta
  já reconstrói a série dos meses anteriores (com uma ressalva, abaixo);
- **atraso de publicação:** entre a data da revogação e a primeira LCR que a lista; só mede revogações feitas
  depois do início da coleta, porque as ACs publicam apenas a versão mais recente.

## Como funciona

Um Worker com cron (minuto 23 de cada hora) baixa cada fonte de [`sources.json`](sources.json):

```
lcr/<fonte>/<thisUpdate>_<sha256[0:16]>.crl   LCR bruta, byte a byte, gravada só quando muda
state/<fonte>.json                           última versão gravada (deduplicação por SHA-256)
log/<AAAA>/<MM>/<DD>/<HHMMSS>Z.ndjson        uma linha por fonte e execução, inclusive falhas
```

Os metadados de cada objeto trazem a fonte, a URL, a hora da coleta, `thisUpdate`, `nextUpdate`, o número da LCR e
o total de entradas. O Worker **não decodifica as entradas**: só lê o cabeçalho (`src/der.ts`), o que leva poucos
milissegundos mesmo na maior lista (SERPRO, 2,3 MB e 77 mil entradas: 3,7 ms). Toda a análise é offline, a partir dos
arquivos brutos, que são a evidência auditável.

`GET /` mostra o resumo da última execução; `GET /sources` lista as fontes.

## Implantação

1. Neste repositório, em *Settings → Secrets and variables → Actions*, crie:
   - `CLOUDFLARE_ACCOUNT_ID`: o ID da conta Cloudflare;
   - `CLOUDFLARE_API_TOKEN`: um token com *Workers Scripts: Edit* e *Workers R2 Storage: Edit*.
2. Um push na `main` (ou *Actions → Deploy → Run workflow*) cria o bucket `kya-icp-lcr`, se faltar, e publica o
   Worker `kya-icp-collector`. A primeira coleta acontece no minuto 23 seguinte.

Local: `pnpm install`, `pnpm test`, `pnpm dev` (com `--test-scheduled`, `curl "http://localhost:8787/cdn-cgi/handler/scheduled"`
dispara uma coleta). Teste contra as fontes reais: `LIVE=1 pnpm vitest run test/live.test.ts`.

## Análise

Baixe o bucket (por exemplo com [rclone](https://rclone.org/s3/#cloudflare-r2) e um token de API S3 do R2) e rode:

```sh
pip install cryptography
python3 -I analysis/analyze.py --lcr data/lcr --out data/out
```

Saídas: `monthly_revocations.csv` (revogações por mês e fonte), `first_seen.csv` (atraso de publicação de cada
revogação nova) e `summary.csv` (por fonte: snapshots, entradas, mediana, p95 e máximo do atraso, entradas com motivo).

## Limitações conhecidas

- **Sem motivo:** em 5 nov. 2026, nenhuma das 165 mil entradas de três LCR de usuário final (SERPRO RFB v5, Soluti
  Múltipla, Certisign RFB G5) informava o motivo (`reasonCode`) nem a data de comprometimento (`invalidityDate`).
  A taxa total serve de teto para a taxa de revogação por comprometimento da chave.
- **Meses antigos subestimados:** as ACs tiram da LCR os certificados que já expiraram, então a série reconstruída
  da primeira coleta é um piso para os meses antigos; os últimos 12 meses ficam quase completos.
- **Fontes:** a lista começou com as LCR de certificados de AC (extraídas das âncoras ICP-Brasil) e algumas LCR de
  usuário final conhecidas. Faltam as de muitas ACs de último nível; amplie `sources.json`. Espelhos de uma mesma LCR
  são mantidos de propósito: medem a disponibilidade de cada endereço.
- **Denominador:** a taxa por certificado ativo precisa do número de certificados ativos por AC, que o painel do ITI
  não publica; sem ele, a taxa fica no nível nacional (17,2 milhões ativos em nov. 2026).

## Licença

MIT. Os dados coletados são públicos (LCR da ICP-Brasil).
