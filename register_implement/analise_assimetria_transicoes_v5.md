# Analise: Assimetria de Transicoes do Classificador v5.0

**Data:** 2026-01-31
**Modelo:** gnb_model_20260131.json (Gaussian Naive Bayes, 14 features, 3 classes)
**Status:** PROBLEMA ATIVO - classificando LOW como MEDIUM apos ajuste de parametros

---

## 1. Sintoma Observado

O classificador detecta transicoes de subida (LOW->MEDIUM->HIGH) em 1-5 segundos,
mas transicoes de descida (HIGH->MEDIUM->LOW) levam 26-74 segundos ou dao TIMEOUT.

Apos ajuste de parametros (window=60, min_points=25, flush_keep=20, detect_ratio=0.55),
o modelo passou a classificar erroneamente LOW como MEDIUM de forma persistente.

## 2. Resultados dos Testes

### Teste 1 - Parametros originais (window=100, min_points=40, ratio=0.45, flush=40)

| Transicao       | Tempo   | Status  |
|-----------------|---------|---------|
| LOW -> MEDIUM   | 6.2s    | OK      |
| MEDIUM -> HIGH  | 4.6s    | OK      |
| HIGH -> MEDIUM  | 74.2s   | LENTO   |
| MEDIUM -> LOW   | 18.4s   | LENTO   |
| LOW -> HIGH     | 4.6s    | OK      |
| HIGH -> LOW     | TIMEOUT | FALHOU  |

### Teste 2 - Parametros ajustados (window=60, min_points=25, ratio=0.55, flush=20)

| Transicao       | Tempo   | Status  |
|-----------------|---------|---------|
| LOW -> MEDIUM   | 2.4s    | OK      |
| MEDIUM -> HIGH  | 4.4s    | OK      |
| HIGH -> MEDIUM  | 29.8s   | LENTO   |
| MEDIUM -> LOW   | 66.8s   | LENTO   |
| LOW -> HIGH     | 1.2s    | OK      |
| HIGH -> LOW     | 26.0s   | LENTO   |

**Conclusao:** Ajuste de parametros do buffer NAO resolve o problema.
Alem disso, janela muito curta (60) com flush agressivo (keep=20) causa instabilidade:
o modelo começa a classificar LOW como MEDIUM porque features estatisticas de alta ordem
nao estabilizam com tao poucos pontos.

## 3. Causa Raiz Identificada

### 3.1 Composicao das Features

Das 14 features do modelo, **8 sao momentos de 3a e 4a ordem** (skew/kurtosis):

```
SKEW/KURTOSIS (8/14 = 57%):
  gyro_y_dps_skew, accel_x_g_skew, accel_z_g_skew, accel_y_g_skew
  accel_x_g_kurtosis, gyro_y_dps_kurtosis, accel_z_g_kurtosis, gyro_x_dps_kurtosis

SHAPE/AMPLITUDE/MEAN (5/14 = 36%):
  gyro_x_dps_shape_factor, gyro_y_dps_shape_factor
  accel_x_g_root_amplitude, accel_x_g_mean, accel_z_g_root_amplitude

PEAK (1/14 = 7%):
  gyro_z_dps_peak
```

### 3.2 Por que Skew/Kurtosis causam assimetria

Skew usa x^3 e kurtosis usa x^4 no calculo. Isso cria uma assimetria fundamental:

- **SUBIDA (LOW->HIGH):** Poucos pontos de alta amplitude entram no buffer e
  imediatamente dominam skew/kurtosis (um ponto 3x maior contribui 27x para skew
  e 81x para kurtosis). Transicao rapida.

- **DESCIDA (HIGH->LOW):** Poucos pontos de HIGH que RESTAM no buffer continuam
  inflando skew/kurtosis desproporcionalmente. A janela precisa estar quase 100%
  preenchida com dados novos para convergir. Transicao muito lenta.

### 3.3 Assimetria de Variancia entre Classes

A classe HIGH tem variancia muito maior em features chave:

| Feature                    | var_HIGH/var_MEDIUM | var_HIGH/var_LOW |
|----------------------------|---------------------|------------------|
| accel_x_g_mean             | 12.3x               | 27.6x            |
| accel_x_g_root_amplitude   | 11.9x               | 24.1x            |
| gyro_z_dps_peak            | 10.9x               | 3.0x             |
| accel_z_g_root_amplitude   | 5.3x                | 8.2x             |
| gyro_y_dps_kurtosis        | 2.3x                | 3.7x             |

Consequencia no Gaussian NB: uma Gaussiana mais larga (HIGH) "captura" valores
intermediarios como plausíveis, enquanto uma Gaussiana estreita (MEDIUM/LOW)
penaliza fortemente qualquer valor fora da media. A classe HIGH resiste a perder
probabilidade durante a descida.

### 3.4 Simulacao de Transicao Feature-a-Feature

Movendo features de HIGH-mean para MEDIUM-mean uma por uma:
- Com accel_x_g_mean e accel_x_g_root_amplitude ainda em HIGH (var_ratio >11x),
  mesmo que as outras 12 features estejam em MEDIUM, o classificador mantem HIGH.
- Somente quando gyro_z_dps_peak (a feature mais discriminativa) muda,
  o classificador vira para MEDIUM.

