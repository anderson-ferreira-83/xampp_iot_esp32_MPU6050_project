<?php
header("Content-Type: application/json");
require_once 'db_connect.php';

$action = $_GET['action'] ?? 'stats';

try {
    if ($action === 'stats') {
        $stmt = $conn->query("SELECT fan_state, COUNT(*) as cnt, MIN(timestamp) as ts_min, MAX(timestamp) as ts_max, COUNT(DISTINCT collection_id) as n_col FROM sensor_data WHERE fan_state IN ('LOW','MEDIUM','HIGH') GROUP BY fan_state");
        $stats = $stmt->fetchAll(PDO::FETCH_ASSOC);

        $stmt2 = $conn->query("SELECT collection_id, fan_state, COUNT(*) as cnt FROM sensor_data WHERE fan_state IN ('LOW','MEDIUM','HIGH') GROUP BY collection_id, fan_state ORDER BY collection_id, fan_state");
        $collections = $stmt2->fetchAll(PDO::FETCH_ASSOC);

        $stmt3 = $conn->query("SELECT COUNT(*) as total FROM sensor_data");
        $total = $stmt3->fetch(PDO::FETCH_ASSOC);

        echo json_encode(['stats' => $stats, 'collections' => $collections, 'total' => $total['total']]);
    }
    elseif ($action === 'export') {
        $stmt = $conn->query("SELECT id, timestamp, temperature, vibration, accel_x_g, accel_y_g, accel_z_g, gyro_x_dps, gyro_y_dps, gyro_z_dps, fan_state, collection_id FROM sensor_data WHERE fan_state IN ('LOW','MEDIUM','HIGH') ORDER BY timestamp ASC");
        $data = $stmt->fetchAll(PDO::FETCH_ASSOC);
        echo json_encode(['data' => $data, 'count' => count($data)]);
    }
} catch (Exception $e) {
    http_response_code(500);
    echo json_encode(['error' => $e->getMessage()]);
}
?>
