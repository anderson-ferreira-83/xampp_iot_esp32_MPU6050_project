const CONFIG = {
  // Endpoints da API PHP
  API_ENDPOINT: 'api/get_data.php?mode=latest',
  HISTORY_ENDPOINT: 'api/get_data.php',
  HISTORY_SECONDS: 60,      // Janela de tempo inicial para o histórico (em segundos)
  REALTIME_WINDOW_SECONDS: 5, // Janela para atualizações em tempo real
  UPDATE_INTERVAL: 250,     // pull a cada 250ms (4Hz)
  MAX_POINTS: 7200,
  TIME_RANGE: 'all',
  OFFLINE_AFTER_MS: 10000,  // v4.1: Reduzido para 10s
  GAP_THRESHOLD_MS: 2000,   // Quebra a linha quando houver buracos maiores que 2s
};

const G_TO_MS2 = 1; // Alterado para 1 para exibir em 'g' (igual ao banco de dados)

// Cache local para armazenar os dados recebidos e evitar requisições repetidas
const cache = [];
const alerts = [];
let lastDataTs = null;
let mlDataOnline = null;
let mlErrorState = null;
let latestFetchInFlight = false;
let lastMLFeedTs = null;
let lastMLFeedCounter = null;
let lastFetchAt = null;
let lastSeenCounter = null;
let lastSampleTs = null;

// Variáveis de Controle de Playback (Pausa/Navegação)
let isPaused = false;
let pauseSnapshot = null;
let viewOffsetMs = 0;
let dataFetchIntervalId = null;
let currentDashboardRateHz = 1000 / CONFIG.UPDATE_INTERVAL;

function formatTimeLabel(ts) {
  if (!Number.isFinite(ts)) return '';
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('pt-BR');
}

function formatRelativeTimeLabel(ts) {
  const now = isPaused && pauseSnapshot ? pauseSnapshot : getNow();
  const diff = (ts - now) / 1000;
  return diff.toFixed(1) + 's';
}

function formatDateTimeLabel(ts) {
  if (!Number.isFinite(ts)) return '';
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('pt-BR');
}

function getNow() {
  return Date.now();
}

// Converte timestamps variados (strings SQL, segundos, ms) para milissegundos numéricos
function normalizeTimestampMs(raw, fallback = null) {
  if (raw === undefined || raw === null || raw === '') {
    return fallback;
  }
  const num = Number(raw);
  if (!Number.isFinite(num)) {
    // Tenta interpretar string de data do MySQL (ex: "2026-01-29 14:30:00")
    const date = new Date(raw);
    if (!Number.isNaN(date.getTime())) {
      return date.getTime();
    }
    return fallback;
  }
  if (num >= 1e12) {
    return Math.floor(num);
  }
  if (num >= 1e9) {
    return Math.floor(num * 1000);
  }
  return Math.floor(num * 1000);
}

// Padroniza o objeto de dados recebido da API
function normalizePayload(payload) {
  const rawTs = payload.timestamp_ms ?? payload.timestamp ?? payload.timestamp_s ?? payload.ts;
  const ts = normalizeTimestampMs(rawTs, getNow());
  return {
    ts,
    counter: payload.contador != null ? Number(payload.contador) : (payload.counter != null ? Number(payload.counter) : null),
    temperature: Number(payload.temperature || 0),
    vibration: Number(payload.vibration || 0),
    vibration_dps: payload.vibration_dps != null ? Number(payload.vibration_dps) : null,
    accel_x_g: Number(payload.accel_x_g || 0),
    accel_y_g: Number(payload.accel_y_g || 0),
    accel_z_g: Number(payload.accel_z_g || 0),
    gyro_x_dps: Number(payload.gyro_x_dps || 0),
    gyro_y_dps: Number(payload.gyro_y_dps || 0),
    gyro_z_dps: Number(payload.gyro_z_dps || 0),
    mode: payload.mode || payload.sample_mode || payload.data_mode || payload.stream_mode || '',
    feature_window: payload.feature_window_samples != null
      ? Number(payload.feature_window_samples)
      : (payload.feature_window != null ? Number(payload.feature_window) : null),
    accel_x_g_std: payload.accel_x_g_std != null ? Number(payload.accel_x_g_std) : null,
    accel_x_g_range: payload.accel_x_g_range != null ? Number(payload.accel_x_g_range) : null,
    accel_x_g_rms: payload.accel_x_g_rms != null ? Number(payload.accel_x_g_rms) : null,
    gyro_y_dps_std: payload.gyro_y_dps_std != null ? Number(payload.gyro_y_dps_std) : null,
    gyro_y_dps_rms: payload.gyro_y_dps_rms != null ? Number(payload.gyro_y_dps_rms) : null,
    gyro_y_dps_range: payload.gyro_y_dps_range != null ? Number(payload.gyro_y_dps_range) : null,
    collection_id: payload.collection_id || '',
    phase_marker: payload.phase_marker === true || payload.phase_marker === 'true',
    fan_state: payload.fan_state || 'UNKNOWN',
    severity: payload.severity || 'NONE',
    message: payload.message || 'Sistema normal',
  };
}

// Adiciona dados ao cache, evitando duplicatas
function pushCache(item) {
  const last = cache[cache.length - 1];
  if (last) {
    const hasCounter = Number.isFinite(last.counter) && Number.isFinite(item.counter);
    if (hasCounter && last.counter === item.counter) {
      return;
    }
    if (!hasCounter && last.ts === item.ts) {
      return;
    }
  }
  if (last && last.ts === item.ts && !Number.isFinite(item.counter)) {
    return;
  }
  cache.push(item);
  if (cache.length > CONFIG.MAX_POINTS) {
    cache.shift();
  }
}

// Calcula o início e fim do eixo X do gráfico (Janela Deslizante)
function getWindowLimits() {
  const anchor = isPaused ? pauseSnapshot : getNow();
  const end = anchor - viewOffsetMs;

  if (CONFIG.TIME_RANGE === 'all') {
    return { start: null, end };
  }

  let delta = 0;
  if (CONFIG.TIME_RANGE === '30s') delta = 30 * 1000;
  if (CONFIG.TIME_RANGE === '1m') delta = 60 * 1000;
  if (CONFIG.TIME_RANGE === '5m') delta = 5 * 60 * 1000;
  if (CONFIG.TIME_RANGE === '10m') delta = 10 * 60 * 1000;
  if (CONFIG.TIME_RANGE === '1h') delta = 60 * 60 * 1000;
  if (CONFIG.TIME_RANGE === '6h') delta = 6 * 60 * 60 * 1000;

  return { start: end - delta, end };
}

// Remove dados inválidos ou muito futuros do array de plotagem
function sanitizeSeries(data) {
  const now = getNow();
  const maxFuture = now + 5 * 60 * 1000; // tolerância 5 min
  const sorted = data
    .filter(item => Number.isFinite(item.ts) && item.ts > 0 && item.ts <= maxFuture)
    .slice()
    .sort((a, b) => a.ts - b.ts);

  const deduped = [];
  let lastTs = null;
  for (const item of sorted) {
    if (item.ts === lastTs) continue;
    deduped.push(item);
    lastTs = item.ts;
  }
  return deduped;
}

// Atualiza o badge de status (Online/Offline)
function updateStatus(isOnline) {
  const badge = document.getElementById('statusBadge');
  if (isOnline) {
    badge.className = 'status-badge status-online';
    badge.innerHTML = '<span class="pulse"></span>Online';
  } else {
    badge.className = 'status-badge status-offline';
    badge.innerHTML = '<span class="pulse"></span>Offline';
  }
  setMLDataOnline(isOnline);
}

function isFresh() {
  if (lastSampleTs == null) return false;
  const now = getNow();
  return now - lastSampleTs <= CONFIG.OFFLINE_AFTER_MS;
}

