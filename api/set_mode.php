<?php
header('Content-Type: application/json');

// --- LÓGICA DE CORS PREFLIGHT ---
// As requisições do frontend com 'Authorization' disparam uma verificação 'OPTIONS' (preflight).
// O servidor precisa responder a essa verificação para que a requisição principal (POST/GET) seja enviada.
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    header("Access-Control-Allow-Origin: *");
    header("Access-Control-Allow-Methods: POST, GET, OPTIONS");
    header("Access-Control-Allow-Headers: Authorization, Content-Type");
    http_response_code(204); // No Content
    exit;
}
header("Access-Control-Allow-Origin: *"); // Para a requisição POST/GET principal

/**
 * 1. TRATAMENTO DE AUTENTICAÇÃO
 * Protege o endpoint para que apenas clientes autorizados possam alterar o modo.
 */
$auth_header = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? '';
$defined_token = "F0xb@m986960440"; // O mesmo token do ingest.php e do ESP32
$token = null;

if (preg_match('/Bearer\s(\S+)/', $auth_header, $matches)) {
    $token = trim($matches[1]);
}

if ($token !== $defined_token) {
    http_response_code(401);
    echo json_encode([
        "status" => "error",
        "message" => "Acesso não autorizado. Token inválido ou ausente."
    ]);
    exit;
}



// Arquivo que armazena o estado de controle (modo e taxa de amostragem)
$state_file = 'control_state.json';

// Valores padrão caso o arquivo de estado não exista
$default_state = [
    'mode' => 'PAUSE',
    'sample_rate' => 4
];

// 1. Carrega o estado atual ou usa o padrão
$current_state = $default_state;
if (file_exists($state_file)) {
    $current_state = json_decode(file_get_contents($state_file), true);
    // Garante que as chaves padrão existam para evitar erros
    $current_state = array_merge($default_state, $current_state);
}

// 2. Processa a requisição POST para atualizar o estado
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $input = json_decode(file_get_contents('php://input'), true);

    if (json_last_error() !== JSON_ERROR_NONE) {
        http_response_code(400);
        echo json_encode(['status' => 'error', 'message' => 'JSON inválido na requisição.']);
        exit;
    }

    // 3. Atualiza o estado com os novos dados recebidos (merge)
    $current_state = array_merge($current_state, $input);

    // 4. Salva o novo estado no arquivo
    file_put_contents($state_file, json_encode($current_state, JSON_PRETTY_PRINT));
}

// 5. Retorna o estado atual (seja ele o recém-atualizado ou o lido do arquivo)
echo json_encode($current_state);

?>