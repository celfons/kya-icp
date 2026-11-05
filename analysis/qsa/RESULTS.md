# Resultados: QSA público (Dados Abertos do CNPJ) como base para coassinatura e-CPF

Dados: Receita Federal, pasta `Dados/Cadastros/CNPJ/2026-10/` (base completa, **sem amostragem**; Estabelecimentos, Empresas, Simples, Socios, Qualificacoes). Só um mês (2026-10), por decisão do usuário: a comparação entre meses fica como trabalho futuro. Só agregados; nenhum nome ou CPF foi gravado. Números completos em `results.json`.

## 1. Mascaramento do CPF
- Formato do sócio PF: `***DDDDDD**` em 100% das 27.740.460 linhas PF. Ficam ocultos os 3 primeiros dígitos e os 2 DVs (dicionário de dados: Lei 13.473/2017, art. 129 §2º). São visíveis 6 de 11 dígitos (4º ao 9º; o 9º é a região fiscal).
- Sócio PJ: o campo vem sem máscara (742.695 linhas, padrão observado de 8 dígitos). Sócio estrangeiro: campo vazio (12.806 linhas).
- Ambiguidade: cada máscara corresponde a exatamente **1.000 CPFs válidos** (1.000 prefixos e DVs determinados; verificado em 2.000 máscaras aleatórias e por força bruta em 100.000 candidatos). Pelo CPF mascarado sozinho, um co-signatário é um entre 1.000 possíveis.
- Nome + máscara: 15.919.074 nomes distintos e 18.296.000 pares (nome, máscara) distintos. 826.949 nomes aparecem com mais de uma máscara, ou seja, homônimos que a máscara distingue. Dentro de uma mesma empresa há 27.740.188 pares (empresa, máscara) contra 27.740.454 triplas (empresa, máscara, nome). Só 266 pares (empresa, máscara) têm mais de um nome. Assim, dentro do QSA de uma empresa, nome + máscara identifica o sócio quase sem colisão. O que não se consegue é provar que o titular do e-CPF é aquela pessoa e não um homônimo com os mesmos 6 dígitos, cuja chance é de cerca de 1/1.000 entre homônimos.

## 2. Cobertura (empresas com matriz em situação ATIVA)
Denominador: 27.049.048 matrizes ativas, de 70.517.438 matrizes no total.
Qualificações de representação contadas:
- **Núcleo:** 05 Administrador, 10 Diretor, 16 Presidente, 49 Sócio-Administrador.
- **Ampla:** o núcleo mais 11, 12, 13, 19, 28, 34, 43, 50, 64, 65, 66, 67, 68, 70, 72, 73 e 74.

| Grupo | Empresas ativas (matriz) | ≥1 sócio | ≥1 PF | PF adm/dir/pres/sócio-adm (05,10,16,49) | PF qualif. ampla |
|---|---:|---:|---:|---:|---:|
| TODAS | 27,049,048 | 34.07% (9,216,612) | 34.07% (9,215,149) | 32.98% (8,921,811) | 33.58% (9,082,783) |
| Associacao privada (3999) | 544,954 | 99.95% (544,700) | 99.95% (544,700) | 99.95% (544,695) | 99.95% (544,699) |
| Cooperativa | 15,855 | 99.89% (15,838) | 99.89% (15,838) | 99.89% (15,838) | 99.89% (15,838) |
| EI nao-MEI (2135) | 2,900,772 | 0.0% (110) | 0.0% (110) | 0.0% (91) | 0.0% (106) |
| EIRELI (2305/2313) | 14 | 100.0% (14) | 100.0% (14) | 0.0% (0) | 100.0% (14) |
| LTDA (2062) | 7,916,127 | 99.53% (7,879,271) | 99.53% (7,879,048) | 99.5% (7,876,176) | 99.5% (7,876,233) |
| MEI (2135 + opcao MEI) | 13,758,052 | 0.0% (18) | 0.0% (18) | 0.0% (16) | 0.0% (16) |
| SA (2046/2054) | 64,446 | 99.3% (63,997) | 99.3% (63,993) | 99.26% (63,966) | 99.29% (63,990) |
| Soc. Simples Ltda (2240) | 175,731 | 96.61% (169,781) | 96.61% (169,767) | 96.2% (169,060) | 96.2% (169,062) |
| outras | 1,673,097 | 32.45% (542,883) | 32.37% (541,661) | 15.06% (251,969) | 24.67% (412,825) |