### 3.5 Instabilidade com Janela Curta

Reduzir WINDOW_SIZE para 60 e FAST_FLUSH_KEEP para 20 agravou o problema:
- Skew e kurtosis precisam de ~50+ pontos para estabilizar estatisticamente
- Com apenas 20-25 pontos apos flush, esses momentos flutuam muito
- O modelo confunde LOW com MEDIUM porque as features nao convergem
- Isso explica o erro atual: LOW sendo classificado como MEDIUM

## 4. O que NAO Funciona (Licoes Aprendidas)

1. **Reduzir WINDOW_SIZE abaixo de 80:** Features de alta ordem (skew/kurtosis)
   nao estabilizam, causando classificacao erratica.

2. **FAST_FLUSH_KEEP abaixo de 30:** Apos flush, sobram poucos pontos para
   calcular momentos de 3a/4a ordem com precisao.

3. **Aumentar CHANGE_DETECT_RATIO:** Flush mais frequente + poucos pontos mantidos
   = instabilidade. Flush precisa manter dados suficientes.

4. **Ajustar apenas parametros do buffer:** O problema e estrutural (composicao
   de features + variancia assimetrica do modelo), nao operacional.

## 5. Acao Imediata

**REVERTER parametros para os defaults originais:**
- WINDOW_SIZE: 100
- MIN_POINTS: 40
- SMOOTHING_ALPHA: 0.65
- HYSTERESIS_COUNT: 2
- CHANGE_DETECT_RATIO: 0.45
- FAST_FLUSH_KEEP: 40

Os defaults sao mais estaveis. O problema de descida lenta e preferivel
a classificacao errada (LOW como MEDIUM).

## 6. Solucoes Possiveis (para implementacao futura)

### Opcao A: Retreinar com menos features de alta ordem
- Remover ou reduzir skew/kurtosis (atualmente 8/14 features)
- Priorizar mean, std, rms, peak que convergem proporcionalmente ao window size
- Requer re-rodar pipeline de selecao de features com restricao

### Opcao B: Normalizar variancias antes do GNB
- Aplicar StandardScaler no pipeline de treino
- Equaliza a "largura" das Gaussianas entre classes
- Impede que HIGH capture valores intermediarios

### Opcao C: Janela adaptativa por tipo de feature
- Features de 1a/2a ordem (mean, std, rms): janela completa (100 pts)
- Features de 3a/4a ordem (skew, kurtosis): sub-janela recente (30 pts)
- Requer refatorar FeatureExtractor para aceitar janelas separadas

### Opcao D: Trocar algoritmo de classificacao
- Random Forest ou LightGBM nao tem o problema de variancia assimetrica
  (nao usam Gaussianas, usam decision boundaries)
- Porem sao mais pesados para inferencia em tempo real no browser

## 7. Referencia: Estatisticas Completas do Modelo

```
gyro_z_dps_peak:     HIGH mean=43.38 std=1.60  |  MED mean=25.91 std=0.48  |  LOW mean=19.97 std=0.92
gyro_y_dps_skew:     HIGH mean=0.41  std=0.19  |  MED mean=-0.06 std=0.18  |  LOW mean=-0.12 std=0.15
accel_x_g_skew:      HIGH mean=-0.40 std=0.16  |  MED mean=-0.28 std=0.14  |  LOW mean=0.03  std=0.15
accel_z_g_skew:      HIGH mean=-0.31 std=0.15  |  MED mean=0.11  std=0.14  |  LOW mean=0.02  std=0.16
accel_x_g_kurtosis:  HIGH mean=-0.36 std=0.23  |  MED mean=-0.86 std=0.18  |  LOW mean=-0.56 std=0.21
gyro_x_dps_shape:    HIGH mean=1.23  std=0.03  |  MED mean=1.21  std=0.02  |  LOW mean=1.17  std=0.03
gyro_y_dps_kurtosis: HIGH mean=-0.11 std=0.38  |  MED mean=-0.65 std=0.25  |  LOW mean=-0.72 std=0.20
gyro_y_dps_shape:    HIGH mean=1.26  std=0.03  |  MED mean=1.22  std=0.03  |  LOW mean=1.20  std=0.02
accel_x_g_root_amp:  HIGH mean=0.27  std=0.01  |  MED mean=0.28  std=0.004 |  LOW mean=0.28  std=0.003
accel_z_g_kurtosis:  HIGH mean=-0.17 std=0.38  |  MED mean=-0.48 std=0.25  |  LOW mean=-0.29 std=0.31
accel_y_g_skew:      HIGH mean=0.04  std=0.15  |  MED mean=-0.10 std=0.11  |  LOW mean=-0.11 std=0.25
accel_x_g_mean:      HIGH mean=0.29  std=0.01  |  MED mean=0.29  std=0.004 |  LOW mean=0.29  std=0.003
accel_z_g_root_amp:  HIGH mean=1.082 std=0.003 |  MED mean=1.083 std=0.001 |  LOW mean=1.083 std=0.001
gyro_x_dps_kurtosis: HIGH mean=-0.42 std=0.31  |  MED mean=-0.48 std=0.28  |  LOW mean=-0.39 std=0.24
```
