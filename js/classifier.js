/**
 * classifier.js - Fan Speed Classifier v5.0
 *
 * Features:
 * - TRUE 3-class Gaussian NB (LOW, MEDIUM, HIGH)
 * - No zone-based detection - uses real trained statistics
 * - Circular buffer for O(1) operations
 * - Hysteresis for stability
 *
 * @version 5.0.0
 * @author IoT MPU6050 Project
 */

// =============================================================================
// CONFIGURATION
// =============================================================================

const ClassifierConfig = {
    // Tamanho da Janela Deslizante: Quantos pontos passados analisamos de uma vez
    // 100 pontos a 5Hz = analisamos os ultimos 20 segundos de comportamento
    WINDOW_SIZE: 100,  // 100 pontos a ~4Hz = ~25s (estabiliza skew/kurtosis)
    MIN_POINTS: 40,    // Mínimo 40 pontos (~10s) para classificar

    // Confidence thresholds
    CONFIDENCE_HIGH: 0.70,
    CONFIDENCE_MEDIUM: 0.55,
    CONFIDENCE_GATE: 0.60,
    CONFIDENCE_MARGIN: 0.15,

    // Update frequency
    PREDICTION_INTERVAL_MS: 250,

    // Smoothing
    SMOOTHING_ALPHA: 0.65,

    // Histerese: Exige N previsões iguais consecutivas antes de mudar o estado oficial
    HYSTERESIS_COUNT: 2,

    // Detecção de mudança brusca: monitora gyro_z_dps (feature mais discriminativa)
    // Se a média recente divergir muito da média do buffer, faz flush parcial
    CHANGE_DETECT_WINDOW: 15,       // últimos 15 pontos (3s a 5Hz) para detectar mudança
    CHANGE_DETECT_RATIO: 0.45,      // ratio min entre média recente e média do buffer para trigger
    FAST_FLUSH_KEEP: 40,            // manter últimos 40 pontos após flush (~10s)
};

// =============================================================================
// CIRCULAR BUFFER
// Estrutura de dados eficiente para guardar sempre os últimos N pontos
// =============================================================================

class CircularBuffer {
    constructor(maxSize = ClassifierConfig.WINDOW_SIZE) {
        this.maxSize = maxSize;
        this.buffer = new Array(maxSize);
        this.head = 0;
        this.count = 0;
    }

    // Adiciona um novo ponto e sobrescreve o mais antigo se estiver cheio
    push(point) {
        this.buffer[this.head] = {
            ax: point.ax || point.AX || point.accel_x_g || 0,
            ay: point.ay || point.AY || point.accel_y_g || 0,
            az: point.az || point.AZ || point.accel_z_g || 0,
            gx: point.gx || point.GX || point.gyro_x_dps || 0,
            gy: point.gy || point.GY || point.gyro_y_dps || 0,
            gz: point.gz || point.GZ || point.gyro_z_dps || 0,
            vib: point.vib || point.vibration || point.VIB || point.vibration_dps || point.vibrationDps || 0,
            timestamp: point.timestamp || Date.now()
        };
        this.head = (this.head + 1) % this.maxSize;
        if (this.count < this.maxSize) this.count++;
    }

    get size() { return this.count; }
    get isReady() { return this.count >= ClassifierConfig.MIN_POINTS; }

    // Retorna os dados organizados em arrays separados por eixo (para facilitar cálculos matemáticos)
    getArrays() {
        const result = {
            ax: new Array(this.count),
            ay: new Array(this.count),
            az: new Array(this.count),
            gx: new Array(this.count),
            gy: new Array(this.count),
            gz: new Array(this.count),
            vib: new Array(this.count)
        };

        for (let i = 0; i < this.count; i++) {
            const idx = (this.head - this.count + i + this.maxSize) % this.maxSize;
            const point = this.buffer[idx];
            result.ax[i] = point.ax;
            result.ay[i] = point.ay;
            result.az[i] = point.az;
            result.gx[i] = point.gx;
            result.gy[i] = point.gy;
            result.gz[i] = point.gz;
            result.vib[i] = point.vib;
        }
        return result;
    }