// Atualiza os valores numéricos nos cartões (Temperatura, Vibração, etc.)
function updateCards(latest) {
  const temp = latest.temperature;
  const vib = latest.vibration_dps != null ? latest.vibration_dps : latest.vibration;
  const accelX = latest.accel_x_g * G_TO_MS2;
  const accelY = latest.accel_y_g * G_TO_MS2;
  const accelZ = latest.accel_z_g * G_TO_MS2;
  const accelMag = Math.sqrt(
    accelX ** 2 +
    accelY ** 2 +
    accelZ ** 2
  );
  const gyroMag = Math.sqrt(
    latest.gyro_x_dps ** 2 +
    latest.gyro_y_dps ** 2 +
    latest.gyro_z_dps ** 2
  );

  document.getElementById('tempValue').textContent = temp.toFixed(1);
  const accelAxisXEl = document.getElementById('accelAxisX');
  if (accelAxisXEl) {
    accelAxisXEl.textContent = `Mag=${accelMag.toFixed(2)} g`;
    if (document.getElementById('accelAxisY')) document.getElementById('accelAxisY').textContent = '';
    if (document.getElementById('accelAxisZ')) document.getElementById('accelAxisZ').textContent = '';
  }

  const gyroAxisXEl = document.getElementById('gyroAxisX');
  if (gyroAxisXEl) {
    gyroAxisXEl.textContent = `Mag=${gyroMag.toFixed(2)} dps`;
    if (document.getElementById('gyroAxisY')) document.getElementById('gyroAxisY').textContent = '';
    if (document.getElementById('gyroAxisZ')) document.getElementById('gyroAxisZ').textContent = '';
  }

  document.getElementById('tempProgress').style.width = Math.min(100, (temp / 50) * 100) + '%';
  document.getElementById('accelMagProgress').style.width = Math.min(100, (accelMag / 40) * 100) + '%';
  document.getElementById('gyroMagProgress').style.width = Math.min(100, (gyroMag / 500) * 100) + '%';

  // Update payload summary (column layout)
  const timestampEl = document.getElementById('lastPayloadTimestamp');
  const tempEl = document.getElementById('lastPayloadTemp');
  const vibEl = document.getElementById('lastPayloadVib');
  if (timestampEl) timestampEl.textContent = new Date(latest.ts).toLocaleString('pt-BR');
  if (tempEl) tempEl.textContent = `T=${temp.toFixed(1)}°C`;
  if (vibEl) vibEl.textContent = `Vib=${vib.toFixed(2)} dps`;

  // Fallback for old single-line element
  const summaryEl = document.getElementById('lastPayloadSummary');
  if (summaryEl) {
    summaryEl.textContent = `${payloadTime} | T=${temp.toFixed(1)}°C | Vib=${vib.toFixed(2)} dps`;
  }

  // Update acceleration axes (column layout)
  const axEl = document.getElementById('lastPayloadAX');
  const ayEl = document.getElementById('lastPayloadAY');
  const azEl = document.getElementById('lastPayloadAZ');
  if (axEl) axEl.textContent = `AX=${accelX.toFixed(2)} g`;
  if (ayEl) ayEl.textContent = `AY=${accelY.toFixed(2)} g`;
  if (azEl) azEl.textContent = `AZ=${accelZ.toFixed(2)} g`;

  // Fallback for old single-line element
  const accelEl = document.getElementById('lastPayloadAccel');
  if (accelEl) {
    accelEl.textContent = `AX=${accelX.toFixed(2)} g | AY=${accelY.toFixed(2)} g | AZ=${accelZ.toFixed(2)} g`;
  }

  // Update gyroscope axes (column layout)
  const gxEl = document.getElementById('lastPayloadGX');
  const gyEl = document.getElementById('lastPayloadGY');
  const gzEl = document.getElementById('lastPayloadGZ');
  if (gxEl) gxEl.textContent = `GX=${latest.gyro_x_dps.toFixed(3)} dps`;
  if (gyEl) gyEl.textContent = `GY=${latest.gyro_y_dps.toFixed(3)} dps`;
  if (gzEl) gzEl.textContent = `GZ=${latest.gyro_z_dps.toFixed(3)} dps`;

  // Fallback for old single-line element
  const gyroEl = document.getElementById('lastPayloadGyro');
  if (gyroEl) {
    gyroEl.textContent = `GX=${latest.gyro_x_dps.toFixed(3)} dps | GY=${latest.gyro_y_dps.toFixed(3)} dps | GZ=${latest.gyro_z_dps.toFixed(3)} dps`;
  }
}

function updateCardTimers() {
  if (lastSampleTs == null) return;
  const now = Date.now();
  const diff = (now - lastSampleTs) / 1000;
  const date = new Date(lastSampleTs);
  const text = date.toLocaleTimeString('pt-BR');

  document.querySelectorAll('.chart-timer').forEach(el => {
    el.textContent = text;
    if (diff > 2.0) el.style.color = '#ff5252';
    else el.style.color = 'rgba(255, 255, 255, 0.4)';
  });
}

function updateAlerts(latest) {
  if (!latest || latest.severity === 'NONE') {
    return;
  }
  alerts.unshift({
    severity: latest.severity,
    message: latest.message,
    time: new Date(latest.ts),
  });
  if (alerts.length > 10) {
    alerts.pop();
  }
  renderAlerts();
}

function renderAlerts() {
  const el = document.getElementById('alertsList');
  if (alerts.length === 0) {
    el.innerHTML = '<div class="card-unit">Nenhum alerta ainda.</div>';
    return;
  }
  el.innerHTML = alerts.map(alert => {
    return `
      <div class="alert-item severity-${alert.severity.toLowerCase()}">
        <div><strong>${alert.severity}</strong>: ${alert.message}</div>
        <div>${alert.time.toLocaleTimeString('pt-BR')}</div>
      </div>
    `;
  }).join('');
}

function calcMean(values) {
  if (!values.length) return 0;
  return values.reduce((acc, v) => acc + v, 0) / values.length;
}

function calcStd(values) {
  if (!values.length) return 0;
  const mean = calcMean(values);
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function calcMin(values) {
  return values.length ? Math.min(...values) : 0;
}

function calcMax(values) {
  return values.length ? Math.max(...values) : 0;
}

function updateMetrics(data) {
  const accelX = data.map(item => item.accel_x_g * G_TO_MS2);
  const accelY = data.map(item => item.accel_y_g * G_TO_MS2);
  const accelZ = data.map(item => item.accel_z_g * G_TO_MS2);
  const gyroX = data.map(item => item.gyro_x_dps);
  const gyroY = data.map(item => item.gyro_y_dps);
  const gyroZ = data.map(item => item.gyro_z_dps);

  document.getElementById('accelMeanX').textContent = calcMean(accelX).toFixed(3);
  document.getElementById('accelMeanY').textContent = calcMean(accelY).toFixed(3);
  document.getElementById('accelMeanZ').textContent = calcMean(accelZ).toFixed(3);
  document.getElementById('accelMinX').textContent = calcMin(accelX).toFixed(3);
  document.getElementById('accelMaxX').textContent = calcMax(accelX).toFixed(3);
  document.getElementById('accelStdX').textContent = calcStd(accelX).toFixed(3);

  document.getElementById('gyroMeanX').textContent = calcMean(gyroX).toFixed(3);
  document.getElementById('gyroMeanY').textContent = calcMean(gyroY).toFixed(3);
  document.getElementById('gyroMeanZ').textContent = calcMean(gyroZ).toFixed(3);
  document.getElementById('gyroMinX').textContent = calcMin(gyroX).toFixed(3);
  document.getElementById('gyroMaxX').textContent = calcMax(gyroX).toFixed(3);
  document.getElementById('gyroStdX').textContent = calcStd(gyroX).toFixed(3);
}

function resetMetrics() {
  document.getElementById('accelMeanX').textContent = '--';
  document.getElementById('accelMeanY').textContent = '--';
  document.getElementById('accelMeanZ').textContent = '--';
  document.getElementById('accelMinX').textContent = '--';
  document.getElementById('accelMaxX').textContent = '--';
  document.getElementById('accelStdX').textContent = '--';

  document.getElementById('gyroMeanX').textContent = '--';
  document.getElementById('gyroMeanY').textContent = '--';
  document.getElementById('gyroMeanZ').textContent = '--';
  document.getElementById('gyroMinX').textContent = '--';
  document.getElementById('gyroMaxX').textContent = '--';
  document.getElementById('gyroStdX').textContent = '--';
}

function mapSeries(data, valueFn) {
  return data.map(item => ({ x: item.ts, y: valueFn(item) }));
}

// Configuração genérica para criar gráficos com Chart.js
function setupChart(ctx, label, color, minSpan, fixedMin, fixedMax) {
  return new Chart(ctx, {
    type: 'line',
    data: {
      datasets: [{
        label: label,
        data: [],
        borderColor: color,
        backgroundColor: color + '22',
        borderWidth: 2,
        tension: 0,
        fill: true,
        pointRadius: 2,
        pointHoverRadius: 4,
        spanGaps: CONFIG.GAP_THRESHOLD_MS,
      }],
    },
    options: {
      parsing: false,
      normalized: true,
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#0f172a' } },
        tooltip: {
          callbacks: {
            title: (items) => {
              if (!items || !items.length) return '';
              return formatDateTimeLabel(items[0].parsed.x);
            },
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          ticks: {
            color: '#64748b',
            maxRotation: 0,
            autoSkip: true,
            callback: (value) => formatRelativeTimeLabel(value),
          },
          grid: { color: 'rgba(148,163,184,0.2)' },
        },
        y: { ticks: { color: '#64748b' }, grid: { color: 'rgba(148,163,184,0.2)' }, minSpan: minSpan || 0, fixedMin: fixedMin, fixedMax: fixedMax },
      },
    },
  });
}

function setupMultiChart(ctx, labels, colors, minSpan, fixedMin, fixedMax) {
  return new Chart(ctx, {
    type: 'line',
    data: {
      datasets: labels.map((label, idx) => ({
        label: label,
        data: [],
        borderColor: colors[idx],
        backgroundColor: colors[idx] + '22',
        borderWidth: 2,
        tension: 0,
        fill: true,
        pointRadius: 2,
        pointHoverRadius: 4,
        spanGaps: CONFIG.GAP_THRESHOLD_MS,
      })),
    },
    options: {
      parsing: false,
      normalized: true,
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#0f172a' } },
        tooltip: {
          callbacks: {
            title: (items) => {
              if (!items || !items.length) return '';
              return formatDateTimeLabel(items[0].parsed.x);
            },
          },
        },
      },
      scales: {
        x: {
          type: 'linear',
          ticks: {
            color: '#64748b',
            maxRotation: 0,
            autoSkip: true,
            callback: (value) => formatRelativeTimeLabel(value),
          },
          grid: { color: 'rgba(148,163,184,0.2)' },
        },
        y: { ticks: { color: '#64748b' }, grid: { color: 'rgba(148,163,184,0.2)' }, minSpan: minSpan || 0, fixedMin: fixedMin, fixedMax: fixedMax },
      },
    },
  });
}

