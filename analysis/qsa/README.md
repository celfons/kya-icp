# Análise QSA (Dados Abertos do CNPJ)

Testa se um verificador consegue montar, a partir dos dados públicos da Receita
Federal, a lista de representantes legais (QSA) usada para aceitar a coassinatura
por e-CPF de uma credencial de empresa.

Arquivos (não commitar; análise local):
- `fetch.py` — baixa um zip do compartilhamento Nextcloud público da Receita
  (`arquivos.receitafederal.gov.br`, token `gn672Ad4CF8N6TK`, pasta
  `Dados/Cadastros/CNPJ/AAAA-MM/`) com requisições HTTP Range paralelas.
- `qsa_analysis.py WORKDIR LATEST PREV` — baixa um zip por vez, processa em
  streaming (`zipfile` + `csv`), apaga o zip. Mantém só vetores numpy indexados
  pelo CNPJ básico e hashes (BLAKE2b com sal aleatório por execução, só em
  memória) de nomes/CPFs mascarados. Grava `results_raw.json` (só agregados).
  `QSA_IDX=1` processa só o arquivo 1 de cada série (teste).
- `cpf_mask.py OUT.json` — conta quantos CPFs válidos casam com uma máscara `***DDDDDD**`.
- `make_report.py` — gera `results.json` e `RESULTS.md`.

Rodar: `python3 -I qsa_analysis.py /tmp/work 2026-10 2026-09 && python3 -I cpf_mask.py cpf_mask.json && python3 -I make_report.py`.
Base completa (sem amostragem). Nenhum nome ou CPF é gravado ou impresso.
