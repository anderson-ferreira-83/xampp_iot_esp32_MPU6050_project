import json
import time

import machine  # Biblioteca para controle de hardware (pinos, I2C)
import network  # Biblioteca para conexão Wi-Fi
import urequests  # Biblioteca para fazer requisições HTTP (POST)
from mpu6050 import MPU6050  # Driver do sensor acelerômetro/giroscópio

# --- CONFIGURAÇÕES ---
# Credenciais da rede Wi-Fi
SSID = "Dersao83"
PASSWORD = "986960440"

# IP do servidor XAMPP
SERVER_IP = "192.168.0.104" 
API_URL = f"http://{SERVER_IP}/xampp_iot_mpu_6050/api/ingest.php"

# Token de segurança (deve ser igual ao do arquivo ingest.php)
AUTH_TOKEN = "F0xb@m986960440" 

DEVICE_ID = "ESP32_FAN_V5"  # Identificador da Versão 5
SAMPLE_INTERVAL = 0.25      # Valor inicial (4Hz) para segurança
BATCH_SIZE = 4              # Envia 4 amostras por vez

# --- CONFIGURAÇÃO DE COLETA (IMPORTANTE) ---
# Altere esta variável para "LOW", "MEDIUM" ou "HIGH" quando estiver coletando dados para TREINAMENTO.
# Use "RAW" para operação normal (o dashboard fará a classificação via ML).
CURRENT_FAN_STATE = "PAUSE"

# --- SETUP SENSOR ---
# Configura a comunicação I2C nos pinos 22 (SCL) e 21 (SDA)
i2c = machine.I2C(0, scl=machine.Pin(22), sda=machine.Pin(21))
mpu = MPU6050(i2c) # Inicializa o objeto do sensor

def main_loop():
    global CURRENT_FAN_STATE # Permite alterar a variável globalmente
    global SAMPLE_INTERVAL, BATCH_SIZE
    wlan = network.WLAN(network.STA_IF) # Interface de estação (cliente Wi-Fi)
    
    if not wlan.isconnected():
        print("!!! FALHA NA CONEXÃO WI-FI !!!")
        print("O boot.py não conectou. Reiniciando o ESP32...")
        time.sleep(5)
        machine.reset()

    print(f"WiFi conectado ({wlan.ifconfig()[0]}).")
    print("Iniciando Transmissão de Dados Brutos para Modelo v5...")
    
    batch_buffer = []
    while True:
        try:
            # 1. Leitura dos dados brutos do sensor MPU6050
            accel = mpu.accel
            gyro = mpu.gyro
            temp = mpu.temperature
            
            # Cálculo simples da vibração total (soma absoluta dos eixos do giroscópio)
            # Usado apenas para debug visual no console, não afeta o ML
            vibration = abs(gyro.x) + abs(gyro.y) + abs(gyro.z)

            # 2. Montar o pacote de dados (JSON) para enviar ao servidor
            data_point = {
                "timestamp": time.time() + 946684800,
                "temperature": temp,
                "vibration": vibration,
                "accel_x_g": accel.x,
                "accel_y_g": accel.y,
                "accel_z_g": accel.z,
                "gyro_x_dps": gyro.x,
                "gyro_y_dps": gyro.y,
                "gyro_z_dps": gyro.z,
                "fan_state": CURRENT_FAN_STATE,
                "sample_rate": BATCH_SIZE # Batch size = Hz (já que enviamos 1x por seg)
            }
            
            batch_buffer.append(data_point)
            
            # 3. Verifica se o lote está cheio
            if len(batch_buffer) >= BATCH_SIZE:
                payload = {
                    "device_id": DEVICE_ID,
                    "collection_id": "v5_stream",
                    "batch": batch_buffer
                }
                
                headers = {
                    'Content-Type': 'application/json',
                    'Authorization': f'Bearer {AUTH_TOKEN}'
                }

                print(f"Enviando lote ({len(batch_buffer)}) [{CURRENT_FAN_STATE}]: Temp={temp:.1f}...", end="")
                
                # 4. Envio dos dados via requisição POST
                response = urequests.post(API_URL, data=json.dumps(payload), headers=headers)
                
                if response.status_code == 200:
                    print(" OK", end="")
                    try:
                        resp_json = response.json()
                        if 'target_mode' in resp_json:
                            server_mode = resp_json['target_mode']
                            if server_mode != CURRENT_FAN_STATE:
                                print(f"\n[COMANDO] Alterando modo: {CURRENT_FAN_STATE} -> {server_mode}")
                                CURRENT_FAN_STATE = server_mode
                        
                        if 'target_rate' in resp_json:
                            new_rate = int(resp_json['target_rate'])
                            # Só atualiza e avisa se a taxa for diferente da atual
                            if new_rate > 0 and new_rate != BATCH_SIZE:
                                SAMPLE_INTERVAL = 1.0 / new_rate
                                BATCH_SIZE = new_rate # Mantém envio a cada ~1s
                                print(f" [RATE] Ajustado para {new_rate}Hz")
                    except ValueError:
                        print(" [!] Erro JSON")
                    except Exception as e:
                        print(f" [!] Erro: {e}")
                    print("")
                else:
                    print(f" Erro {response.status_code}")
                
                response.close()
                batch_buffer = [] # Limpa o buffer
            
        except Exception as e:
            print(f"\nErro no loop: {e}")
            time.sleep(2)
            
        # Aguarda o intervalo definido antes da próxima leitura (0.25s)
        time.sleep(SAMPLE_INTERVAL)

if __name__ == "__main__":
    main_loop()