const tempChart = setupChart(document.getElementById('tempChart').getContext('2d'), 'Temperatura (°C)', '#f97316', 5, 0, 60);
const accelChart = setupMultiChart(document.getElementById('accelChart').getContext('2d'), ['Accel X', 'Accel Y', 'Accel Z'], ['#ef4444', '#22c55e', '#3b82f6'], 0.5, -2, 2);
const gyroChart = setupMultiChart(document.getElementById('gyroChart').getContext('2d'), ['Gyro X', 'Gyro Y', 'Gyro Z'], ['#f59e0b', '#8b5cf6', '#06b6d4'], 5, -250, 250);
const vibrationChart = setupChart(document.getElementById('vibrationChart').getContext('2d'), 'Vibracao (dps)', '#0ea5e9', 5, 0, 3000);

const accelXChart = setupChart(document.getElementById('accelXChart').getContext('2d'), 'Accel X (g)', '#ef4444', 0.5, -2, 2);
const accelYChart = setupChart(document.getElementById('accelYChart').getContext('2d'), 'Accel Y (g)', '#22c55e', 0.5, -2, 2);
const accelZChart = setupChart(document.getElementById('accelZChart').getContext('2d'), 'Accel Z (g)', '#3b82f6', 0.5, -2, 2);

const gyroXChart = setupChart(document.getElementById('gyroXChart').getContext('2d'), 'Gyro X (dps)', '#f59e0b', 5, -250, 250);
const gyroYChart = setupChart(document.getElementById('gyroYChart').getContext('2d'), 'Gyro Y (dps)', '#8b5cf6', 5, -250, 250);
const gyroZChart = setupChart(document.getElementById('gyroZChart').getContext('2d'), 'Gyro Z (dps)', '#06b6d4', 5, -250, 250);

const chartScaleOverrides = {};

function setAutoScale(chart, values, chartKey) {
  if (!values.length) {
    return;
  }
  let min = Math.min(...values);
  let max = Math.max(...values);
  let span = max - min;
  const minSpan = chartKey && chartScaleOverrides[chartKey] != null ? chartScaleOverrides[chartKey] : (chart.options.scales.y.minSpan || 0);
  if (span < minSpan) {
    const mid = (max + min) / 2;
    min = mid - minSpan / 2;
    max = mid + minSpan / 2;
    span = minSpan;
  }
  const pad = Math.max(0.05, span * 0.1);
  chart.options.scales.y.min = min - pad;
  chart.options.scales.y.max = max + pad;
}

// Atualiza os dados dentro dos objetos Chart.js
function refreshCharts(filtered, limits) {
  const temps = filtered.map(item => item.temperature);
  const accelX = filtered.map(item => item.accel_x_g * G_TO_MS2);
  const accelY = filtered.map(item => item.accel_y_g * G_TO_MS2);
  const accelZ = filtered.map(item => item.accel_z_g * G_TO_MS2);
  const gyroX = filtered.map(item => item.gyro_x_dps);
  const gyroY = filtered.map(item => item.gyro_y_dps);
  const gyroZ = filtered.map(item => item.gyro_z_dps);
  const vibration = filtered.map(item => item.vibration_dps != null ? item.vibration_dps : item.vibration);

  // Aplica os limites do eixo X (zoom/scroll) em todos os gráficos
  const charts = [tempChart, accelChart, gyroChart, vibrationChart, accelXChart, accelYChart, accelZChart, gyroXChart, gyroYChart, gyroZChart];
  charts.forEach(chart => {
    if (limits && limits.start !== null) {
      chart.options.scales.x.min = limits.start;
      chart.options.scales.x.max = limits.end;
    } else {
      delete chart.options.scales.x.min;
      delete chart.options.scales.x.max;
    }
  });

  tempChart.data.datasets[0].data = mapSeries(filtered, item => item.temperature);
  setAutoScale(tempChart, temps, 'temp');
  tempChart.update('none');

  accelChart.data.datasets[0].data = mapSeries(filtered, item => item.accel_x_g * G_TO_MS2);
  accelChart.data.datasets[1].data = mapSeries(filtered, item => item.accel_y_g * G_TO_MS2);
  accelChart.data.datasets[2].data = mapSeries(filtered, item => item.accel_z_g * G_TO_MS2);
  setAutoScale(accelChart, [...accelX, ...accelY, ...accelZ], 'accel');
  accelChart.update('none');

  gyroChart.data.datasets[0].data = mapSeries(filtered, item => item.gyro_x_dps);
  gyroChart.data.datasets[1].data = mapSeries(filtered, item => item.gyro_y_dps);
  gyroChart.data.datasets[2].data = mapSeries(filtered, item => item.gyro_z_dps);
  setAutoScale(gyroChart, [...gyroX, ...gyroY, ...gyroZ], 'gyro');
  gyroChart.update('none');

  vibrationChart.data.datasets[0].data = mapSeries(filtered, item => item.vibration_dps != null ? item.vibration_dps : item.vibration);
  setAutoScale(vibrationChart, vibration, 'vibration');
  vibrationChart.update('none');

  accelXChart.data.datasets[0].data = mapSeries(filtered, item => item.accel_x_g * G_TO_MS2);
  setAutoScale(accelXChart, accelX, 'accelX');
  accelXChart.update('none');

  accelYChart.data.datasets[0].data = mapSeries(filtered, item => item.accel_y_g * G_TO_MS2);
  setAutoScale(accelYChart, accelY, 'accelY');
  accelYChart.update('none');

  accelZChart.data.datasets[0].data = mapSeries(filtered, item => item.accel_z_g * G_TO_MS2);
  setAutoScale(accelZChart, accelZ, 'accelZ');
  accelZChart.update('none');

  gyroXChart.data.datasets[0].data = mapSeries(filtered, item => item.gyro_x_dps);
  setAutoScale(gyroXChart, gyroX, 'gyroX');
  gyroXChart.update('none');

  gyroYChart.data.datasets[0].data = mapSeries(filtered, item => item.gyro_y_dps);
  setAutoScale(gyroYChart, gyroY, 'gyroY');
  gyroYChart.update('none');

  gyroZChart.data.datasets[0].data = mapSeries(filtered, item => item.gyro_z_dps);
  setAutoScale(gyroZChart, gyroZ, 'gyroZ');
  gyroZChart.update('none');
}

