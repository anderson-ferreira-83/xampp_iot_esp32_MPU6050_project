import json
import os
import time

import numpy as np
import pandas as pd
from scipy import stats as scipy_stats
from sklearn.metrics import accuracy_score
from sklearn.model_selection import cross_val_score
from sklearn.naive_bayes import GaussianNB
from sqlalchemy import create_engine

# --- CONFIGURAÇÕES ---
DB_CONNECTION_STR = 'mysql+mysqlconnector://root:@localhost/iot_mpu6050'
WINDOW_SIZE = 100  # Deve ser igual ao ClassifierConfig.WINDOW_SIZE no JS
MIN_SAMPLES_PER_CLASS = 50
OUTPUT_FILE = '../models/multifeature_model.json'
SAMPLE_RATE = 5  # Hz (default 5 para dados atuais, trocar para 20 em produção)


def compute_spectral_features(signal, sample_rate):
    """
    Compute P1-P14 spectral features from a 1D signal.
    Uses np.fft.rfft with zero-padding to next power of 2.
    IDENTICAL to JS FFT.magnitudeSpectrum + SpectralFeatureExtractor.computeP1toP14
    """
    signal = np.asarray(signal, dtype=np.float64)
    N = int(2 ** np.ceil(np.log2(len(signal))))  # next power of 2

    # FFT with zero-padding
    fft_vals = np.fft.rfft(signal, n=N)
    mag = np.abs(fft_vals) / N
    # Double non-DC, non-Nyquist bins (one-sided normalization)
    mag[1:-1] *= 2
    freq = np.fft.rfftfreq(N, d=1.0 / sample_rate)

    K = len(mag)

    # Exclude DC bin (index 0)
    mag_ndc = mag[1:]
    freq_ndc = freq[1:]

    sumS = mag_ndc.sum()
    if sumS < 1e-15:
        return {f'P{i}': 0.0 for i in range(1, 15)}

    w = mag_ndc / sumS

    wf = np.sum(w * freq_ndc)
    wf2 = np.sum(w * freq_ndc ** 2)
    wf4 = np.sum(w * freq_ndc ** 4)

    P5 = wf  # centroid
    P1 = P5
    P7 = np.sqrt(wf2)

    d = freq_ndc - P5
    var_ = np.sum(w * d ** 2)
    m3 = np.sum(w * d ** 3)
    m4 = np.sum(w * d ** 4)
    sqrtAbsDev = np.sum(w * np.sqrt(np.abs(d)))

    P2 = var_
    P6 = np.sqrt(P2)
    P14 = P6

    P3 = m3 / (P6 ** 3) if P6 > 1e-15 else 0.0
    P4 = m4 / (P6 ** 4) if P6 > 1e-15 else 0.0

    P8 = np.sqrt(np.sqrt(wf4 / wf2)) if wf2 > 1e-15 else 0.0
    P9 = wf2 / (P5 ** 2) if P5 > 1e-15 else 0.0
    P10 = P6 / P5 if P5 > 1e-15 else 0.0
    P11 = P3  # same formula
    P12 = P4  # same formula
    P13 = sqrtAbsDev ** 2

    return {
        'P1': P1, 'P2': P2, 'P3': P3, 'P4': P4, 'P5': P5,
        'P6': P6, 'P7': P7, 'P8': P8, 'P9': P9, 'P10': P10,
        'P11': P11, 'P12': P12, 'P13': P13, 'P14': P14
    }


