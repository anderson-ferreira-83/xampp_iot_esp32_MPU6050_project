# Plano de Trabalho - Melhorias EDA e Pipeline de Classificacao

**Projeto:** Classificacao de 3 velocidades de ventilador (LOW/MEDIUM/HIGH) via ESP32 + MPU6050
**Data de criacao:** 2026-01-31
**Status:** Em andamento

---

## Diagnostico - O que JA esta implementado no `01_Analise_Exploratoria.ipynb`

### Celulas existentes e status

| Celula | Descricao | Status | Observacao |
|--------|-----------|--------|------------|
| 0 | Header markdown (pipeline descrito) | OK | Documenta saidas esperadas |
| 1 | Config e Imports | OK | pymysql, scipy, plotly, seaborn. `WINDOW_SIZE=100`, `STEP_SIZE=20` |
| 2 | Carga do banco | OK | Query filtra `fan_state IN (LOW, MEDIUM, HIGH)`, ordena por timestamp |
| 3 | Salvar CSV bruto | PARCIAL | Salva CSV mas SEM timestamp legivel (ISO 8601), apenas o timestamp numerico Unix |
| 4 | Validacao (info, nulls, describe) | OK | Sem nulls, 7710 amostras |
| 5 | Distribuicao de classes (barplot) | OK | LOW=2695, MEDIUM=2505, HIGH=2510 |
| 6 | Normalizacao tempo relativo por classe | OK | Calcula `relative_time_s` por classe |
| 7 | Janela temporal comum | OK | `common_window_s = 639.89s (~10.7 min)` |
| 8 | Filtro temporal | OK | Recorta todas as classes pela janela comum. Pos-filtro: LOW=2515, MED=2505, HIGH=2493 |
| 9 | Graficos individuais (Plotly, facet_row) | OK | 6 HTMLs interativos, 1 por eixo |
| 10 | Graficos sobrepostos (Plotly) | OK | 6 HTMLs com rangeslider |
| 11 | KDE das features brutas | OK | 2x3 subplots por eixo |
| 12 | Feature Engineering (janela deslizante) | OK | 11 metricas x 6 eixos = 66 features. `ddof=0` correto. 362 janelas (121+121+120) |
| 13 | Boxplots das features por classe | OK | 11 tipos de feature, catplot por eixo |
| 14 | Pair plot (std features) | OK | Corner pair plot das 6 features `_std` |
| 15 | Heatmap de correlacao | OK | 66x66 features |
| 16 | Selecao de features (ANOVA + correlacao) | OK | 59 significativas -> 14 selecionadas apos filtro correlacao |
| 17 | Exportacao (CSV, summary JSON, feature_config) | PARCIAL | Exporta tudo mas feature CSV nao tem timestamp das janelas |

### Dados reais no banco (verificado via API)

- **Taxa real de amostragem:** ~3.9 Hz (medida real), configurada para **5 Hz**
- **LOW:** 2695 amostras, 685.6s (11.4 min)
- **MEDIUM:** 2505 amostras, 639.9s (10.7 min)
- **HIGH:** 2510 amostras, 644.0s (10.7 min)
- **Todas >8 min:** SIM
- **collection_id:** unico (`v5_stream`) - nao ha problema de mistura de coletas
- **Janela comum:** 639.9s (~10.7 min)

### `feature_config.json` no disco

- **Versao:** 3.0 (JA atualizado pelo notebook 01)
- **Metodo:** `anova_f_test_with_correlation_filter`
- **14 features selecionadas** (listadas abaixo)

### 14 Features selecionadas pelo ANOVA (estado atual)