- MEI/EI (16,66 mi, ou 61,6% das ativas) **não têm QSA**: 128 empresas com sócio. O titular está só no nome empresarial ou no CPF do empresário, que não foi medido aqui.
- Fora MEI/EI (10.390.224 empresas), 8.921.704 (**85,9%**) têm um sócio PF com qualificação do núcleo. Em LTDA e SA o índice passa de 99%.
- "outras" (1,67 mi: condomínios, órgãos públicos, fundações etc.) têm cobertura baixa: 15,1% no núcleo e 24,7% na qualificação ampla.
- EIRELI quase sumiu (14 ativas), porque foram convertidas em LTDA/SLU pela Lei 14.195/2021. SLU usa o código 2062 e não se distingue de LTDA.
- Distribuição de qualificações (linhas PF): 49 = 18,16 mi; 22 (sócio sem poder de administração) = 5,62 mi; 16 = 1,51 mi; 05 = 0,82 mi; 10 = 0,40 mi. O QSA lista sócios não administradores: estar no QSA não basta, é preciso filtrar pela qualificação.
- O QSA não traz limites de poder: assinatura conjunta, alçadas, cláusulas do contrato social e procuradores (procurações não constam).

## 3. Representante legal
- 28.495.961 linhas; 761.727 (2,67%) têm CPF/nome de representante legal. Qualificações: 05 = 510.605; 17 Procurador = 97.635; 15 Pai = 79.081; 14 Mãe = 71.518.
- Sócios menores ou incapazes (29, 30, 67, 68): 152.831, dos quais 152.408 têm representante.
- Estrangeiros (ident. 3): 12.806, dos quais 11.236 têm representante.
- O CPF do representante tem a mesma máscara. Sem representante, o campo vem `***000000**`.

## 4. Frescor
- Arquivos de 2026-10: publicados em 13/10/2026, 22:00–22:09 GMT (WebDAV); o nome interno indica geração em 10/10/2026. 2026-09 foi publicado em 14/09/2026. Em 05/11/2026 ainda não existe a pasta 2026-11.
- Datas máximas no arquivo: situação cadastral 11/10/2026; data de entrada na sociedade 10/2026. O corte é por volta de 10/10, publicado cerca de 3 dias depois, e o mês seguinte sai só ~1 mês depois.
- Entradas recentes (denominador: 28.495.959 linhas com data válida):
  - último mês (out/2026, parcial): 0,20%
  - últimos 3 meses: 1,81%
  - últimos 6 meses: 4,20%
  - últimos 12 meses: 8,81%
- Por mês completo entram ~200–280 mil linhas.
- 383.253 das 27.049.048 empresas ativas (1,42%) tiveram entrada de sócio nos últimos 3 meses.
- Uma alteração feita logo após o corte leva de **~1 a ~2 meses** para aparecer, cerca de 1,5 mês em média (atraso de publicação mais periodicidade mensal). Saídas de sócios não aparecem como data e não puderam ser medidas com um mês só.

## Não medido
- Taxa de mudança entre meses e o atraso real (entradas datadas no mês anterior que só aparecem no arquivo seguinte): fica como trabalho futuro, comparando dois snapshots. O código suporta isso, basta passar `PREV`.
- Saídas e remoções de administradores.
- Exatidão do QSA frente às Juntas Comerciais.
- Titular de MEI/EI via CPF do empresário: o campo não está nos dados abertos; o nome empresarial costuma conter o nome.
- Colisões entre homônimos com a mesma máscara em escala nacional: a estimativa usa hash de nome normalizado como está no arquivo.

## Conclusão
O QSA público serve como **filtro necessário, não suficiente**:
1. Não dá para conferir o CPF completo. Dá para conferir **nome + 6 dígitos centrais + qualificação**, o que dentro de uma empresa é quase único (266 colisões em 27,7 mi).
2. Cobre bem LTDA/SA (≥99%) e não cobre MEI/EI (~62% das ativas).
3. Atrasa de 1 a 2 meses e não informa poderes, assinatura conjunta nem procuradores.

O que o verificador precisaria em vez disso, ou além disso:
- **(a)** o e-CNPJ, cujo certificado ICP-Brasil traz o CPF completo do responsável perante a Receita (OID 2.16.76.1.3.3). A empresa assina a credencial com e-CNPJ, ou declara com e-CNPJ quem são os co-signatários.
- **(b)** consulta oficial com CPF completo e situação atual: APIs de convênio da Receita/Serpro (Consulta CNPJ, que traz o QSA não mascarado para órgãos conveniados) ou certidões da Junta Comercial e REDESIM.
- **(c)** como fallback, casar o e-CPF com o QSA aberto por nome, máscara e qualificação do núcleo (05/10/16/49). Para MEI/EI, casar o nome do titular com o nome empresarial. Em ambos os casos, aplicar uma janela de tolerância de ~2 meses para mudanças recentes.