// Função principal de renderização: filtra dados e atualiza UI
function renderAll() {
  const limits = getWindowLimits();
  let filtered;

  if (CONFIG.TIME_RANGE === 'all') {
    filtered = cache.filter(item => item.ts <= limits.end);
  } else {
    // Buffer de 2s para garantir que as linhas cheguem até a borda do gráfico
    const buffer = 2000;
    filtered = cache.filter(item => item.ts >= (limits.start - buffer) && item.ts <= (limits.end + buffer));
  }

  filtered = sanitizeSeries(filtered);
  if (filtered.length === 0 && cache.length === 0) {
    return;
  }
  updateMetrics(filtered);
  refreshCharts(filtered, limits);
}

function clearCache() {
  cache.length = 0;
  alerts.length = 0;
  lastDataTs = null;
  lastSampleTs = null;
  lastFetchAt = null;
  lastSeenCounter = null;

  renderAlerts();
  resetMetrics();

  const charts = [tempChart, accelChart, gyroChart, vibrationChart, accelXChart, accelYChart, accelZChart, gyroXChart, gyroYChart, gyroZChart];
  charts.forEach(chart => {
    chart.data.labels = [];
    chart.data.datasets.forEach(dataset => {
      dataset.data = [];
    });
    chart.update('none');
  });

  document.getElementById('tempValue').textContent = '--';
  const accelAxisXEl = document.getElementById('accelAxisX');
  const accelAxisYEl = document.getElementById('accelAxisY');
  const accelAxisZEl = document.getElementById('accelAxisZ');
  if (accelAxisXEl) accelAxisXEl.textContent = 'AX=--';
  if (accelAxisYEl) accelAxisYEl.textContent = 'AY=--';
  if (accelAxisZEl) accelAxisZEl.textContent = 'AZ=--';

  const gyroAxisXEl = document.getElementById('gyroAxisX');
  const gyroAxisYEl = document.getElementById('gyroAxisY');
  const gyroAxisZEl = document.getElementById('gyroAxisZ');
  if (gyroAxisXEl) gyroAxisXEl.textContent = 'GX=--';
  if (gyroAxisYEl) gyroAxisYEl.textContent = 'GY=--';
  if (gyroAxisZEl) gyroAxisZEl.textContent = 'GZ=--';
  document.getElementById('tempProgress').style.width = '0%';
  document.getElementById('accelMagProgress').style.width = '0%';
  document.getElementById('gyroMagProgress').style.width = '0%';
  document.getElementById('fanState').textContent = '--';
  document.getElementById('fanStateDetail').textContent = 'Aguardando dados';
  document.getElementById('severity').textContent = 'NONE';
  document.getElementById('severityMessage').textContent = 'Sistema normal';
  document.getElementById('lastUpdate').textContent = '--';
  document.getElementById('lastPayloadSummary').textContent = '--';
  document.getElementById('lastPayloadAxes').textContent = '--';

  updateStatus(false);
}

function exportCsv() {
  if (!cache.length) {
    return;
  }
  const header = ['timestamp', 'temperature', 'vibration', 'vibration_dps', 'accel_x_g', 'accel_y_g', 'accel_z_g', 'gyro_x_dps', 'gyro_y_dps', 'gyro_z_dps', 'fan_state', 'collection_id', 'phase_marker', 'severity', 'message'];
  const rows = cache.map(item => [
    new Date(item.ts).toISOString(),
    item.temperature,
    item.vibration,
    item.vibration_dps ?? '',
    item.accel_x_g,
    item.accel_y_g,
    item.accel_z_g,
    item.gyro_x_dps,
    item.gyro_y_dps,
    item.gyro_z_dps,
    item.fan_state,
    item.collection_id,
    item.phase_marker,
    item.severity,
    item.message,
  ]);
  const csv = [header, ...rows].map(row => row.join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = 'ventilador_monitor.csv';
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

function adjustUpdateRate(newRateHz) {
  if (!newRateHz || newRateHz <= 0 || newRateHz === currentDashboardRateHz) {
    return; // No change needed or invalid rate
  }

  console.log(`[Dashboard] Adjusting update rate from ${currentDashboardRateHz}Hz to ${newRateHz}Hz.`);

  // Clear the old interval
  if (dataFetchIntervalId) {
    clearInterval(dataFetchIntervalId);
  }

  // Set the new interval
  CONFIG.UPDATE_INTERVAL = 1000 / newRateHz;
  dataFetchIntervalId = setInterval(fetchLatest, CONFIG.UPDATE_INTERVAL);

  // Update the current rate and UI
  currentDashboardRateHz = newRateHz;
  const rateEl = document.getElementById('headerRate');
  if (rateEl) {
    rateEl.textContent = `@ ${newRateHz} Hz`;
  }
}

// Busca apenas o último dado (para atualização rápida de status)
async function fetchLatest() {
  try {
    const response = await fetch(CONFIG.API_ENDPOINT, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }
    const responseData = await response.json();
    const payload = responseData.data;
    const serverConfig = responseData.config;

    // Adjust rate if needed
    if (serverConfig && serverConfig.sample_rate) {
      adjustUpdateRate(Number(serverConfig.sample_rate));
    }

    const normalized = normalizePayload(payload);
    lastSampleTs = normalized.ts;
    lastFetchAt = getNow();
    const hasCounter = Number.isFinite(normalized.counter);
    const isNewSample = hasCounter
      ? normalized.counter !== lastSeenCounter
      : normalized.ts !== lastDataTs;

    if (isNewSample) {
      lastSeenCounter = hasCounter ? normalized.counter : lastSeenCounter;
    } else if (lastFetchAt == null) {
      // First successful fetch after reload; mark online even if sample is repeated
      lastFetchAt = getNow();
    }
    lastDataTs = normalized.ts;

    pushCache(normalized);
    updateStatus(true);
    if (!isFresh()) {
      updateStatus(false);
    }
    updateCards(normalized);
    updateAlerts(normalized);
    renderAll();
  } catch (err) {
    updateStatus(false);
    console.error('Falha ao buscar dados:', err);
  }
}

// Busca o histórico de dados (para preencher os gráficos)
async function fetchHistory() {
  if (!CONFIG.HISTORY_ENDPOINT) {
    return;
  }
  try {
    const url = `${CONFIG.HISTORY_ENDPOINT}?mode=history&seconds=${CONFIG.HISTORY_SECONDS}`;
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }
    const responseData = await response.json();
    const payload = responseData.data;
    const serverConfig = responseData.config;

    // Adjust rate if needed
    if (serverConfig && serverConfig.sample_rate) {
      adjustUpdateRate(Number(serverConfig.sample_rate));
    }

    if (!Array.isArray(payload)) {
      return;
    }
    payload.reverse().forEach(item => {
      pushCache(normalizePayload(item));
    });
    renderAll();
  } catch (err) {
    console.warn('Histórico não carregado:', err);
  }
}

document.querySelectorAll('.btn[data-range]').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.btn[data-range]').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    CONFIG.TIME_RANGE = btn.dataset.range;
    renderAll();
  });
});

document.querySelectorAll('.btn[data-scale-step]').forEach(btn => {
  btn.addEventListener('click', () => {
    const target = btn.dataset.scaleTarget;
    const group = btn.closest('.chart-controls');
    if (group) {
      group.querySelectorAll('.btn[data-scale-step]').forEach(b => b.classList.remove('active'));
    }
    btn.classList.add('active');
    if (btn.dataset.scaleStep === 'auto') {
      delete chartScaleOverrides[target];
    } else {
      chartScaleOverrides[target] = Number(btn.dataset.scaleStep);
    }
    renderAll();
  });
});

document.getElementById('exportCsv').addEventListener('click', exportCsv);
document.getElementById('clearCache').addEventListener('click', clearCache);

document.querySelectorAll('.tab-button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-button').forEach(b => b.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach(pane => pane.classList.remove('active'));
    btn.classList.add('active');
    document.getElementById('tab-' + btn.dataset.tab).classList.add('active');
  });
});

// --- CONTROLES DE PLAYBACK (PAUSA / NAVEGAÇÃO) ---

function togglePause() {
  isPaused = !isPaused;
  const btn = document.getElementById('btnPause');

  if (btn) {
    if (isPaused) {
      pauseSnapshot = getNow();
      btn.innerHTML = '&#9658;'; // Símbolo de Play
      btn.classList.add('active');
      btn.title = "Retomar atualização em tempo real";
    } else {
      pauseSnapshot = null;
      btn.innerHTML = '&#10074;&#10074;'; // Símbolo de Pause
      btn.classList.remove('active');
      btn.title = "Pausar visualização";
    }
  }
  updateLiveButton();
  renderAll();
}

