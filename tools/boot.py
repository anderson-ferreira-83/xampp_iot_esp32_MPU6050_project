# boot.py
# Este arquivo é executado na inicialização do dispositivo.
# Ele é responsável por conectar o ESP32 à rede Wi-Fi antes de rodar o programa principal.

import time

import network

# --- CONFIGURAÇÕES DE REDE ---
# Credenciais da rede Wi-Fi
SSID = "Dersao83"
PASSWORD = "986960440"

def connect_wifi():
    """Conecta o dispositivo à rede Wi-Fi especificada."""
    # Desativa o ponto de acesso para economizar energia e por segurança
    ap_if = network.WLAN(network.AP_IF)
    ap_if.active(False)
    
    # Ativa a interface de estação (modo cliente, para conectar no roteador)
    sta_if = network.WLAN(network.STA_IF)
    sta_if.active(True)
    
    if not sta_if.isconnected():
        print('Conectando ao Wi-Fi...')
        sta_if.connect(SSID, PASSWORD)
        
        # Loop de espera: tenta conectar por até 15 segundos
        max_wait = 15  # Segundos
        while not sta_if.isconnected() and max_wait > 0:
            print('.')
            time.sleep(1)
            max_wait -= 1

    if sta_if.isconnected():
        print('\nWiFi Conectado!')
        print('Configurações de rede:', sta_if.ifconfig())
    else:
        print('\nFalha ao conectar ao WiFi.')

# --- EXECUÇÃO ---
connect_wifi()

# --- INICIAR SCRIPT PRINCIPAL ---
# Se conectou com sucesso, chama o main.py para iniciar a leitura do sensor
sta_if = network.WLAN(network.STA_IF)
if sta_if.isconnected():
    print("Executando main.py a partir do boot.py...")
    import main
else:
    print("Falha ao iniciar main.py: sem conexão Wi-Fi.")