    clear() {
        this.buffer = new Array(this.maxSize);
        this.head = 0;
        this.count = 0;
    }
}

// =============================================================================
// STATISTICAL FUNCTIONS
// =============================================================================

const Stats = {
    // Média aritmética
    mean(arr) {
        if (!arr || arr.length === 0) return 0;
        let sum = 0;
        for (let i = 0; i < arr.length; i++) sum += arr[i];
        return sum / arr.length;
    },

    // Desvio Padrão populacional (ddof=0) - alinhado com np.std(ddof=0) do Python
    std(arr) {
        if (!arr || arr.length < 2) return 0;
        const m = this.mean(arr);
        let sumSq = 0;
        for (let i = 0; i < arr.length; i++) {
            const diff = arr[i] - m;
            sumSq += diff * diff;
        }
        return Math.sqrt(sumSq / arr.length);
    },

    // RMS (Root Mean Square)
    rms(arr) {
        if (!arr || arr.length === 0) return 0;
        let sumSq = 0;
        for (let i = 0; i < arr.length; i++) sumSq += arr[i] * arr[i];
        return Math.sqrt(sumSq / arr.length);
    },

    // Peak: percentil 95 dos valores absolutos
    // Usa P95 em vez de max para evitar outliers e tornar transições simétricas
    peak(arr) {
        if (!arr || arr.length === 0) return 0;
        const absVals = new Array(arr.length);
        for (let i = 0; i < arr.length; i++) absVals[i] = Math.abs(arr[i]);
        absVals.sort((a, b) => a - b);
        const idx = Math.floor(0.95 * (absVals.length - 1));
        return absVals[idx];
    },

    // Mean absolute value
    meanAbs(arr) {
        if (!arr || arr.length === 0) return 0;
        let sum = 0;
        for (let i = 0; i < arr.length; i++) sum += Math.abs(arr[i]);
        return sum / arr.length;
    },

    // Root amplitude: (mean(sqrt(|x|)))^2
    rootAmplitude(arr) {
        if (!arr || arr.length === 0) return 0;
        let sum = 0;
        for (let i = 0; i < arr.length; i++) sum += Math.sqrt(Math.abs(arr[i]));
        const m = sum / arr.length;
        return m * m;
    },

    // Skewness (bias=True, alinhado com scipy.stats.skew(bias=True))
    skew(arr) {
        if (!arr || arr.length < 3) return 0;
        const n = arr.length;
        const m = this.mean(arr);
        let m2 = 0, m3 = 0;
        for (let i = 0; i < n; i++) {
            const d = arr[i] - m;
            m2 += d * d;
            m3 += d * d * d;
        }
        m2 /= n;
        m3 /= n;
        const s = Math.sqrt(m2);
        if (s < 1e-10) return 0;
        return m3 / (s * s * s);
    },

    // Kurtosis (Fisher, bias=True, alinhado com scipy.stats.kurtosis(fisher=True, bias=True))
    kurtosis(arr) {
        if (!arr || arr.length < 4) return 0;
        const n = arr.length;
        const m = this.mean(arr);
        let m2 = 0, m4 = 0;
        for (let i = 0; i < n; i++) {
            const d = arr[i] - m;
            const d2 = d * d;
            m2 += d2;
            m4 += d2 * d2;
        }
        m2 /= n;
        m4 /= n;
        if (m2 < 1e-10) return 0;
        return (m4 / (m2 * m2)) - 3.0;
    },

    // Crest factor: peak / rms
    crestFactor(arr) {
        const r = this.rms(arr);
        return r > 1e-10 ? this.peak(arr) / r : 0;
    },

    // Shape factor: rms / meanAbs
    shapeFactor(arr) {
        const ma = this.meanAbs(arr);
        return ma > 1e-10 ? this.rms(arr) / ma : 0;
    },

    // Impulse factor: peak / meanAbs
    impulseFactor(arr) {
        const ma = this.meanAbs(arr);
        return ma > 1e-10 ? this.peak(arr) / ma : 0;
    },

    // Clearance factor: peak / rootAmplitude
    clearanceFactor(arr) {
        const ra = this.rootAmplitude(arr);
        return ra > 1e-10 ? this.peak(arr) / ra : 0;
    },

    // Range (mantido para compatibilidade)
    range(arr) {
        if (!arr || arr.length === 0) return 0;
        let min = arr[0], max = arr[0];
        for (let i = 1; i < arr.length; i++) {
            if (arr[i] < min) min = arr[i];
            if (arr[i] > max) max = arr[i];
        }
        return max - min;
    },

    max(arr) {
        if (!arr || arr.length === 0) return 0;
        let max = arr[0];
        for (let i = 1; i < arr.length; i++) {
            if (arr[i] > max) max = arr[i];
        }
        return max;
    }
};

