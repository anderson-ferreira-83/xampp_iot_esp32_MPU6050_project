# Projeto IoT MPU6050 - Versão Local (XAMPP)

Este projeto é um sistema completo de monitoramento de vibração para ventiladores industriais, utilizando um ESP32 para coleta de dados e um servidor local XAMPP para processamento e visualização. O diferencial é o uso de **Machine Learning no navegador** para classificar a velocidade do ventilador.

## Visão Geral da Arquitetura Local

O sistema funciona da seguinte forma:
1.  **Hardware (ESP32 + MPU6050)**: Coleta dados de aceleração, giroscópio e temperatura.
2.  **Comunicação (HTTP)**: O ESP32 envia os dados coletados via requisições HTTP POST para um endpoint PHP.
3.  **Backend (XAMPP)**:
    *   **Apache**: Serve como servidor web.
    *   **PHP (`ingest.php`)**: Recebe os dados, realiza uma autenticação baseada em token e armazena os dados em um banco de dados MySQL.
    *   **PHP (`get_data.php`)**: Fornece os dados para o frontend, tanto o último registro quanto o histórico.
    *   **MySQL**: Armazena os dados do sensor.
4.  **Frontend (HTML/CSS/JS)**:
    *   Um dashboard (`index.html`) busca os dados do `get_data.php` em intervalos regulares.
    *   Os dados são exibidos em gráficos dinâmicos (Chart.js).
    *   Um modelo de Machine Learning (Gaussian Naive Bayes) treinado previamente é executado no navegador para classificar o estado do ventilador (LOW, MEDIUM, HIGH) em tempo real.

## Estrutura de Arquivos

O diretório `xampp_iot_mpu_6050` está organizado da seguinte forma:

```
xampp_iot_mpu_6050/
├── api/
│   ├── db_connect.php       # Conexão com o banco de dados MySQL.
│   ├── get_data.php         # API para fornecer dados ao dashboard.
│   └── ingest.php           # API para receber e armazenar dados do sensor.
├── config/
│   └── feature_config.json  # Configuração de features (não utilizado ativamente no XAMPP).
├── css/
│   └── style.css            # Folha de estilo principal do dashboard.
├── database/
│   └── database_setup.sql   # Script SQL para criar a tabela no banco de dados.
├── js/
│   ├── classifier.js        # Lógica do classificador de Machine Learning.
│   └── dashboard.js         # Lógica principal do dashboard (gráficos, chamadas de API).
├── models/
│   └── ...                  # Modelo de Machine Learning em formato JSON.
├── tools/
│   ├── ESP32_HTTP_XAMPP.py  # Firmware MicroPython para o ESP32.
│   └── pc_simulator.py      # Script Python para simular o envio de dados do sensor.
├── index.html               # O arquivo principal do dashboard.
└── README.md                # Este arquivo.
```

## Guia de Instalação e Uso

### 1. Configuração do Ambiente XAMPP
1.  **Instale o XAMPP**: Baixe e instale o XAMPP, garantindo que os componentes Apache e MySQL estejam incluídos.
2.  **Inicie os Serviços**: Abra o painel de controle do XAMPP e inicie os módulos Apache e MySQL.
3.  **Crie o Banco de Dados**:
    *   Abra `http://localhost/phpmyadmin` em seu navegador.
    *   Crie um novo banco de dados chamado `iot_mpu6050`.
    *   Selecione o banco de dados `iot_mpu6050`, vá para a aba "Importar", e importe o arquivo `database/database_setup.sql` para criar a tabela `sensor_data`.
    *   **Nota**: Se você já tinha uma versão anterior da tabela `sensor_data`, será necessário apagá-la (`DROP TABLE sensor_data`) antes de importar o novo arquivo, pois a estrutura foi atualizada para incluir mais dados do sensor.

### 2. Instalação dos Arquivos do Projeto
1.  Navegue até o diretório de instalação do XAMPP (geralmente `C:\xampp\htdocs` no Windows).
2.  Copie toda a pasta `xampp_iot_mpu_6050` para dentro de `htdocs`.
3.  O dashboard estará acessível em `http://localhost/xampp_iot_mpu_6050/`.

### 3. Configuração de Segurança (Bearer Token)
Para proteger o endpoint `ingest.php`, um token de autenticação é necessário.

1.  **Defina um Token Secreto**: Escolha uma string longa e segura. Você pode usar um gerador de senhas para isso.
2.  **Configure no Servidor**: Abra o arquivo `api/ingest.php` e altere o valor da variável `$defined_token`.
    ```php
    $defined_token = "SUA_STRING_SECRETA_AQUI";
    ```
3.  **Configure nos Clientes**: O mesmo token deve ser configurado no firmware do ESP32 e/ou no simulador.
    *   **ESP32**: No arquivo `tools/ESP32_HTTP_XAMPP.py`, altere a variável `AUTH_TOKEN`.
    *   **Simulador**: No arquivo `tools/pc_simulator.py`, altere a variável `AUTH_TOKEN`.

### 4. Configuração do Hardware (ESP32)
1.  Abra o arquivo `tools/ESP32_HTTP_XAMPP.py`.
2.  Configure as credenciais de sua rede Wi-Fi nas variáveis `SSID` e `PASSWORD`.
3.  Altere a variável `SERVER_IP` para o endereço IP do computador que está rodando o XAMPP (no Windows, use o comando `ipconfig` no terminal para descobrir).
4.  Certifique-se de que o `AUTH_TOKEN` corresponde ao que foi definido no passo 3.
5.  Faça o upload do `ESP32_HTTP_XAMPP.py` e do driver `mpu6050.py` (necessário para o sensor) para o seu ESP32.

### 5. Testando com o Simulador (Opcional)
Se não tiver o hardware, você pode simular o envio de dados.
1.  Instale a biblioteca `requests` para Python: `pip install requests`.
2.  Certifique-se de que `AUTH_TOKEN` no arquivo `tools/pc_simulator.py` está correto.
3.  Execute o simulador a partir do diretório raiz do projeto: `python xampp_iot_mpu_6050/tools/pc_simulator.py`.
4.  Abra o dashboard em `http://localhost/xampp_iot_mpu_6050/` para ver os dados simulados chegando.
