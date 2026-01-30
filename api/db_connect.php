<?php
// Configurações do Banco de Dados
$host = 'localhost';
$db_name = 'iot_mpu6050';
$username = 'root';
$password = ''; // Senha padrão do XAMPP é vazia

try {
    $conn = new PDO("mysql:host=$host;dbname=$db_name", $username, $password);
    $conn->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
} catch(PDOException $e) {
    echo "Erro de Conexão: " . $e->getMessage();
    exit;
}
?>