// =============================================================================
// FEATURE EXTRACTOR
// =============================================================================

class FeatureExtractor {
    // Calcula 11 metricas estatisticas para um eixo
    // Alinhado com compute_features() do notebook 01 (ddof=0, bias=True)
    static _axisFeatures(arr, prefix) {
        return {
            [`${prefix}_mean`]: Stats.mean(arr),
            [`${prefix}_std`]: Stats.std(arr),
            [`${prefix}_skew`]: Stats.skew(arr),
            [`${prefix}_kurtosis`]: Stats.kurtosis(arr),
            [`${prefix}_rms`]: Stats.rms(arr),
            [`${prefix}_peak`]: Stats.peak(arr),
            [`${prefix}_root_amplitude`]: Stats.rootAmplitude(arr),
            [`${prefix}_crest_factor`]: Stats.crestFactor(arr),
            [`${prefix}_shape_factor`]: Stats.shapeFactor(arr),
            [`${prefix}_impulse_factor`]: Stats.impulseFactor(arr),
            [`${prefix}_clearance_factor`]: Stats.clearanceFactor(arr),
        };
    }

    // Extrai 66 features (11 metricas x 6 eixos) - identico ao pipeline Python
    static extract(data) {
        const { ax, ay, az, gx, gy, gz } = data;

        return {
            ...this._axisFeatures(ax, 'accel_x_g'),
            ...this._axisFeatures(ay, 'accel_y_g'),
            ...this._axisFeatures(az, 'accel_z_g'),
            ...this._axisFeatures(gx, 'gyro_x_dps'),
            ...this._axisFeatures(gy, 'gyro_y_dps'),
            ...this._axisFeatures(gz, 'gyro_z_dps'),
        };
    }
}

// =============================================================================
// GAUSSIAN NAIVE BAYES CLASSIFIER (3 CLASSES)
// Algoritmo probabilístico que calcula qual a chance dos dados pertencerem a cada classe
// =============================================================================

class GaussianNBClassifier {
    constructor() {
        this.model = null;
        this.isLoaded = false;
    }

    // Carrega o arquivo JSON com as médias e variâncias treinadas
    async load(modelData) {
        try {
            let model = typeof modelData === 'string'
                ? await (await fetch(modelData)).json()
                : modelData;

            if (!model.features || !model.stats || !model.priors || !model.labels) {
                throw new Error('Model missing required fields');
            }

            this.model = model;
            this.isLoaded = true;

            console.log(`[Classifier] Model v${model.version} loaded: ${model.labels.length} classes, ${model.features.length} features`);
            console.log(`[Classifier] Classes: ${model.labels.join(', ')}`);

            return true;
        } catch (error) {
            console.error('[Classifier] Load failed:', error);
            this.isLoaded = false;
            return false;
        }
    }