function panHistory(direction) {
  // direction: 1 = voltar (passado), -1 = avançar (futuro)
  let rangeMs = 30000; // padrão 30s
  if (CONFIG.TIME_RANGE === '1m') rangeMs = 60000;
  if (CONFIG.TIME_RANGE === '5m') rangeMs = 300000;
  if (CONFIG.TIME_RANGE === '10m') rangeMs = 600000;
  if (CONFIG.TIME_RANGE === '1h') rangeMs = 3600000;
  if (CONFIG.TIME_RANGE === '6h') rangeMs = 21600000;

  // Move 20% da janela atual a cada clique
  const step = rangeMs * 0.2;
  viewOffsetMs += step * direction;

  if (viewOffsetMs < 0) viewOffsetMs = 0;

  updateLiveButton();
  renderAll();
}

function resetToLive() {
  isPaused = false;
  pauseSnapshot = null;
  viewOffsetMs = 0;

  const btnPause = document.getElementById('btnPause');
  if (btnPause) {
    btnPause.innerHTML = '&#10074;&#10074;';
    btnPause.classList.remove('active');
  }

  updateLiveButton();
  renderAll();
}

function updateLiveButton() {
  const btnLive = document.getElementById('btnLive');
  if (!btnLive) return;

  const isLive = !isPaused && viewOffsetMs === 0;
  btnLive.style.display = isLive ? 'none' : 'inline-block';
}

// Cria os botões de controle de playback dinamicamente
function injectPlaybackControls() {
  const rangeBtn = document.querySelector('.btn[data-range]');
  if (!rangeBtn || !rangeBtn.parentElement) return;

  const container = rangeBtn.parentElement;

  // Separador
  const sep = document.createElement('span');
  sep.style.borderLeft = '1px solid #cbd5e1';
  sep.style.margin = '0 8px';
  sep.style.height = '20px';
  sep.style.display = 'inline-block';
  sep.style.verticalAlign = 'middle';
  container.appendChild(sep);

  // Botões
  const createBtn = (html, title, onClick, id) => {
    const btn = document.createElement('button');
    btn.className = 'btn';
    if (id) btn.id = id;
    btn.innerHTML = html;
    btn.title = title;
    btn.onclick = onClick;
    container.appendChild(btn);
    return btn;
  };

  createBtn('&#9664;', "Voltar (Passado)", () => panHistory(1));
  createBtn('&#10074;&#10074;', "Pausar", togglePause, 'btnPause');
  createBtn('&#9654;', "Avançar (Futuro)", () => panHistory(-1));

  const btnLive = createBtn('AO VIVO', "Voltar para o tempo real", resetToLive, 'btnLive');
  btnLive.style.display = 'none';
  btnLive.style.color = '#ef4444';
  btnLive.style.fontWeight = 'bold';
  btnLive.style.marginLeft = '5px';
}

// Defer data fetching until ML classifier is initialized
// This ensures historical data can be fed to the classifier

let dataFetchingStarted = false;

// Inicia o loop de busca de dados APÓS o ML estar pronto
async function startDataFetching() {
  if (dataFetchingStarted) return;
  dataFetchingStarted = true;

  console.log('[Dashboard] Starting data fetching after ML initialization');
  await fetchHistory();
  dataFetchIntervalId = setInterval(fetchLatest, CONFIG.UPDATE_INTERVAL);
}

// Will be called after ML initialization

// =============================================================================
// ML CLASSIFICATION INTEGRATION
// =============================================================================

const ML_CONFIG = {
  MODEL_URL: 'models/gnb_model_20260130.json',  // Path to model file (versioned)
  PREDICTION_INTERVAL: 250,                      // v4.1: Run prediction every 250ms (was 1000ms)
  ENABLED: true,                                 // ML classification enabled by default
};

let mlPredictionInterval = null;
let mlInitialized = false;

/**
 * Inicializa o classificador ML carregando o arquivo JSON do modelo
 */
async function initMLClassifier() {
  if (mlInitialized) {
    console.log('[ML] Already initialized, skipping');
    return window.fanClassifier?.isReady || false;
  }

  if (typeof window.fanClassifier === 'undefined') {
    console.warn('[ML] Classifier module not loaded');
    mlErrorState = 'Módulo não carregado';
    updateMLUI({ status: 'error', message: 'Módulo não carregado' });
    return false;
  }

  updateMLBadge('loading', 'Carregando...');

  let loaded = false;
  try {
    console.log(`[ML] Trying to load model from: ${ML_CONFIG.MODEL_URL}`);
    const response = await fetch(ML_CONFIG.MODEL_URL, { cache: 'no-store' });
    if (response.ok) {
      const modelData = await response.json();
      loaded = await window.fanClassifier.init(modelData);
      if (loaded) {
        mlErrorState = null;
        window.mlModelData = modelData;
        updateModelPerformance(modelData);
        buildModelFeatureList(modelData);
        buildMLFeatureRows(modelData);
        console.log(`[ML] Model loaded successfully from: ${ML_CONFIG.MODEL_URL}`);
      }
    } else {
      throw new Error(`HTTP ${response.status}`);
    }
  } catch (err) {
    console.error(`[ML] Failed to load model from ${ML_CONFIG.MODEL_URL}:`, err.message);
  }

  if (loaded) {
    mlInitialized = true;
    syncMLBadgeState();
    updateMLDecisionMeta();
    const info = window.fanClassifier.getModelInfo();
    console.log('[ML] Model info:', info);

    // Start prediction loop
    startMLPredictionLoop();

    // Set callback for predictions
    window.fanClassifier.onPrediction = (prediction) => {
      updateMLUI(prediction);
    };

    return true;
  } else {
    mlErrorState = 'Modelo não carregado';
    updateMLBadge('error', 'Modelo não encontrado');
    updateMLUI({ status: 'error', message: 'Modelo não carregado' });
    return false;
  }
}

/**
 * Update ML badge status
 */
function updateMLBadge(status, text) {
  const badge = document.getElementById('mlBadge');
  if (!badge) return;

  badge.className = 'ml-badge';
  switch (status) {
    case 'active':
      badge.classList.add('ml-badge-active');
      break;
    case 'loading':
      badge.classList.add('ml-badge-loading');
      break;
    case 'error':
      badge.classList.add('ml-badge-error');
      break;
    case 'offline':
      badge.classList.add('ml-badge-offline');
      break;
  }
  badge.textContent = text;
}

function syncMLBadgeState() {
  if (mlErrorState) {
    updateMLBadge('error', mlErrorState);
    return;
  }
  if (!mlDataOnline) {
    updateMLBadge('offline', 'Sem dados');
    return;
  }
  if (!ML_CONFIG.ENABLED) {
    updateMLBadge('loading', 'Pausado');
    return;
  }
  if (window.fanClassifier && window.fanClassifier.isReady) {
    updateMLBadge('active', 'ML Ativo');
    return;
  }
  updateMLBadge('loading', 'Carregando...');
}

function setMLDataOnline(isOnline) {
  if (mlDataOnline === isOnline) return;
  mlDataOnline = isOnline;

  if (!isOnline) {
    stopMLPredictionLoop();
    if (!mlErrorState) {
      updateMLUI({ status: 'offline' });
    }
    syncMLBadgeState();
    return;
  }

  if (ML_CONFIG.ENABLED && window.fanClassifier && window.fanClassifier.isReady) {
    startMLPredictionLoop();
  }
  syncMLBadgeState();
}

function setTextById(id, value) {
  const el = document.getElementById(id);
  if (el) {
    el.textContent = value;
  }
}

function updateMLDecisionMeta() {
  if (!window.ClassifierConfig) return;
  const alpha = window.ClassifierConfig.SMOOTHING_ALPHA;
  setTextById('mlAlpha', alpha != null ? alpha.toFixed(2) : '--');
  setTextById('mlWindowSize', window.ClassifierConfig.WINDOW_SIZE ?? '--');
  setTextById('mlMinPoints', window.ClassifierConfig.MIN_POINTS ?? '--');
}

function updateModelPerformance(modelData) {
  if (!modelData) return;

  const metrics = modelData.metrics || {};
  const cvMean = metrics.cv_accuracy_mean;
  const trainAcc = metrics.train_accuracy;

  if (cvMean != null) {
    setTextById('modelCvAccuracy', (cvMean * 100).toFixed(2) + '%');
  }
  if (trainAcc != null) {
    setTextById('modelTrainAccuracy', (trainAcc * 100).toFixed(2) + '%');
  }

  const featureCount = modelData.feature_count || (modelData.features ? modelData.features.length : null);
  const totalSamples = modelData.training_info?.total_samples;

  if (featureCount != null) {
    setTextById('modelFeatureCount', featureCount);
    setTextById('modelFeatureCountSummary', featureCount);
  }
  if (totalSamples != null) {
    setTextById('modelWindowCount', totalSamples);
  }

  setTextById('modelValidation', '5-Fold CV');
}

