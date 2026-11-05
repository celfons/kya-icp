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

A cada versão nova, o Worker também atualiza agregados pequenos (`src/aggregate.ts`), para o painel não processar
LCR a cada visita:

```
seen/<fonte>.txt    números de série da última versão agregada
agg/<fonte>.json    revogações por mês (da LCR mais recente) e o atraso de publicação de cada revogação nova
agg/index.json      resumo de todas as fontes
```

Percorrer as 77 mil entradas do SERPRO custa cerca de 240 ms de CPU, acima do limite do plano gratuito dos Workers:
**o Worker precisa do plano pago (Workers Paid)**. A gravação da LCR bruta acontece antes e não depende do agregado.

### Painel e API (somente leitura; os dados são públicos)

| Rota | Conteúdo |
| --- | --- |
| `GET /` | painel: revogações por mês, atraso de publicação, fontes e arquivos brutos |
| `GET /api/status` | última execução e resultados |
| `GET /api/summary` | `agg/index.json` |
| `GET /api/source/<fonte>` | `agg/<fonte>.json` |
| `GET /api/files/<fonte>` | versões brutas guardadas (`?cursor=` para paginar) |
| `GET /api/source/<fonte>/monthly.csv` | revogações por mês de uma fonte, em CSV |
| `GET /api/monthly.csv` | revogações por mês de todas as fontes, em CSV |
| `GET /api/iti`, `GET /api/iti.csv` | denominador: certificados ativos no país segundo o ITI, uma linha por versão guardada |
| `GET /files/<chave>` | uma LCR bruta (`lcr/...`) ou um log (`log/...`) |
| `GET /sources` | as fontes configuradas |
| `POST /api/run` | roda uma coleta agora (veja abaixo) |

### Coleta sob demanda

Para a primeira carga, ou depois de corrigir uma fonte, sem esperar o minuto 23: cadastre no Worker o secret
`RUN_TOKEN` (*Workers & Pages → kya-icp-collector → Settings → Variables and Secrets → Add → Secret*, ou
`pnpm exec wrangler secret put RUN_TOKEN`) com um valor longo e aleatório, e chame:

```sh
curl -X POST -H "Authorization: Bearer $RUN_TOKEN" https://kya-icp-collector.<sua-conta>.workers.dev/api/run
```

A resposta traz o log da execução e os resultados. Sem o secret a rota não existe (404); com o token errado, 401;
uma nova execução menos de 5 minutos depois da anterior é recusada (429, com `Retry-After`).

## Denominador (ITI)

A cada coleta o Worker baixa `https://numeros.iti.gov.br/assets/paneljson/panels.json` e, quando o arquivo muda, guarda a versão bruta em `iti/panels/` e acrescenta uma linha a `agg/iti.json` (ativos, emitidos no ano, ativos por titular e por tipo, emissões mensais). O ITI não mantém histórico desse arquivo; a série começa na primeira coleta. Não há contagem por AC: a taxa por AC depende de pedido pela Lei de Acesso à Informação.

## Implantação

Pela integração Git da Cloudflare (Workers Builds), sem GitHub Actions: cada push na `main` publica o Worker.

1. Crie o bucket R2 **`kya-icp-lcr`** (o nome ligado ao Worker em `wrangler.jsonc`).
2. Em *Workers & Pages → Create → Import a repository*, conecte `celfons/kya-icp` com o nome de Worker
   **`kya-icp-collector`** (o `name` de `wrangler.jsonc`), diretório raiz `/` e comando de deploy `npx wrangler deploy`.
   O cron horário e o vínculo com o R2 vêm de `wrangler.jsonc`.
3. Desligue os builds de outros branches (*Settings → Build → Branch control*): não há ambiente de preview, só a
   produção pela `main`.
4. Os agregados das LCR grandes pedem o plano Workers Paid (veja acima). A primeira coleta acontece no minuto 23
   seguinte ao deploy.

O GitHub Actions roda só o CI (`.github/workflows/ci.yml`): typecheck, testes e o build do Worker.

Local: `pnpm install`, `pnpm test`, `pnpm dev` (painel em `http://localhost:8787/`; com `--test-scheduled`,
`curl "http://localhost:8787/cdn-cgi/handler/scheduled"` dispara uma coleta). Teste contra as fontes reais: `LIVE=1 pnpm vitest run test/live.test.ts`.

## Análise

Baixe o bucket (por exemplo com [rclone](https://rclone.org/s3/#cloudflare-r2) e um token de API S3 do R2) e rode:

```sh
pip install cryptography
python3 -I analysis/analyze.py --lcr data/lcr --out data/out
```

Saídas: `monthly_revocations.csv` (revogações por mês e fonte), `first_seen.csv` (atraso de publicação de cada
revogação nova) e `summary.csv` (por fonte: snapshots, entradas, mediana, p95 e máximo do atraso, entradas com motivo).

## Limitações conhecidas

- **Motivo, conforme a AC:** em 5 nov. 2026 nenhuma entrada trazia a data de comprometimento (`invalidityDate`), e o
  motivo (`reasonCode`) variava por AC: nenhuma das 77.316 entradas do SERPRO RFB v5 nem das 33.889 da Soluti Múltipla v5;
  88% das 7.629 da Certisign RFB G5 (4.007 como *keyCompromise*) e 94% das 1.086 da Serasa RFB v5. Onde falta o motivo,
  a taxa total serve de teto para a taxa por comprometimento; onde existe, o uso dos códigos precisa ser validado.
- **Meses antigos subestimados:** as ACs tiram da LCR os certificados que já expiraram, então a série reconstruída
  da primeira coleta é um piso para os meses antigos; os últimos 12 meses ficam quase completos.
- **Fontes:** a lista começou com as LCR de certificados de AC (extraídas das âncoras ICP-Brasil) e algumas LCR de
  usuário final conhecidas. Faltam as de muitas ACs de último nível; amplie `sources.json`. Espelhos de uma mesma LCR
  são mantidos de propósito: medem a disponibilidade de cada endereço.
- **Denominador:** a taxa por certificado ativo precisa do número de certificados ativos por AC, que o painel do ITI
  não publica; sem ele, a taxa fica no nível nacional (17,2 milhões ativos em nov. 2026).

## Licença

MIT. Os dados coletados são públicos (LCR da ICP-Brasil).