    // Realiza a predição matemática
    predict(features) {
        if (!this.isLoaded) {
            return {
                prediction: 'UNKNOWN',
                confidence: 0,
                probabilities: {},
                error: 'Model not loaded'
            };
        }

        const labels = this.model.labels;
        const logProbs = {};

        // Para cada classe (LOW, MEDIUM, HIGH)...
        for (const label of labels) {
            logProbs[label] = Math.log(this.model.priors[label]);

            // ...somamos a probabilidade de cada feature (baseado na curva Gaussiana)
            for (const featureName of this.model.features) {
                const value = features[featureName];
                if (value === undefined || value === null) continue;

                // Pega a média e variância aprendidas no treinamento para essa feature nessa classe
                const stats = this.model.stats[label][featureName];
                if (!stats) continue;

                // Piso de variância: evita que features com variância ultra-baixa
                // (ex: 9e-7) dominem a classificação com z-scores extremos
                const variance = Math.max(stats.var, 1e-3);
                logProbs[label] += -0.5 * Math.log(2 * Math.PI * variance)
                    - Math.pow(value - stats.mean, 2) / (2 * variance);
            }
        }

        // Converte log-probabilidade de volta para porcentagem (0 a 1)
        const maxLogProb = Math.max(...Object.values(logProbs));
        const expProbs = {};
        let sumExp = 0;

        for (const label of labels) {
            expProbs[label] = Math.exp(logProbs[label] - maxLogProb);
            sumExp += expProbs[label];
        }

        const probabilities = {};
        for (const label of labels) {
            probabilities[label] = expProbs[label] / sumExp;
        }

        // Escolhe a classe com a maior probabilidade
        let prediction = labels[0];
        let maxProb = probabilities[labels[0]];

        for (const label of labels) {
            if (probabilities[label] > maxProb) {
                maxProb = probabilities[label];
                prediction = label;
            }
        }

        return {
            prediction,
            confidence: maxProb,
            probabilities
        };
    }

    getInfo() {
        if (!this.isLoaded) return null;
        return {
            type: this.model.type,
            version: this.model.version,
            features: this.model.features,
            labels: this.model.labels,
            accuracy: this.model.metrics?.train_accuracy
        };
    }
}

// =============================================================================
// REAL-TIME CLASSIFIER
// =============================================================================

class RealTimeClassifier {
    constructor() {
        this.buffer = new CircularBuffer();
        this.classifier = new GaussianNBClassifier();
        this.lastPrediction = null;
        this.predictionHistory = [];
        this.maxHistory = 50;
        this.onPrediction = null;
        this.smoothedConfidence = { LOW: 0.33, MEDIUM: 0.34, HIGH: 0.33 };
        this.feedCount = 0;

        // Hysteresis
        this.confirmedState = null;
        this.candidateState = null;
        this.candidateCount = 0;
        this.featureModeUntil = 0;

        // Transition tracking
        this.transitionStartTime = null;   // quando candidato começou a divergir
        this.transitionLog = [];           // últimas N transições
        this.maxTransitionLog = 20;
        this.onTransition = null;          // callback para dashboard
    }

    async init(modelData) {
        const success = await this.classifier.load(modelData);
        if (success) {
            // Initialize smoothed confidence based on model labels
            const labels = this.classifier.model.labels;
            this.smoothedConfidence = {};
            for (const label of labels) {
                this.smoothedConfidence[label] = 1 / labels.length;
            }
            console.log('[RealTimeClassifier] v5.0 initialized - TRUE 3-class mode');
        }
        return success;
    }

    addData(data) {
        this.buffer.push(data);
        this.feedCount++;
        this._detectAbruptChange();
    }

    /**
     * Detecta mudança brusca comparando P95 dos últimos N pontos vs primeira metade do buffer.
     * Usa P95(|gz|) em vez de média para alinhar com a feature peak do modelo.
     */
    _detectAbruptChange() {
        const cfg = ClassifierConfig;
        if (this.buffer.size < cfg.MIN_POINTS) return;

        const arrays = this.buffer.getArrays();
        const gz = arrays.gz;
        const n = gz.length;
        const recentN = cfg.CHANGE_DETECT_WINDOW;
        if (n < recentN * 2) return;

        // P95 dos valores absolutos: primeira metade vs últimos N pontos
        const oldAbs = [];
        for (let i = 0; i < n - recentN; i++) oldAbs.push(Math.abs(gz[i]));
        const recentAbs = [];
        for (let i = n - recentN; i < n; i++) recentAbs.push(Math.abs(gz[i]));

        oldAbs.sort((a, b) => a - b);
        recentAbs.sort((a, b) => a - b);

        const p95Old = oldAbs[Math.floor(0.95 * (oldAbs.length - 1))];
        const p95Recent = recentAbs[Math.floor(0.95 * (recentAbs.length - 1))];

        if (p95Old > 1) {
            const ratio = p95Recent / p95Old;
            if (ratio < cfg.CHANGE_DETECT_RATIO || ratio > (1 / cfg.CHANGE_DETECT_RATIO)) {
                console.log(`[ChangeDetect] Mudança brusca: ratio=${ratio.toFixed(2)} (P95 recent=${p95Recent.toFixed(1)} vs old=${p95Old.toFixed(1)}). Flush.`);
                this._fastFlush();
            }
        }
    }

