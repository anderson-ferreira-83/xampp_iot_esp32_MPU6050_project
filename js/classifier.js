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
    // 100 pontos a 4Hz = analisamos os últimos 25 segundos de comportamento
    WINDOW_SIZE: 100,
    MIN_POINTS: 100, // Mínimo de pontos para começar a classificar

    // Confidence thresholds
    CONFIDENCE_HIGH: 0.70,
    CONFIDENCE_MEDIUM: 0.55,
    CONFIDENCE_GATE: 0.60,
    CONFIDENCE_MARGIN: 0.15,

    // Update frequency
    PREDICTION_INTERVAL_MS: 250,

    // Smoothing
    SMOOTHING_ALPHA: 0.5,

    // Histerese: Exige N previsões iguais consecutivas antes de mudar o estado oficial
    // Isso evita que o status fique piscando entre "LOW" e "MEDIUM" rapidamente
    HYSTERESIS_COUNT: 3,
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

    // Desvio Padrão (Standard Deviation): Mede o quanto os dados variam da média
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

    // RMS (Root Mean Square): Mede a magnitude/energia do sinal
    rms(arr) {
        if (!arr || arr.length === 0) return 0;
        let sumSq = 0;
        for (let i = 0; i < arr.length; i++) sumSq += arr[i] * arr[i];
        return Math.sqrt(sumSq / arr.length);
    },

    // Range (Amplitude): Diferença entre o valor máximo e mínimo
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
    // Transforma os dados brutos (arrays de pontos) em "Features" (estatísticas)
    // O modelo de ML não olha para os pontos brutos, mas sim para essas estatísticas.
    static extract(data) {
        const { ax, ay, az, gx, gy, gz, vib } = data;

        return {
            // Accelerometer features
            accel_x_g_std: Stats.std(ax),
            accel_x_g_range: Stats.range(ax),
            accel_x_g_rms: Stats.rms(ax),
            accel_y_g_std: Stats.std(ay),
            accel_z_g_std: Stats.std(az),

            // Gyroscope features
            gyro_x_dps_std: Stats.std(gx),
            gyro_x_dps_rms: Stats.rms(gx),
            gyro_x_dps_range: Stats.range(gx),
            gyro_y_dps_std: Stats.std(gy),
            gyro_y_dps_rms: Stats.rms(gy),
            gyro_y_dps_range: Stats.range(gy),
            gyro_z_dps_std: Stats.std(gz),

            gyro_z_dps_range: Stats.range(gz),
            gyro_z_dps_rms: Stats.rms(gz),

            // Vibration features
            vibration_dps_std: Stats.std(vib),
            vibration_dps_max: Stats.max(vib),
            vibration_dps_range: Stats.range(vib),
            vibration_dps_mean: Stats.mean(vib),
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

                const variance = Math.max(stats.var, 1e-10);
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
                finalPrediction = this.confirmedState;
            } else if (rawSmoothedPrediction === this.candidateState) {
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
                finalPrediction = this.confirmedState;
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
            hysteresisCount: ClassifierConfig.HYSTERESIS_COUNT
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
