<?php
header("Content-Type: application/json");
header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: POST, GET");
header("Access-Control-Allow-Headers: Content-Type");

$log_file = __DIR__ . '/../logs/ml_transitions.json';

// GET: retorna logs existentes
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    if (file_exists($log_file)) {
        echo file_get_contents($log_file);
    } else {
        echo json_encode([]);
    }
    exit;
}

// POST: adiciona novo log de transição
$json = file_get_contents('php://input');
$entry = json_decode($json, true);

if (!$entry) {
    http_response_code(400);
    echo json_encode(["message" => "JSON inválido"]);
    exit;
}

// Ler logs existentes
$logs = [];
if (file_exists($log_file)) {
    $logs = json_decode(file_get_contents($log_file), true) ?: [];
}

// Adicionar entrada com timestamp do servidor
$entry['server_time'] = date('Y-m-d H:i:s');
$logs[] = $entry;

// Manter últimas 500 transições
if (count($logs) > 500) {
    $logs = array_slice($logs, -500);
}

file_put_contents($log_file, json_encode($logs, JSON_PRETTY_PRINT));
echo json_encode(["status" => "ok", "total" => count($logs)]);
?>