    /**
     * Flush parcial: mantém apenas os últimos N pontos, resetando suavização e histerese.
     */
    _fastFlush() {
        const keep = ClassifierConfig.FAST_FLUSH_KEEP;
        const arrays = this.buffer.getArrays();
        const n = this.buffer.size;
        if (n <= keep) return;

        // Rebuild buffer with only recent points
        this.buffer.clear();
        for (let i = n - keep; i < n; i++) {
            this.buffer.push({
                ax: arrays.ax[i], ay: arrays.ay[i], az: arrays.az[i],
                gx: arrays.gx[i], gy: arrays.gy[i], gz: arrays.gz[i],
                vib: arrays.vib[i], timestamp: Date.now()
            });
        }

        // Reset smoothing to uniform (fresh start)
        const labels = this.classifier.model?.labels || ['LOW', 'MEDIUM', 'HIGH'];
        for (const label of labels) {
            this.smoothedConfidence[label] = 1 / labels.length;
        }

        // Reset hysteresis
        this.confirmedState = null;
        this.candidateState = null;
        this.candidateCount = 0;
    }

    markFeatureMode(ttlMs = 3000) {
        this.featureModeUntil = Date.now() + ttlMs;
    }

    isFeatureModeActive() {
        return Date.now() < this.featureModeUntil;
    }

    clearFeatureMode() {
        this.featureModeUntil = 0;
    }

