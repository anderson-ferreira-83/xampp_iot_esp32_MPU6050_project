from machine import I2C


class MPU6050():
    def __init__(self, i2c, addr=0x68):
        self.i2c = i2c
        self.addr = addr
        # Inicializa o sensor (acorda do sleep mode)
        self.i2c.writeto(self.addr, bytearray([0x6B, 0]))

    def bytes_toint(self, firstbyte, secondbyte):
        if not firstbyte & 0x80:
            return firstbyte << 8 | secondbyte
        return -(((firstbyte ^ 255) << 8) | (secondbyte ^ 255) + 1)

    @property
    def accel(self):
        raw = self.i2c.readfrom_mem(self.addr, 0x3B, 6)
        ax = self.bytes_toint(raw[0], raw[1]) / 16384.0
        ay = self.bytes_toint(raw[2], raw[3]) / 16384.0
        az = self.bytes_toint(raw[4], raw[5]) / 16384.0
        # Criar um objeto "dummy" para permitir o acesso via .x, .y, .z
        return type('obj', (object,), {'x': ax, 'y': ay, 'z': az})

    @property
    def gyro(self):
        raw = self.i2c.readfrom_mem(self.addr, 0x43, 6)
        gx = self.bytes_toint(raw[0], raw[1]) / 131.0
        gy = self.bytes_toint(raw[2], raw[3]) / 131.0
        gz = self.bytes_toint(raw[4], raw[5]) / 131.0
        return type('obj', (object,), {'x': gx, 'y': gy, 'z': gz})

    @property
    def temperature(self):
        raw = self.i2c.readfrom_mem(self.addr, 0x41, 2)
        temp = self.bytes_toint(raw[0], raw[1])
        return temp / 340.0 + 36.53