| # | Feature | F-statistic | p-value |
|---|---------|-------------|---------|
| 1 | `gyro_z_dps_peak` | 14816.05 | 0.00e+00 |
| 2 | `gyro_y_dps_skew` | 331.32 | 2.95e-82 |
| 3 | `accel_x_g_skew` | 315.96 | 7.08e-80 |
| 4 | `accel_z_g_skew` | 242.10 | 2.72e-67 |
| 5 | `accel_x_g_kurtosis` | 194.88 | 4.96e-58 |
| 6 | `gyro_x_dps_shape_factor` | 155.82 | 1.92e-49 |
| 7 | `gyro_y_dps_kurtosis` | 154.21 | 4.56e-49 |
| 8 | `gyro_y_dps_shape_factor` | 148.81 | 8.52e-48 |
| 9 | `accel_x_g_root_amplitude` | 62.58 | 4.82e-24 |
| 10 | `accel_z_g_kurtosis` | 29.50 | 1.38e-12 |
| 11 | `accel_y_g_skew` | 28.62 | 2.92e-12 |
| 12 | `accel_x_g_mean` | 18.16 | 3.06e-08 |
| 13 | `accel_z_g_root_amplitude` | 13.09 | 3.25e-06 |
| 14 | `gyro_x_dps_kurtosis` | 3.43 | 3.33e-02 |

---

## Problemas Criticos Identificados

### 1. Inconsistencia de `ddof` entre Notebook 01 e Notebook 02
- **Notebook 01** `compute_features()`: `np.std(arr, ddof=0)` -> populacional (CORRETO, alinhado com JS)
- **Notebook 02** `extract_time_domain_features()`: `series.std()` -> pandas default `ddof=1` (DIVERGENTE)
- **Impacto:** O modelo GNB treinado no notebook 02 aprendeu distribuicoes de `std` ligeiramente infladas. Quando o dashboard JS calcula com `ddof=0`, os valores sao menores, causando desvio na classificacao.

### 2. WINDOW_SIZE=100 a 5Hz = 20 segundos de sinal
- A 5 Hz, 100 pontos = 20 segundos (nao 25s como documentado para 4Hz)
- O dashboard JS usa `ClassifierConfig.WINDOW_SIZE = 100` que esta correto
- Cada step de 20 pontos = 4 segundos de avanco

### 3. Selecao de features - avaliacao de robustez
- **ANOVA F-test:** Adequado para 3 classes, mas assume normalidade e variancia homogenea
- A feature #14 (`gyro_x_dps_kurtosis`) tem F=3.43, p=0.033 - marginalmente significativa
- Faltam testes nao-parametricos (Kruskal-Wallis) e Mutual Information para validacao cruzada da selecao
- Nao ha analise de estabilidade (bootstrap) para verificar se as features selecionadas sao consistentes

### 4. CSV de features sem timestamp
- `df_features` exportado contem `window_start` e `window_end` (indices), mas nao o timestamp real
- Impede rastreabilidade temporal

### 5. Faltam visualizacoes avancadas
- Nao tem: Violin plots, t-SNE/PCA, analise de separabilidade quantitativa

### 6. Notebook 02 usa features diferentes do Notebook 01
- Notebook 02 seleciona `TOP_10_FEATURES` hardcoded (gyro_z_dps_std, gyro_z_dps_rms, etc.)
- Notebook 01 seleciona 14 features via ANOVA (gyro_z_dps_peak, gyro_y_dps_skew, etc.)
- As listas SAO DIFERENTES - o notebook 02 nao usa a saida do notebook 01

---

## Plano de Trabalho por Etapas

### FASE 1: Correcoes e Ajustes no Notebook 01

- [x] **1.1** Verificar dados no banco (quantidade, duracao, collection_ids)
- [x] **1.2** Confirmar que ha >8 min de dados por classe (confirmado: >10 min cada)
- [x] **1.3** Carga do banco com timestamp e collection_id (celula 2 - OK)
- [x] **1.4** Adicionar coluna `timestamp_iso` (ISO 8601 legivel) ao CSV bruto
- [x] **1.5** Documentar taxa real de amostragem como 5 Hz (corrigir de 4Hz)
- [x] **1.6** Ajustar WINDOW_SIZE considerando 5Hz (100 pts = 20s, documentado)

### FASE 2: Janela Temporal (JA IMPLEMENTADA - validar)

