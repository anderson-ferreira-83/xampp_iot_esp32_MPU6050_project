<?php
header('Content-Type: application/json');

// --- LÓGICA DE CORS PREFLIGHT ---
// As requisições do frontend com 'Authorization' disparam uma verificação 'OPTIONS' (preflight).
// O servidor precisa responder a essa verificação para que a requisição principal (POST) seja enviada.
if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    header("Access-Control-Allow-Origin: *");
    header("Access-Control-Allow-Methods: POST, OPTIONS");
    header("Access-Control-Allow-Headers: Authorization, Content-Type");
    http_response_code(204); // No Content
    exit;
}
header("Access-Control-Allow-Origin: *"); // Para a requisição POST principal

require_once 'db_connect.php';

/**
 * 1. TRATAMENTO DE AUTENTICAÇÃO E MÉTODO
 * Protege o endpoint para que apenas clientes autorizados possam resetar o banco.
 * Garante que a requisição seja do tipo POST para evitar acionamento acidental.
 */
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405); // Method Not Allowed
    echo json_encode(['status' => 'error', 'message' => 'Método não permitido. Use POST.']);
    exit;
}

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

/**
 * 2. LÓGICA DE RESET
 */
$sql_file_path = '../database/reset_database.sql';

if (!file_exists($sql_file_path)) {
    http_response_code(500);
    echo json_encode(['status' => 'error', 'message' => 'Arquivo SQL de reset (reset_database.sql) não encontrado no diretório /database.']);
    exit;
}

try {
    // Lê o conteúdo do arquivo SQL
    $sql_script = file_get_contents($sql_file_path);

    // PDO::exec() pode não suportar múltiplas queries. A abordagem segura é executar
    // os comandos essenciais de forma separada.
    // Como a conexão já está no banco de dados correto, executamos DROP e CREATE.
    if (preg_match('/(DROP TABLE.*?);/s', $sql_script, $drop_match) && preg_match('/(CREATE TABLE.*?\);)/s', $sql_script, $create_match)) {
        $conn->exec($drop_match[1]);
        $conn->exec($create_match[1]);
    } else {
        throw new Exception("Não foi possível encontrar os comandos DROP/CREATE TABLE no arquivo SQL.");
    }

    http_response_code(200);
    echo json_encode(['status' => 'success', 'message' => 'Banco de dados resetado com sucesso! A tabela `sensor_data` foi recriada.']);

 } catch (Exception $e) { // Captura PDOException e Exception geral
     http_response_code(500);
     echo json_encode(['status' => 'error', 'message' => 'Erro ao executar o script SQL: ' . $e->getMessage()]);
 }
?>