# Mapeamento de Features (Deve ser IDÊNTICO ao FeatureExtractor no classifier.js)
def _axis_features(arr, prefix):
    """Compute 11 temporal features for one axis, aligned with JS FeatureExtractor."""
    vals = arr.values if hasattr(arr, 'values') else np.asarray(arr)
    n = len(vals)
    m = vals.mean()
    s = vals.std(ddof=0)

    rms = np.sqrt((vals ** 2).mean())
    abs_vals = np.abs(vals)
    abs_sorted = np.sort(abs_vals)
    peak = abs_sorted[int(0.95 * (n - 1))]  # P95
    mean_abs = abs_vals.mean()
    root_amp_val = (np.sqrt(abs_vals).mean()) ** 2

    skew_val = scipy_stats.skew(vals, bias=True) if n >= 3 else 0.0
    kurt_val = scipy_stats.kurtosis(vals, fisher=True, bias=True) if n >= 4 else 0.0

    crest = peak / rms if rms > 1e-10 else 0.0
    shape = rms / mean_abs if mean_abs > 1e-10 else 0.0
    impulse = peak / mean_abs if mean_abs > 1e-10 else 0.0
    clearance = peak / root_amp_val if root_amp_val > 1e-10 else 0.0

    return {
        f'{prefix}_mean': m,
        f'{prefix}_std': s,
        f'{prefix}_skew': skew_val,
        f'{prefix}_kurtosis': kurt_val,
        f'{prefix}_rms': rms,
        f'{prefix}_peak': peak,
        f'{prefix}_root_amplitude': root_amp_val,
        f'{prefix}_crest_factor': crest,
        f'{prefix}_shape_factor': shape,
        f'{prefix}_impulse_factor': impulse,
        f'{prefix}_clearance_factor': clearance,
    }


def extract_features(window, sample_rate=None):
    """Extract 66 temporal + 84 spectral features per window (if sample_rate > 0)."""
    # 6 axes
    axes = [
        ('accel_x_g', window['accel_x_g']),
        ('accel_y_g', window['accel_y_g']),
        ('accel_z_g', window['accel_z_g']),
        ('gyro_x_dps', window['gyro_x_dps']),
        ('gyro_y_dps', window['gyro_y_dps']),
        ('gyro_z_dps', window['gyro_z_dps']),
    ]

    features = {}
    for prefix, arr in axes:
        features.update(_axis_features(arr, prefix))

    # Spectral features (P1-P14 per axis = 84 features)
    if sample_rate and sample_rate > 0:
        for prefix, arr in axes:
            vals = arr.values if hasattr(arr, 'values') else np.asarray(arr)
            spec = compute_spectral_features(vals, sample_rate)
            for key, val in spec.items():
                features[f'{prefix}_{key}'] = val

    return pd.Series(features)