    _applyResult(result, features, bufferSizeOverride = null) {
        const labels = this.classifier.model.labels;

        // Suavização Exponencial: A nova confiança é uma média da atual com a anterior
        const alpha = ClassifierConfig.SMOOTHING_ALPHA;
        for (const label of labels) {
            const prob = result.probabilities[label] || 0;
            this.smoothedConfidence[label] = alpha * prob + (1 - alpha) * this.smoothedConfidence[label];
        }

        // Normalize
        const total = Object.values(this.smoothedConfidence).reduce((a, b) => a + b, 0);
        for (const label of labels) {
            this.smoothedConfidence[label] /= total;
        }

        // Find best smoothed prediction
        let rawSmoothedPrediction = labels[0];
        let smoothedConfValue = this.smoothedConfidence[labels[0]];

        for (const label of labels) {
            if (this.smoothedConfidence[label] > smoothedConfValue) {
                smoothedConfValue = this.smoothedConfidence[label];
                rawSmoothedPrediction = label;
            }
        }

        const sortedProbs = labels
            .map(label => ({ label, prob: this.smoothedConfidence[label] || 0 }))
            .sort((a, b) => b.prob - a.prob);
        const top1 = sortedProbs[0] || { label: rawSmoothedPrediction, prob: smoothedConfValue };
        const top2 = sortedProbs[1] || { label: null, prob: 0 };
        const confidenceGap = top1.prob - top2.prob;
        const confidenceOk = top1.prob >= ClassifierConfig.CONFIDENCE_GATE &&
            confidenceGap >= ClassifierConfig.CONFIDENCE_MARGIN;

        // Aplica HISTERESE: Só muda o estado se a nova predição se mantiver por N vezes
        let finalPrediction;
        const previousConfirmed = this.confirmedState;

        if (!confidenceOk) {
            if (this.confirmedState === null) {
                this.confirmedState = rawSmoothedPrediction;
                this.candidateState = rawSmoothedPrediction;
                this.candidateCount = 0;
            }
            finalPrediction = this.confirmedState;
        } else {
            if (this.confirmedState === null) {
                this.confirmedState = rawSmoothedPrediction;
                this.candidateState = rawSmoothedPrediction;
                this.candidateCount = ClassifierConfig.HYSTERESIS_COUNT;
                finalPrediction = rawSmoothedPrediction;
            } else if (rawSmoothedPrediction === this.confirmedState) {
                this.candidateState = rawSmoothedPrediction;
                this.candidateCount = 0;
                this.transitionStartTime = null; // estável, sem transição pendente
                finalPrediction = this.confirmedState;
            } else if (rawSmoothedPrediction === this.candidateState) {
                // Marcar início da transição
                if (this.transitionStartTime === null) {
                    this.transitionStartTime = Date.now();
                }
                this.candidateCount++;
                if (this.candidateCount >= ClassifierConfig.HYSTERESIS_COUNT) {
                    this.confirmedState = this.candidateState;
                    finalPrediction = this.confirmedState;
                    console.log(`[Hysteresis] State confirmed: ${this.confirmedState}`);
                } else {
                    finalPrediction = this.confirmedState;
                }
            } else {
                this.candidateState = rawSmoothedPrediction;
                this.candidateCount = 1;
                this.transitionStartTime = Date.now();
                finalPrediction = this.confirmedState;
            }
        }

        // Registrar transição quando estado confirmado muda
        if (previousConfirmed !== null && this.confirmedState !== previousConfirmed) {
            const transitionMs = this.transitionStartTime
                ? Date.now() - this.transitionStartTime
                : 0;
            const entry = {
                from: previousConfirmed,
                to: this.confirmedState,
                duration_ms: transitionMs,
                duration_s: +(transitionMs / 1000).toFixed(1),
                timestamp: Date.now(),
                time: new Date().toLocaleTimeString('pt-BR'),
                confidence: smoothedConfValue,
                bufferSize: bufferSizeOverride ?? this.buffer.size,
                featureAgreement: this._calcFeatureAgreement(features),
            };
            this.transitionLog.push(entry);
            while (this.transitionLog.length > this.maxTransitionLog) {
                this.transitionLog.shift();
            }
            this.transitionStartTime = null;
            console.log(`[Transition] ${entry.from} → ${entry.to} em ${entry.duration_s}s (concordância: ${entry.featureAgreement.ratio})`);

            if (this.onTransition) {
                this.onTransition(entry);
            }
        }

        // Confidence level
        let confidenceLevel;
        if (smoothedConfValue >= ClassifierConfig.CONFIDENCE_HIGH) {
            confidenceLevel = 'high';
        } else if (smoothedConfValue >= ClassifierConfig.CONFIDENCE_MEDIUM) {
            confidenceLevel = 'medium';
        } else {
            confidenceLevel = 'low';
        }

        const prediction = {
            status: 'ok',
            prediction: finalPrediction,
            rawPrediction: result.prediction,
            confidence: smoothedConfValue,
            rawConfidence: result.confidence,
            confidenceLevel,
            confidenceGap,
            gateActive: !confidenceOk,
            probabilities: result.probabilities,
            smoothedProbabilities: { ...this.smoothedConfidence },
            bufferSize: bufferSizeOverride ?? this.buffer.size,
            timestamp: Date.now(),
            features,
            confirmedState: this.confirmedState,
            candidateState: this.candidateState,
            candidateCount: this.candidateCount,
            hysteresisCount: ClassifierConfig.HYSTERESIS_COUNT,
            featureAgreement: this._calcFeatureAgreement(features),
            transitionPending: this.transitionStartTime !== null,
            transitionElapsed: this.transitionStartTime ? Date.now() - this.transitionStartTime : 0,
        };

        this.lastPrediction = prediction;
        this.predictionHistory.push({
            timestamp: prediction.timestamp,
            prediction: prediction.prediction,
            confidence: prediction.confidence
        });

        while (this.predictionHistory.length > this.maxHistory) {
            this.predictionHistory.shift();
        }

        if (this.onPrediction) {
            this.onPrediction(prediction);
        }

        return prediction;
    }