function buildModelFeatureList(modelData) {
  const listEl = document.getElementById('modelFeatureList');
  if (!listEl || !modelData?.features) return;
  listEl.innerHTML = '';
  modelData.features.forEach(feature => {
    const tag = document.createElement('span');
    tag.className = 'model-feature-tag';
    tag.textContent = feature;
    listEl.appendChild(tag);
  });
}

function buildMLFeatureRows(modelData) {
  const listEl = document.getElementById('mlFeatureList');
  if (!listEl || !modelData?.features) return;
  listEl.innerHTML = '';
  modelData.features.forEach(feature => {
    const row = document.createElement('div');
    row.className = 'ml-feature-row';
    row.dataset.feature = feature;
    row.innerHTML = `
      <span class="ml-feature-name">${feature}</span>
      <span class="ml-feature-value">--</span>
      <span class="ml-feature-class">--</span>
    `;
    listEl.appendChild(row);
  });
}

function formatFeatureValue(value) {
  if (value == null || Number.isNaN(value)) {
    return '--';
  }
  const abs = Math.abs(value);
  if (abs >= 100) return value.toFixed(1);
  if (abs >= 10) return value.toFixed(2);
  return value.toFixed(3);
}

function getClosestLabel(feature, value) {
  const modelData = window.mlModelData;
  if (!modelData?.stats || value == null || Number.isNaN(value)) return null;
  let bestLabel = null;
  let bestDiff = Infinity;
  (modelData.labels || []).forEach(label => {
    const mean = modelData.stats?.[label]?.[feature]?.mean;
    if (mean == null) return;
    const diff = Math.abs(value - mean);
    if (diff < bestDiff) {
      bestDiff = diff;
      bestLabel = label;
    }
  });
  return bestLabel;
}

function updateFeatureRows(prediction) {
  const listEl = document.getElementById('mlFeatureList');
  if (!listEl || !prediction?.features) return;

  const rows = listEl.querySelectorAll('.ml-feature-row');
  rows.forEach(row => {
    const feature = row.dataset.feature;
    const value = prediction.features[feature];
    const valueEl = row.querySelector('.ml-feature-value');
    const classEl = row.querySelector('.ml-feature-class');

    valueEl.textContent = formatFeatureValue(value);

    const closest = getClosestLabel(feature, value);
    row.classList.remove('ml-feature-low', 'ml-feature-medium', 'ml-feature-high');
    classEl.className = 'ml-feature-class';

    if (closest) {
      // Alterado para adicionar clareza de que é uma análise individual
      classEl.textContent = `Tendência: ${closest}`;
      const className = 'ml-feature-' + closest.toLowerCase();
      row.classList.add(className);
      classEl.classList.add(className);
    } else {
      classEl.textContent = 'Tendência: --';
    }
  });
}

/**
 * Reseta o estado do classificador de forma inteligente quando o modo é alterado externamente.
 */
function smartResetClassifier() {
  if (window.fanClassifier) {
    console.log('[ML] Smart Reset: Limpando buffer do classificador devido à mudança de modo.');
    window.fanClassifier.reset();
    // Reseta contadores internos para aceitar novos dados imediatamente
    lastMLFeedTs = null;
    lastMLFeedCounter = null;
  }
}

function resetFeatureRows() {
  const listEl = document.getElementById('mlFeatureList');
  if (!listEl) return;
  const rows = listEl.querySelectorAll('.ml-feature-row');
  rows.forEach(row => {
    const valueEl = row.querySelector('.ml-feature-value');
    const classEl = row.querySelector('.ml-feature-class');
    row.classList.remove('ml-feature-low', 'ml-feature-medium', 'ml-feature-high');
    classEl.className = 'ml-feature-class';
    valueEl.textContent = '--';
    classEl.textContent = '--';
  });
}

function resetMLDecisionUI(statusText) {
  setTextById('mlRawPrediction', statusText);
  setTextById('mlRawConfidence', '--');
  setTextById('mlSmoothedPrediction', statusText);
  setTextById('mlSmoothedConfidence', '--');
  setTextById('mlProbLowRaw', '--');
  setTextById('mlProbMediumRaw', '--');
  setTextById('mlProbHighRaw', '--');
  setTextById('mlProbLowSmooth', '--');
  setTextById('mlProbMediumSmooth', '--');
  setTextById('mlProbHighSmooth', '--');
  setTextById('mlHysteresisConfirmed', '--');
  setTextById('mlHysteresisCandidate', '--');
  setTextById('mlHysteresisCount', '--');
  resetFeatureRows();
}

/**
 * Atualiza a interface do usuário com os resultados do ML
 */
function updateMLUI(prediction) {
  const predEl = document.getElementById('mlPrediction');
  const confText = document.getElementById('mlConfidenceText');
  const confBar = document.getElementById('mlConfidenceBar');
  const bufferStatus = document.getElementById('mlBufferStatus');
  const stabilityEl = document.getElementById('mlStability');
  const probLow = document.getElementById('mlProbLow');
  const probHigh = document.getElementById('mlProbHigh');

  if (!predEl) return;

  // Handle different statuses
  if (prediction.status === 'error') {
    mlErrorState = prediction.message || 'Erro no classificador';
    predEl.textContent = 'ERRO';
    predEl.className = 'ml-prediction unknown';
    confText.textContent = prediction.message || 'Erro no classificador';
    confBar.style.width = '0%';
    resetMLDecisionUI('ERRO');
    syncMLBadgeState();
    return;
  }

  const hadError = !!mlErrorState;
  mlErrorState = null;
  if (hadError) {
    syncMLBadgeState();
  }

  if (prediction.status === 'offline') {
    predEl.textContent = 'SEM DADOS';
    predEl.className = 'ml-prediction unknown';
    const lastSeen = lastDataTs ? new Date(lastDataTs).toLocaleString('pt-BR') : null;
    confText.textContent = lastSeen
      ? `Sem dados em tempo real • Último: ${lastSeen}`
      : 'Aguardando dados do sensor';
    confBar.style.width = '0%';
    confBar.className = 'confidence-fill low';
    bufferStatus.textContent = 'Buffer: --';
    stabilityEl.textContent = 'Estabilidade: --';
    resetMLDecisionUI('SEM DADOS');
    return;
  }

  if (!mlDataOnline) {
    return;
  }

  if (prediction.status === 'buffering') {
    predEl.textContent = 'COLETANDO...';
    predEl.className = 'ml-prediction buffering';
    confText.textContent = prediction.message;
    confBar.style.width = (prediction.bufferProgress * 100) + '%';
    confBar.className = 'confidence-fill medium';
    bufferStatus.textContent = `Buffer: ${Math.round(prediction.bufferProgress * 100)}%`;
    resetMLDecisionUI('COLETANDO');
    // Update main fan state card during buffering
    updateFanStateFromML('ANALISANDO', 'Coletando dados para classificação...', 'buffering');
    return;
  }

  // Normal prediction
  predEl.textContent = prediction.prediction;
  predEl.className = 'ml-prediction ' + prediction.prediction.toLowerCase();

  // Confidence display
  const confPct = (prediction.confidence * 100).toFixed(1);
  confText.textContent = `Confiança: ${confPct}%`;
  confBar.style.width = confPct + '%';
  confBar.className = 'confidence-fill ' + prediction.confidenceLevel;

  // Buffer and stability
  bufferStatus.textContent = `Buffer: ${prediction.bufferSize || 0} pts`;
  if (window.fanClassifier) {
    const stability = window.fanClassifier.getStability();
    stabilityEl.textContent = `Estabilidade: ${(stability * 100).toFixed(0)}%`;
  }

  // Probabilities (LOW, MEDIUM, HIGH)
  if (prediction.smoothedProbabilities) {
    const pLow = ((prediction.smoothedProbabilities.LOW || 0) * 100).toFixed(1);
    const pMed = ((prediction.smoothedProbabilities.MEDIUM || 0) * 100).toFixed(1);
    const pHigh = ((prediction.smoothedProbabilities.HIGH || 0) * 100).toFixed(1);
    probLow.textContent = pLow + '%';
    probHigh.textContent = pHigh + '%';
    probLow.className = 'ml-prob-value' + (prediction.prediction === 'LOW' ? ' active' : '');
    probHigh.className = 'ml-prob-value' + (prediction.prediction === 'HIGH' ? ' active' : '');

    // Update MEDIUM probability if element exists
    const probMed = document.getElementById('mlProbMedium');
    if (probMed) {
      probMed.textContent = pMed + '%';
      probMed.className = 'ml-prob-value' + (prediction.prediction === 'MEDIUM' ? ' active' : '');
    }

    // Decision card smoothed probabilities
    setTextById('mlProbLowSmooth', pLow + '%');
    setTextById('mlProbMediumSmooth', pMed + '%');
    setTextById('mlProbHighSmooth', pHigh + '%');
  }

  // Raw probabilities
  if (prediction.probabilities) {
    const pLowRaw = ((prediction.probabilities.LOW || 0) * 100).toFixed(1);
    const pMedRaw = ((prediction.probabilities.MEDIUM || 0) * 100).toFixed(1);
    const pHighRaw = ((prediction.probabilities.HIGH || 0) * 100).toFixed(1);
    setTextById('mlProbLowRaw', pLowRaw + '%');
    setTextById('mlProbMediumRaw', pMedRaw + '%');
    setTextById('mlProbHighRaw', pHighRaw + '%');
  }

  // Decision card predictions
  const rawConfPct = ((prediction.rawConfidence || 0) * 100).toFixed(1);
  setTextById('mlRawPrediction', prediction.rawPrediction || '--');
  setTextById('mlRawConfidence', rawConfPct + '%');
  setTextById('mlSmoothedPrediction', prediction.prediction || '--');
  setTextById('mlSmoothedConfidence', confPct + '%');

  // Hysteresis status
  const hysteresisTarget = prediction.hysteresisCount || window.ClassifierConfig?.HYSTERESIS_COUNT || 0;
  const candidateCount = prediction.candidateCount ?? 0;
  setTextById('mlHysteresisConfirmed', prediction.confirmedState || '--');
  setTextById('mlHysteresisCandidate', prediction.candidateState || '--');
  setTextById('mlHysteresisCount', `${candidateCount}/${hysteresisTarget}`);

  // Feature values (real-time)
  updateFeatureRows(prediction);

  // Update main fan state card with ML prediction
  let stateDetail;
  switch (prediction.prediction) {
    case 'LOW':
      stateDetail = `Velocidade baixa (${confPct}% confiança)`;
      break;
    case 'MEDIUM':
      stateDetail = `Velocidade média (${confPct}% confiança)`;
      break;
    case 'HIGH':
      stateDetail = `Velocidade alta (${confPct}% confiança)`;
      break;
    default:
      stateDetail = `${prediction.prediction} (${confPct}% confiança)`;
  }
  updateFanStateFromML(prediction.prediction, stateDetail, prediction.confidenceLevel);
}