def main():
    print("--- INICIANDO TREINAMENTO VIA BANCO DE DADOS ---")
    
    # 1. Conexão com Banco de Dados
    print(f"[1/5] Conectando ao MySQL ({DB_CONNECTION_STR})...")
    try:
        engine = create_engine(DB_CONNECTION_STR)
        # Buscamos apenas dados rotulados (ignoramos 'RAW' e 'UNKNOWN')
        query = "SELECT * FROM sensor_data WHERE fan_state IN ('LOW', 'MEDIUM', 'HIGH') ORDER BY timestamp ASC"
        df_raw = pd.read_sql(query, engine)
        print(f"      Dados carregados: {len(df_raw)} linhas.")
    except Exception as e:
        print(f"      ERRO AO CONECTAR: {e}")
        return

    if len(df_raw) < WINDOW_SIZE:
        print("      ERRO: Dados insuficientes para criar janelas.")
        return

    # 2. Pré-processamento (Sliding Window)
    print(f"[2/5] Gerando janelas deslizantes (Tamanho={WINDOW_SIZE})...")
    
    X_list = []
    y_list = []
    
    # Processar cada estado separadamente para evitar janelas mistas nas transições
    for state in ['LOW', 'MEDIUM', 'HIGH']:
        df_state = df_raw[df_raw['fan_state'] == state].copy()
        
        if len(df_state) < WINDOW_SIZE:
            print(f"      Aviso: Estado {state} tem poucos dados ({len(df_state)}), ignorando.")
            continue
            
        # Reset index para o rolling funcionar corretamente
        df_state = df_state.reset_index(drop=True)
        
        # Aplicar rolling window e extrair features
        # Usamos step=10 para não gerar dados excessivamente redundantes (data augmentation implícito)
        # Para produção rigorosa, step=WINDOW_SIZE é mais seguro, mas step menor ajuda com poucos dados.
        step = 5 
        
        print(f"      Processando estado {state} ({len(df_state)} amostras)...")
        
        # Loop manual otimizado para extração
        for i in range(WINDOW_SIZE, len(df_state), step):
            window = df_state.iloc[i-WINDOW_SIZE:i]
            features = extract_features(window, sample_rate=SAMPLE_RATE)
            X_list.append(features)
            y_list.append(state)

    if not X_list:
        print("      ERRO: Nenhuma feature gerada.")
        return

    X = pd.DataFrame(X_list)
    y = np.array(y_list)
    
    print(f"      Dataset de Treino Criado: {len(X)} amostras, {len(X.columns)} features.")
    print(f"      Distribuição: {pd.Series(y).value_counts().to_dict()}")

    # 3. Treinamento do Modelo
    print("[3/5] Treinando Gaussian Naive Bayes...")
    clf = GaussianNB()
    
    # Validação Cruzada para métricas
    scores = cross_val_score(clf, X, y, cv=5)
    print(f"      Acurácia CV (média): {scores.mean()*100:.2f}%")
    
    # Treino final com todos os dados
    clf.fit(X, y)
    train_acc = accuracy_score(y, clf.predict(X))
    print(f"      Acurácia Treino: {train_acc*100:.2f}%")

    # 4. Extração de Parâmetros para Exportação JSON
    print("[4/5] Extraindo parâmetros do modelo...")
    
    # Scikit-learn armazena as médias em theta_ e variâncias em var_
    # A ordem das classes está em clf.classes_
    
    export_data = {
        "type": "gaussian_nb",
        "version": "5.0_db_auto",
        "generated_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "features": list(X.columns),
        "labels": list(clf.classes_),
        "priors": {},
        "stats": {},
        "metrics": {
            "train_accuracy": train_acc,
            "cv_accuracy_mean": scores.mean()
        },
        "training_info": {
            "total_samples": int(len(X)),
            "window_size": WINDOW_SIZE
        }
    }

    # Preencher Priors
    # class_prior_ pode não existir se priors não foram passados no init, então calculamos ou usamos class_count_
    if hasattr(clf, 'class_prior_'):
        priors = clf.class_prior_
    else:
        priors = clf.class_count_ / clf.class_count_.sum()
        
    for i, label in enumerate(clf.classes_):
        export_data["priors"][label] = priors[i]
        
    # Preencher Stats (Médias e Variâncias)
    # Estrutura: stats[LABEL][FEATURE] = { mean: ..., var: ... }
    for i, label in enumerate(clf.classes_):
        export_data["stats"][label] = {}
        for j, feature in enumerate(X.columns):
            export_data["stats"][label][feature] = {
                "mean": clf.theta_[i, j],
                "var": clf.var_[i, j]
            }

    # 5. Salvando Arquivo
    print(f"[5/5] Salvando modelo em {OUTPUT_FILE}...")
    
    # Garantir que o diretório existe
    os.makedirs(os.path.dirname(OUTPUT_FILE), exist_ok=True)
    
    with open(OUTPUT_FILE, 'w') as f:
        json.dump(export_data, f, indent=2)
        
    print("\nSUCESSO! Modelo exportado.")
    print("Para usar este modelo:")
    print(f"1. Verifique se o arquivo foi criado em: {os.path.abspath(OUTPUT_FILE)}")
    print("2. Atualize a constante ML_CONFIG.MODEL_URL no arquivo 'js/dashboard.js' para apontar para este arquivo.")
    print("   Exemplo: MODEL_URL: 'models/multifeature_model.json'")

if __name__ == "__main__":
    # Instalar dependências se necessário:
    # pip install pandas sqlalchemy mysql-connector-python scikit-learn
    main()