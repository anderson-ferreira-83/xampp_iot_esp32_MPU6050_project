<?php
header("Content-Type: application/json");
header("Access-Control-Allow-Origin: *");
header("Access-Control-Allow-Methods: POST, GET");
header("Access-Control-Allow-Headers: Content-Type");

$log_dir = __DIR__ . '/../logs';
$pointer_file = $log_dir . '/ml_transitions_current.txt';

// Determinar arquivo de log ativo
function get_current_log_file($log_dir, $pointer_file) {
    if (file_exists($pointer_file)) {
        $filename = trim(file_get_contents($pointer_file));
        $path = $log_dir . '/' . $filename;
        if (file_exists($path)) {
            return $path;
        }
    }
    return null;
}

function create_new_log_file($log_dir, $pointer_file) {
    $filename = 'ml_transitions_' . date('Ymd_His') . '.json';
    $path = $log_dir . '/' . $filename;
    file_put_contents($path, json_encode([], JSON_PRETTY_PRINT));
    file_put_contents($pointer_file, $filename);
    return $path;
}

// GET: retorna logs existentes (aceita ?action=new para iniciar novo arquivo)
if ($_SERVER['REQUEST_METHOD'] === 'GET') {
    // GET ?action=new  → cria novo arquivo de log com timestamp
    if (isset($_GET['action']) && $_GET['action'] === 'new') {
        $log_file = create_new_log_file($log_dir, $pointer_file);
        echo json_encode(["status" => "ok", "file" => basename($log_file)]);
        exit;
    }

    // GET ?action=list → lista todos os arquivos de log
    if (isset($_GET['action']) && $_GET['action'] === 'list') {
        $files = glob($log_dir . '/ml_transitions_2*.json');
        $result = [];
        foreach ($files as $f) {
            $result[] = [
                "file" => basename($f),
                "size" => filesize($f),
                "entries" => count(json_decode(file_get_contents($f), true) ?: [])
            ];
        }
        // Mais recente primeiro
        usort($result, function($a, $b) { return strcmp($b['file'], $a['file']); });
        echo json_encode($result);
        exit;
    }

    // GET (sem action) → retorna log ativo
    $log_file = get_current_log_file($log_dir, $pointer_file);
    if ($log_file) {
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

// Obter ou criar arquivo de log ativo
$log_file = get_current_log_file($log_dir, $pointer_file);
if (!$log_file) {
    $log_file = create_new_log_file($log_dir, $pointer_file);
}

// Ler logs existentes
$logs = json_decode(file_get_contents($log_file), true) ?: [];

// Adicionar entrada com timestamp do servidor
$entry['server_time'] = date('Y-m-d H:i:s');
$logs[] = $entry;

// Manter últimas 500 transições por arquivo
if (count($logs) > 500) {
    $logs = array_slice($logs, -500);
}

file_put_contents($log_file, json_encode($logs, JSON_PRETTY_PRINT));
echo json_encode(["status" => "ok", "total" => count($logs), "file" => basename($log_file)]);
?>