/**
 * Atualiza o cartão principal de Estado do Ventilador com a previsão do ML
 */
function updateFanStateFromML(state, detail, confidenceLevel) {
  const fanStateEl = document.getElementById('fanState');
  const fanStateDetailEl = document.getElementById('fanStateDetail');
  const fanStateCard = document.getElementById('fanStateCard');

  if (!fanStateEl) return;

  fanStateEl.textContent = state;
  fanStateEl.className = 'card-value state-' + state.toLowerCase();

  if (fanStateDetailEl) {
    fanStateDetailEl.textContent = detail;
  }

  // Add visual indicator that this is ML prediction
  if (fanStateCard) {
    fanStateCard.classList.remove('ml-confidence-high', 'ml-confidence-medium', 'ml-confidence-low');
    if (confidenceLevel) {
      fanStateCard.classList.add('ml-confidence-' + confidenceLevel);
    }
  }
}

function getFeatureVectorFromPayload(normalized) {
  const featurePayloadKeys = [
    'accel_x_g_std',
    'accel_x_g_range',
    'accel_x_g_rms',
    'gyro_y_dps_std',
    'gyro_y_dps_rms',
    'gyro_y_dps_range',
  ];
  const mode = (normalized.mode || '').toString().toLowerCase();
  const isFeaturePayload = Number.isFinite(normalized.feature_window)
    || mode === 'normal'
    || featurePayloadKeys.some(key => Number.isFinite(normalized[key]));

  if (!isFeaturePayload) {
    return null;
  }

  const modelFeatures = window.mlModelData?.features || window.fanClassifier?.getModelInfo?.()?.features;
  if (!Array.isArray(modelFeatures) || modelFeatures.length === 0) {
    return null;
  }
  const vector = {};
  let count = 0;
  for (const key of modelFeatures) {
    const value = normalized[key];
    if (Number.isFinite(value)) {
      vector[key] = value;
      count += 1;
    }
  }
  return count ? vector : null;
}

/**
 * Alimenta o classificador ML com um novo ponto de dados
 */
function feedMLData(normalized) {
  if (!ML_CONFIG.ENABLED || !window.fanClassifier || !window.fanClassifier.isReady) {
    return;
  }

  const featureVector = getFeatureVectorFromPayload(normalized);
  if (featureVector && window.fanClassifier.predictWithFeatures) {
    const windowSize = normalized.feature_window || window.ClassifierConfig?.WINDOW_SIZE || null;
    window.fanClassifier.predictWithFeatures(featureVector, windowSize);
    if (!mlDataOnline) {
      setMLDataOnline(true);
    }
    return;
  }

  if (window.fanClassifier.clearFeatureMode) {
    window.fanClassifier.clearFeatureMode();
  }
  if (Number.isFinite(normalized.counter)) {
    if (lastMLFeedCounter != null && normalized.counter < lastMLFeedCounter) {
      // Device restart or counter reset; reset ML buffer to avoid mixing sessions
      lastMLFeedCounter = null;
      lastMLFeedTs = null;
      if (window.fanClassifier) {
        window.fanClassifier.reset();
      }
    }
    if (lastMLFeedCounter != null && normalized.counter <= lastMLFeedCounter) {
      return;
    }
    lastMLFeedCounter = normalized.counter;
  } else {
    if (lastMLFeedTs != null && normalized.ts <= lastMLFeedTs) {
      return;
    }
  }
  lastMLFeedTs = normalized.ts;
  if (!mlDataOnline) {
    setMLDataOnline(true);
  }

  // Convert normalized data to classifier format
  const dataPoint = {
    ax: normalized.accel_x_g,
    ay: normalized.accel_y_g,
    az: normalized.accel_z_g,
    gx: normalized.gyro_x_dps,
    gy: normalized.gyro_y_dps,
    gz: normalized.gyro_z_dps,
    vib: normalized.vibration_dps != null ? normalized.vibration_dps : normalized.vibration,
    vibration: normalized.vibration_dps != null ? normalized.vibration_dps : normalized.vibration,
    timestamp: normalized.ts,
    counter: normalized.counter
  };

  window.fanClassifier.addData(dataPoint);
}

/**
 * Inicia o loop de predição do ML (roda periodicamente)
 */
function startMLPredictionLoop() {
  if (mlPredictionInterval) {
    clearInterval(mlPredictionInterval);
  }

  mlPredictionInterval = setInterval(() => {
    if (ML_CONFIG.ENABLED && window.fanClassifier && window.fanClassifier.isReady) {
      if (window.fanClassifier.isFeatureModeActive && window.fanClassifier.isFeatureModeActive()) {
        return;
      }
      window.fanClassifier.predict();
    }
  }, ML_CONFIG.PREDICTION_INTERVAL);
}

/**
 * Stop ML prediction loop
 */
function stopMLPredictionLoop() {
  if (mlPredictionInterval) {
    clearInterval(mlPredictionInterval);
    mlPredictionInterval = null;
  }
}

/**
 * Toggle ML classification on/off
 */
function toggleML() {
  ML_CONFIG.ENABLED = !ML_CONFIG.ENABLED;
  const btn = document.getElementById('mlToggle');

  if (ML_CONFIG.ENABLED) {
    btn.textContent = 'ML Ativo';
    btn.classList.add('btn-ml-active');
    if (mlDataOnline && window.fanClassifier && window.fanClassifier.isReady) {
      startMLPredictionLoop();
    }
  } else {
    btn.textContent = 'ML Inativo';
    btn.classList.remove('btn-ml-active');
    stopMLPredictionLoop();
  }
  syncMLBadgeState();
}