- [x] **2.1** Normalizacao temporal por classe (celula 6 - OK, so 1 collection_id)
- [x] **2.2** Calculo da janela comum (celula 7 - OK, 639.89s)
- [x] **2.3** Filtro temporal uniforme (celula 8 - OK)
- [x] **2.4** Validacao pos-filtro (celula 8 - OK, duracoes ~639s para todos)
- [x] **2.5** Graficos individuais e sobrepostos (celulas 9-10 - OK)

### FASE 3: Feature Engineering (JA IMPLEMENTADO - corrigir notebook 02)

- [x] **3.1** `ddof=0` no notebook 01 (celula 12 - OK, ja correto)
- [x] **3.2** Corrigir `ddof` no notebook 02 para `ddof=0` (CORRIGIDO)
- [x] **3.3** 11 metricas x 6 eixos = 66 features (celula 12 - OK)
- [x] **3.4** Adicionar timestamp medio de cada janela ao `df_features` (IMPLEMENTADO)
- [ ] **3.5** Avaliar se WINDOW_SIZE=100 (20s a 5Hz) e STEP_SIZE=20 (4s) sao otimos

### FASE 4: Selecao de Features - Melhorar Robustez

- [x] **4.1** ANOVA F-test (celula 16 - OK, 14 features)
- [x] **4.2** Filtro de correlacao > 0.85 (celula 16 - OK)
- [x] **4.3** Adicionar Kruskal-Wallis test (nao-parametrico) (IMPLEMENTADO)
- [x] **4.4** Adicionar Mutual Information (IMPLEMENTADO)
- [x] **4.5** Comparar rankings dos 3 metodos e selecionar consenso (IMPLEMENTADO)
- [ ] **4.6** Validar estabilidade via bootstrap

### FASE 5: Visualizacoes EDA Avancadas

- [x] **5.1** KDE por classe e eixo (celula 11 - OK)
- [x] **5.2** Boxplots por classe (celula 13 - OK)
- [x] **5.3** Pair plot std features (celula 14 - OK)
- [x] **5.4** Heatmap correlacao (celula 15 - OK)
- [x] **5.5** Violin plots (IMPLEMENTADO - celula 14b)
- [x] **5.6** t-SNE e PCA 2D para visualizar separabilidade (IMPLEMENTADO - celula 14c)

### FASE 6: Exportacao (JA IMPLEMENTADA - melhorar)

- [x] **6.1** CSV de features (celula 17 - OK, mas sem timestamp)
- [x] **6.2** `feature_config.json` v3.0 (celula 17 - OK)
- [x] **6.3** `analise_exploratoria_summary.json` (celula 17 - OK)
- [x] **6.4** `features_latest.csv` para notebook 02 (celula 17 - OK)
- [x] **6.5** Incluir timestamp no CSV de features (timestamp_start, timestamp_end, timestamp_mean)

### FASE 7: Alinhar Notebook 02 com Notebook 01

- [x] **7.1** Corrigir `ddof=1` -> `ddof=0` no notebook 02 (CORRIGIDO)
- [x] **7.2** Usar features selecionadas pelo notebook 01 (14 do ANOVA) - carrega de feature_config.json (CORRIGIDO)
- [x] **7.3** Retreinar GNB, RF, LightGBM com features corrigidas (re-executado pelo usuario)
- [x] **7.4** Validacao cruzada estratificada (k=5) (accuracy 100% treino e CV)
- [x] **7.5** Exportar modelo GNB corrigido (gnb_model_20260131.json - 14 features, 372 amostras)

### FASE 8: Integracao com Dashboard

- [x] **8.1** Atualizar `classifier.js`: Stats (skew, kurtosis, peak, shapeFactor, etc.) + FeatureExtractor (66 features)
- [x] **8.2** Atualizar `MODEL_URL` para `models/gnb_model_20260131.json`
- [ ] **8.3** Testar classificacao em tempo real (requer ESP32 ativo)
- [ ] **8.4** Validar confianca das predicoes (requer ESP32 ativo)

---

