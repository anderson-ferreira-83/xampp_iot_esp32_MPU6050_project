<?php
header("Content-Type: application/json");
header("Access-Control-Allow-Origin: *"); // Permitir CORS local
header("Cache-Control: no-cache, no-store, must-revalidate"); // Evitar cache
require_once 'db_connect.php';

// --- Read current config ---
$config_path = 'control_state.json'; // CORREÇÃO: Unificado com set_mode.php
$current_config = ['sample_rate' => 4]; // Default
if (file_exists($config_path)) {
    $loaded_config = json_decode(file_get_contents($config_path), true) ?: [];
    if ($loaded_config && isset($loaded_config['sample_rate'])) {
        $current_config['sample_rate'] = $loaded_config['sample_rate'];
    }
}
// ---

$mode = $_GET['mode'] ?? 'latest';

// MODO LATEST: Retorna apenas o dado mais recente (para cards de tempo real)
if ($mode === 'latest') {
    $sql = "SELECT * FROM sensor_data ORDER BY timestamp DESC LIMIT 1";
    $stmt = $conn->prepare($sql);
    $stmt->execute();
    $result = $stmt->fetch(PDO::FETCH_ASSOC);
    echo json_encode([
        'data' => $result ?: (object)[],
        'config' => $current_config
    ]);

// MODO HISTORY: Retorna uma lista de dados (para desenhar os gráficos)
} elseif ($mode === 'history') {
    // NOVO: Busca por janela de tempo em vez de limite de pontos.
    $seconds = isset($_GET['seconds']) ? (int)$_GET['seconds'] : 30;
    $startTimestamp = microtime(true) - $seconds;

    // A consulta agora filtra por tempo e já ordena crescentemente.
    $sql = "SELECT * FROM sensor_data WHERE timestamp >= :startTimestamp ORDER BY timestamp ASC";
    $stmt = $conn->prepare($sql);
    $stmt->bindParam(':startTimestamp', $startTimestamp, PDO::PARAM_STR);
    $stmt->execute();
    $results = $stmt->fetchAll(PDO::FETCH_ASSOC);
    
    echo json_encode([
        'data' => $results ?: [], // Não precisa mais de array_reverse
        'config' => $current_config
    ]);

} else {
    http_response_code(400);
    echo json_encode(["message" => "Modo inválido"]);
}
?>