/**
 * Reseta o estado do classificador e recarrega o buffer com dados do cache
 */
function resetML() {
  if (window.fanClassifier) {
    lastMLFeedTs = null;
    lastMLFeedCounter = null;
    window.fanClassifier.reset();
    updateMLUI({
      status: 'buffering',
      message: 'Recarregando buffer...',
      bufferProgress: 0
    });

    // Reload buffer from existing cache data
    const mlWindowSize = window.ClassifierConfig?.WINDOW_SIZE || 100;
    const recentData = cache.slice(-mlWindowSize);

    if (recentData.length > 0) {
      console.log(`[ML] Reloading buffer with ${recentData.length} points from cache`);
      recentData.forEach(item => {
        feedMLData(item);
      });

      // Trigger immediate prediction if we have enough data
      setTimeout(() => {
        if (window.fanClassifier && window.fanClassifier.isReady) {
          window.fanClassifier.predict();
        }
      }, 100);
    } else {
      console.log('[ML] No cache data available, waiting for new data');
    }
  }
}

// Sobrescreve fetchLatest para injetar dados no ML automaticamente
const originalFetchLatest = fetchLatest;
fetchLatest = async function () {
  if (latestFetchInFlight) {
    return;
  }
  latestFetchInFlight = true;
  const fetchSingleLatest = async () => {
    const response = await fetch(CONFIG.API_ENDPOINT, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }
    const responseData = await response.json();
    const payload = responseData.data;
    const serverConfig = responseData.config;
    if (serverConfig && serverConfig.sample_rate) {
      adjustUpdateRate(Number(serverConfig.sample_rate));
    }
    const normalized = normalizePayload(payload);
    const hasCounter = Number.isFinite(normalized.counter);
    const isNewSample = hasCounter
      ? normalized.counter !== lastSeenCounter
      : normalized.ts !== lastDataTs;

    lastSampleTs = normalized.ts;
    lastFetchAt = getNow();

    if (isNewSample) {
      lastSeenCounter = hasCounter ? normalized.counter : lastSeenCounter;
    }
    lastDataTs = normalized.ts;

    pushCache(normalized);
    feedMLData(normalized);
    updateStatus(true);
    if (!isFresh()) {
      updateStatus(false);
    }
    updateCards(normalized);
    updateAlerts(normalized);
    renderAll();
  };

  try {
    if (CONFIG.HISTORY_ENDPOINT) {
      const url = `${CONFIG.HISTORY_ENDPOINT}?mode=history&seconds=${CONFIG.REALTIME_WINDOW_SECONDS}`;
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) {
        throw new Error('HTTP ' + response.status);
      }
      const responseData = await response.json();
      const payload = responseData.data;
      const serverConfig = responseData.config;

      // Adjust rate if needed
      if (serverConfig && serverConfig.sample_rate) {
        adjustUpdateRate(Number(serverConfig.sample_rate));
      }

      if (!Array.isArray(payload) || payload.length === 0) {
        await fetchSingleLatest();
        return;
      }

      const batch = payload.slice().sort((a, b) => {
        const tsA = normalizeTimestampMs(a.timestamp_ms ?? a.timestamp ?? a.timestamp_s ?? a.ts, 0);
        const tsB = normalizeTimestampMs(b.timestamp_ms ?? b.timestamp ?? b.timestamp_s ?? b.ts, 0);
        return tsA - tsB;
      });

      let latestNormalized = null;
      let anyNew = false;

      batch.forEach(item => {
        const normalized = normalizePayload(item);
        const hasCounter = Number.isFinite(normalized.counter);
        if (hasCounter && lastSeenCounter != null && normalized.counter < lastSeenCounter) {
          // Device reset detected; allow new sequence
          lastSeenCounter = null;
          lastDataTs = null;
        }
        const isNewSample = hasCounter
          ? (lastSeenCounter == null || normalized.counter > lastSeenCounter)
          : (lastDataTs == null || normalized.ts > lastDataTs);

        if (!isNewSample) {
          return;
        }

        anyNew = true;
        lastSeenCounter = hasCounter ? normalized.counter : lastSeenCounter;
        lastDataTs = normalized.ts;
        lastSampleTs = normalized.ts;
        lastFetchAt = getNow();

        pushCache(normalized);
        feedMLData(normalized);
        latestNormalized = normalized;
      });

      if (!anyNew && batch.length) {
        // No new samples, but keep UI alive with most recent payload
        const normalized = normalizePayload(batch[batch.length - 1]);
        latestNormalized = normalized;
        lastSampleTs = normalized.ts;
        lastFetchAt = getNow();
      }

      updateStatus(true);
      if (!isFresh()) {
        updateStatus(false);
      }
      if (latestNormalized) {
        updateCards(latestNormalized);
        updateAlerts(latestNormalized);
      }

      // CORREÇÃO: Força a atualização dos gráficos com os novos dados do lote.
      renderAll();
      return;
    }

    await fetchSingleLatest();
  } catch (err) {
    try {
      await fetchSingleLatest();
    } catch (fallbackErr) {
      updateStatus(false);
      console.error('Falha ao buscar dados:', err, fallbackErr);
    }
  } finally {
    latestFetchInFlight = false;
  }
};

// Sobrescreve fetchHistory para pré-carregar o buffer do ML
const originalFetchHistory = fetchHistory;
fetchHistory = async function () {
  if (!CONFIG.HISTORY_ENDPOINT) {
    return;
  }
  try {
    const url = `${CONFIG.HISTORY_ENDPOINT}?mode=history&seconds=${CONFIG.HISTORY_SECONDS}`;
    const response = await fetch(url, { cache: 'no-store' });
    if (!response.ok) {
      throw new Error('HTTP ' + response.status);
    }
    const responseData = await response.json();
    const payload = responseData.data;
    const serverConfig = responseData.config;

    // Adjust rate if needed
    if (serverConfig && serverConfig.sample_rate) {
      adjustUpdateRate(Number(serverConfig.sample_rate));
    }

    if (!Array.isArray(payload)) {
      return;
    }

    // Sort by timestamp and feed to classifier
    const sorted = payload.sort((a, b) => {
      const tsA = normalizeTimestampMs(a.timestamp_ms ?? a.timestamp ?? a.timestamp_s ?? a.ts, 0);
      const tsB = normalizeTimestampMs(b.timestamp_ms ?? b.timestamp ?? b.timestamp_s ?? b.ts, 0);
      return tsA - tsB;
    });

    // Take last N points for ML buffer (to quickly initialize)
    const mlWindowSize = window.ClassifierConfig?.WINDOW_SIZE || 100;
    const recentForML = sorted.slice(-mlWindowSize);

    sorted.forEach(item => {
      pushCache(normalizePayload(item));
    });

    // Feed recent data to ML classifier
    recentForML.forEach(item => {
      feedMLData(normalizePayload(item));
    });

    // Update cards/status using the most recent payload
    if (sorted.length) {
      const latestNormalized = normalizePayload(sorted[sorted.length - 1]);
      lastSampleTs = latestNormalized.ts;
      lastFetchAt = getNow();
      lastDataTs = latestNormalized.ts;
      if (Number.isFinite(latestNormalized.counter)) {
        lastSeenCounter = latestNormalized.counter;
      }
      updateStatus(true);
      updateCards(latestNormalized);
      updateAlerts(latestNormalized);
    }

    renderAll();
  } catch (err) {
    console.warn('Histórico não carregado:', err);
  }
};

async function startApp() {
  if (window.appStarted) return;
  window.appStarted = true;

  const mlToggleBtn = document.getElementById('mlToggle');
  const mlResetBtn = document.getElementById('mlReset');

  if (mlToggleBtn) mlToggleBtn.addEventListener('click', toggleML);
  if (mlResetBtn) mlResetBtn.addEventListener('click', resetML);

  const rateEl = document.getElementById('headerRate');
  if (rateEl) rateEl.textContent = `@ ${currentDashboardRateHz} Hz`;

  injectPlaybackControls();

  // Listener para comandos do painel de controle (control.html)
  try {
    const controlChannel = new BroadcastChannel('fan_control_channel');
    controlChannel.onmessage = (event) => {
      if (event.data?.type === 'MODE_CHANGE') {
        smartResetClassifier();
      }
    };
  } catch (e) {
    console.warn("BroadcastChannel não é suportado neste navegador.", e);
  }

  await initMLClassifier();
  setMLDataOnline(false);
  startDataFetching();
}

document.addEventListener('DOMContentLoaded', startApp);
if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(startApp, 100);