    predictWithFeatures(features, windowSize = null) {
        if (!this.classifier.isLoaded) {
            return {
                status: 'error',
                message: 'Model not loaded',
                prediction: 'UNKNOWN',
                confidence: 0
            };
        }

        if (!features) {
            return {
                status: 'error',
                message: 'Features missing',
                prediction: 'UNKNOWN',
                confidence: 0
            };
        }

        const result = this.classifier.predict(features);
        this.markFeatureMode();
        return this._applyResult(result, features, windowSize);
    }

    predict() {
        if (!this.classifier.isLoaded) {
            return {
                status: 'error',
                message: 'Model not loaded',
                prediction: 'UNKNOWN',
                confidence: 0
            };
        }

        if (!this.buffer.isReady) {
            const progress = this.buffer.size / ClassifierConfig.MIN_POINTS;
            return {
                status: 'buffering',
                message: `Coletando: ${this.buffer.size}/${ClassifierConfig.MIN_POINTS}`,
                prediction: 'BUFFERING',
                confidence: 0,
                bufferProgress: progress
            };
        }

        // Extract features
        const data = this.buffer.getArrays();
        const features = FeatureExtractor.extract(data);

        // Run classification
        const result = this.classifier.predict(features);
        return this._applyResult(result, features, this.buffer.size);
    }

    /**
     * Calcula quantas features apontam para cada classe (por proximidade z-score)
     */
    _calcFeatureAgreement(features) {
        if (!this.classifier.model || !features) return { ratio: '--', counts: {} };
        const model = this.classifier.model;
        const counts = {};
        for (const label of model.labels) counts[label] = 0;
        let total = 0;

        for (const fname of model.features) {
            const v = features[fname];
            if (v === undefined || v === null) continue;
            let bestLabel = null;
            let bestZ = Infinity;
            for (const label of model.labels) {
                const s = model.stats[label]?.[fname];
                if (!s) continue;
                const std = Math.sqrt(Math.max(s.var, 1e-3));
                const z = Math.abs(v - s.mean) / std;
                if (z < bestZ) { bestZ = z; bestLabel = label; }
            }
            if (bestLabel) { counts[bestLabel]++; total++; }
        }

        const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
        return {
            counts,
            best: best ? best[0] : '--',
            bestCount: best ? best[1] : 0,
            total,
            ratio: best ? `${best[1]}/${total} → ${best[0]}` : '--',
        };
    }

    getTransitionLog() {
        return this.transitionLog;
    }

    getStability() {
        if (this.predictionHistory.length < 5) return 0;
        const recent = this.predictionHistory.slice(-10);
        const counts = {};
        for (const p of recent) {
            counts[p.prediction] = (counts[p.prediction] || 0) + 1;
        }
        return Math.max(...Object.values(counts)) / recent.length;
    }

    getModelInfo() {
        return this.classifier.getInfo();
    }

    getStats() {
        return {
            bufferSize: this.buffer.size,
            feedCount: this.feedCount,
            predictionCount: this.predictionHistory.length,
            stability: this.getStability()
        };
    }

    reset() {
        this.buffer.clear();
        this.lastPrediction = null;
        this.predictionHistory = [];
        this.feedCount = 0;

        // Reset smoothed confidence
        const labels = this.classifier.model?.labels || ['LOW', 'MEDIUM', 'HIGH'];
        this.smoothedConfidence = {};
        for (const label of labels) {
            this.smoothedConfidence[label] = 1 / labels.length;
        }

        // Reset hysteresis
        this.confirmedState = null;
        this.candidateState = null;
        this.candidateCount = 0;
        this.featureModeUntil = 0;
    }

    get isReady() {
        return this.classifier.isLoaded;
    }
}

// =============================================================================
// EXPORTS
// =============================================================================

window.ClassifierConfig = ClassifierConfig;
window.CircularBuffer = CircularBuffer;
window.Stats = Stats;
window.FeatureExtractor = FeatureExtractor;
window.GaussianNBClassifier = GaussianNBClassifier;
window.RealTimeClassifier = RealTimeClassifier;
window.SlidingWindowBuffer = CircularBuffer; // Legacy

window.fanClassifier = new RealTimeClassifier();

console.log('[Classifier] v5.0 loaded - TRUE 3-class Gaussian NB (LOW/MEDIUM/HIGH)');