## Registro de Progresso

| Data       | Etapa | Status | Observacoes |
|------------|-------|--------|-------------|
| 2026-01-31 | Diagnostico | Concluido | Analise holistica completa |
| 2026-01-31 | Fase 1.1-1.3 | Concluido | Dados verificados: >10 min/classe, 7710 amostras, 1 collection |
| 2026-01-31 | Fase 2 | Concluido | Janela temporal ja implementada corretamente no notebook |
| 2026-01-31 | Fase 3.1, 3.3 | Concluido | Feature engineering com ddof=0 OK no notebook 01 |
| 2026-01-31 | Fase 4.1-4.2 | Concluido | ANOVA + correlacao: 14 features selecionadas |
| 2026-01-31 | Fase 5.1-5.4 | Concluido | KDE, boxplots, pair plot, heatmap OK |
| 2026-01-31 | Fase 6.1-6.4 | Concluido | Exportacao basica OK |
| 2026-01-31 | Fase 1.4-1.6 | Concluido | timestamp ISO, 5Hz documentado, WINDOW_SIZE documentado |
| 2026-01-31 | Fase 3.2, 3.4 | Concluido | ddof=0 corrigido no NB02, timestamp nas features |
| 2026-01-31 | Fase 4.3-4.5 | Concluido | Kruskal-Wallis + MI + ranking consensual implementados |
| 2026-01-31 | Fase 5.5-5.6 | Concluido | Violin plots + t-SNE/PCA implementados |
| 2026-01-31 | Fase 6.5 | Concluido | Timestamps no CSV de features |
| 2026-01-31 | Fase 7.1-7.2 | Concluido | NB02 corrigido: ddof=0 + features do feature_config.json |
| 2026-01-31 | Fase 7.3-7.5 | Concluido | Notebooks re-executados, modelo 20260131 gerado (acc=100%) |
| 2026-01-31 | Fase 8.1-8.2 | Concluido | classifier.js reescrito (66 features, 11 metricas), MODEL_URL atualizado |

---

## Notas Tecnicas

- **Taxa de amostragem configurada:** 5 Hz (SAMPLE_INTERVAL=0.2s no ESP32)
- **Taxa real medida:** ~3.9 Hz (latencia de rede reduz a taxa efetiva)
- **8 min de coleta a 5Hz = 2400 amostras** por classe (ideal)
- **8 min de coleta a 3.9Hz = 1872 amostras** por classe (real)
- **Dados atuais:** >2400 amostras/classe (>10 min coletados)
- **Janela deslizante:** 100 pontos = 20s de sinal (a 5Hz), step 20 = 4s de avanco
- **66 features totais:** 11 metricas x 6 eixos sensoriais
- **362 janelas de features** (121 LOW + 121 MEDIUM + 120 HIGH)
- **Sensor axes:** accel_x_g, accel_y_g, accel_z_g, gyro_x_dps, gyro_y_dps, gyro_z_dps

## Proximas acoes prioritarias

1. ~~**[CRITICO]** Corrigir `ddof` no notebook 02~~ FEITO
2. ~~**[CRITICO]** Fazer notebook 02 usar as 14 features do ANOVA~~ FEITO
3. ~~**[MELHORIA]** Adicionar Kruskal-Wallis e MI na selecao de features~~ FEITO
4. ~~**[MELHORIA]** Adicionar timestamp ao CSV de features~~ FEITO
5. ~~**[MELHORIA]** Adicionar t-SNE/PCA para visualizar separabilidade~~ FEITO
6. ~~**[MELHORIA]** Adicionar Violin plots~~ FEITO

### Pendentes
7. **[PENDENTE]** Re-executar ambos os notebooks para gerar artefatos atualizados
8. **[PENDENTE]** Retreinar modelo GNB com features corrigidas (Fase 7.3-7.5)
9. **[PENDENTE]** Integrar modelo atualizado com dashboard (Fase 8)
10. **[PENDENTE]** Validar estabilidade da selecao via bootstrap (Fase 4.6)
