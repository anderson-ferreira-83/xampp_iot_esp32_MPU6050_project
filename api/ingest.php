<?php
error_reporting(0); // Desativa avisos do PHP para não quebrar o JSON do ESP32
header("Content-Type: application/json");
require_once 'db_connect.php';

/**
 * 1. TRATAMENTO DE AUTENTICAÇÃO (Correção Erro 401)
 * Verifica se o cliente enviou o Token correto no cabeçalho 'Authorization'.
 */
$auth_header = '';
if (isset($_SERVER['HTTP_AUTHORIZATION'])) {
    $auth_header = $_SERVER['HTTP_AUTHORIZATION'];
} elseif (isset($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) {
    $auth_header = $_SERVER['REDIRECT_HTTP_AUTHORIZATION'];
}

// Token secreto definido no servidor (deve bater com o do ESP32)
$defined_token = "F0xb@m986960440"; 
$token = null;

// Extrai o token da string "Bearer SEU_TOKEN"
if (preg_match('/Bearer\s(\S+)/', $auth_header, $matches)) {
    $token = trim($matches[1]);
}

// Se o token não bater, rejeita a conexão
if ($token !== $defined_token) {
    http_response_code(401);
    echo json_encode([
        "message" => "Acesso não autorizado",
        "debug_info" => "Token não encontrado ou inválido"
    ]);
    exit;
}

/**
 * 2. RECEBIMENTO DE DADOS
 */
// Lê o corpo da requisição (JSON cru)
$json = file_get_contents('php://input');
$data = json_decode($json, true);

if (!$data) {
    http_response_code(400);
    echo json_encode(["message" => "Dados JSON inválidos"]);
    exit;
}

// Extração das variáveis do JSON recebido
$device_id     = $data['device_id'] ?? 'ESP32_Unknown';
$collection_id = $data['collection_id'] ?? 'v5_stream';

// Função auxiliar para calcular severidade
$severity = 'NONE';
$message = 'Operação normal';

/**
 * 4. PERSISTÊNCIA NO BANCO DE DADOS
 */
// Prepara e executa a query SQL para salvar tudo na tabela 'sensor_data'
try {
    $conn->beginTransaction();

    $sql = "INSERT INTO sensor_data 
            (device_id, timestamp, temperature, vibration, accel_x_g, accel_y_g, accel_z_g, gyro_x_dps, gyro_y_dps, gyro_z_dps, fan_state, sample_rate, severity, message, collection_id)
            VALUES (:device_id, :timestamp, :temp, :vib, :ax, :ay, :az, :gx, :gy, :gz, :fan, :rate, :sev, :msg, :col_id)";

    $stmt = $conn->prepare($sql);

    // Verifica se é um lote (batch) ou dado único
    $items = [];
    if (isset($data['batch']) && is_array($data['batch'])) {
        $items = $data['batch'];
    } else {
        // Converte dado único para formato de lista para reusar a lógica
        $items[] = $data;
    }

    // Lógica de Correção de Tempo para Lotes
    // Se o último item tiver data antiga (ex: 2000), calculamos o offset para alinhar com o servidor
    $time_offset = 0;
    if (!empty($items)) {
        $last_item = end($items);
        $last_ts = $last_item['timestamp'] ?? 0;
        if ($last_ts < 1609459200) { // < 01/01/2021
            $server_time = microtime(true);
            $time_offset = $server_time - $last_ts;
        }
    }

    // Calcula intervalo entre amostras para distribuir timestamps únicos
    $sample_rate = $data['sample_rate'] ?? $items[0]['sample_rate'] ?? 5;
    $sample_interval = 1.0 / max(1, $sample_rate); // 0.2s para 5Hz
    $batch_count = count($items);

    foreach ($items as $idx => $item) {
        // Aplica correção de tempo + offset sequencial dentro do batch
        // Cada amostra recebe timestamp único: base + (idx * intervalo)
        $base_ts = ($item['timestamp'] ?? 0) + $time_offset;
        $ts = $base_ts + ($idx * $sample_interval);
        
        // Recalcula severidade para cada ponto
        $temp = $item['temperature'] ?? 0;
        $vib = $item['vibration'] ?? 0;
        
        $sev = 'NONE';
        $msg = 'Operação normal';
        if ($temp > 40.0) { $sev = 'HIGH'; $msg = 'CRITICO: Temperatura muito alta!'; }
        elseif ($temp > 35.0) { $sev = 'MEDIUM'; $msg = 'ALERTA: Temperatura elevada'; }
        if ($vib > 1200 && $sev != 'HIGH') { $sev = 'MEDIUM'; $msg = 'ALERTA: Vibração excessiva'; }

        $stmt->bindValue(':device_id', $device_id);
        $stmt->bindValue(':timestamp', $ts);
        $stmt->bindValue(':temp', $temp);
        $stmt->bindValue(':vib', $vib);
        $stmt->bindValue(':ax', $item['accel_x_g'] ?? 0);
        $stmt->bindValue(':ay', $item['accel_y_g'] ?? 0);
        $stmt->bindValue(':az', $item['accel_z_g'] ?? 0);
        $stmt->bindValue(':gx', $item['gyro_x_dps'] ?? 0);
        $stmt->bindValue(':gy', $item['gyro_y_dps'] ?? 0);
        $stmt->bindValue(':gz', $item['gyro_z_dps'] ?? 0);
        $stmt->bindValue(':fan', $item['fan_state'] ?? 'RAW');
        $stmt->bindValue(':rate', $item['sample_rate'] ?? 4); // Valor padrão 4 se não enviado
        $stmt->bindValue(':sev', $sev);
        $stmt->bindValue(':msg', $msg);
        $stmt->bindValue(':col_id', $collection_id);
        
        $stmt->execute();
        
        // Guarda a última severidade para retornar na resposta
        $severity = $sev;
    }

    $conn->commit();

    // LER MODO DESEJADO (COMANDO PARA O ESP32)
    $target_mode = 'PAUSE'; // Padrão alterado para PAUSE
    $target_rate = 4;
    $config_path = 'control_state.json'; // CORREÇÃO: Unificado com set_mode.php
    if (file_exists($config_path)) {
        $conf = json_decode(file_get_contents($config_path), true) ?: [];
        $target_mode = $conf['mode'] ?? 'PAUSE';
        $target_rate = $conf['sample_rate'] ?? 4;
    }

    echo json_encode(["status" => "success", "severity" => $severity, "target_mode" => $target_mode, "target_rate" => $target_rate, "count" => count($items)]);

} catch (Exception $e) {
    if ($conn->inTransaction()) $conn->rollBack();
    http_response_code(500);
    echo json_encode(["message" => "Erro ao salvar dados", "error" => $e->getMessage()]);
}
?>