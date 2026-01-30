import json
import os
import time

import numpy as np
import pandas as pd
from sklearn.metrics import accuracy_score
from sklearn.model_selection import cross_val_score
from sklearn.naive_bayes import GaussianNB
from sqlalchemy import create_engine

# --- CONFIGURAÇÕES ---
DB_CONNECTION_STR = 'mysql+mysqlconnector://root:@localhost/iot_mpu6050'
WINDOW_SIZE = 100  # Deve ser igual ao ClassifierConfig.WINDOW_SIZE no JS
MIN_SAMPLES_PER_CLASS = 50
OUTPUT_FILE = '../models/multifeature_model.json'

# Mapeamento de Features (Deve ser IDÊNTICO ao FeatureExtractor no classifier.js)
def extract_features(window):
    # window é um DataFrame com 100 linhas
    
    # Acelerômetro
    ax = window['accel_x_g']
    ay = window['accel_y_g']
    az = window['accel_z_g']
    
    # Giroscópio
    gx = window['gyro_x_dps']
    gy = window['gyro_y_dps']
    gz = window['gyro_z_dps']
    
    # Vibração
    vib = window['vibration']
    
    features = {
        # Accelerometer features
        'accel_x_g_std': ax.std(),
        'accel_x_g_range': ax.max() - ax.min(),
        'accel_x_g_rms': np.sqrt((ax**2).mean()),
        'accel_y_g_std': ay.std(),
        'accel_z_g_std': az.std(),

        # Gyroscope features
        'gyro_x_dps_std': gx.std(),
        'gyro_x_dps_rms': np.sqrt((gx**2).mean()),
        'gyro_x_dps_range': gx.max() - gx.min(),
        'gyro_y_dps_std': gy.std(),
        'gyro_y_dps_rms': np.sqrt((gy**2).mean()),
        'gyro_y_dps_range': gy.max() - gy.min(),
        'gyro_z_dps_std': gz.std(),
        'gyro_z_dps_range': gz.max() - gz.min(),
        'gyro_z_dps_rms': np.sqrt((gz**2).mean()),

        # Vibration features
        'vibration_dps_std': vib.std(),
        'vibration_dps_max': vib.max(),
        'vibration_dps_range': vib.max() - vib.min(),
        'vibration_dps_mean': vib.mean(),
    }
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
            features = extract_features(window)
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