CREATE DATABASE IF NOT EXISTS iot_mpu6050;
USE iot_mpu6050;

-- REMOVE a tabela antiga se ela existir (CUIDADO: Apaga todos os dados!)
DROP TABLE IF EXISTS sensor_data;

-- CRIA a nova tabela com a estrutura correta (timestamp DOUBLE)
CREATE TABLE sensor_data (
    id INT AUTO_INCREMENT PRIMARY KEY,
    device_id VARCHAR(50) NOT NULL,
    timestamp DOUBLE NOT NULL,
    temperature FLOAT,
    vibration FLOAT,
    accel_x_g FLOAT,
    accel_y_g FLOAT,
    accel_z_g FLOAT,
    gyro_x_dps FLOAT,
    gyro_y_dps FLOAT,
    gyro_z_dps FLOAT,
    fan_state VARCHAR(20),
    sample_rate FLOAT DEFAULT 0,
    severity VARCHAR(20) DEFAULT 'NONE',
    message TEXT,
    collection_id VARCHAR(50),
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    INDEX (device_id),
    INDEX (timestamp)
);