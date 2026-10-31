import { existsSync } from 'fs'
import { join } from 'path'
import { availableParallelism } from 'os'
import { OfflineTts } from 'sherpa-onnx-node/non-streaming-tts'

export class TtsService {
  private tts: InstanceType<typeof OfflineTts> | null = null
  private voice = 'kokoro:2'
  private speed = 0.75
  private modelDir: string | null = null
  private lastError: string | null = null
  // sherpa-onnx's native Kokoro handle is not re-entrant in Electron.
  // Serialize every generation request even if multiple IPC calls arrive.
  private generationTail: Promise<void> = Promise.resolve()
  private pendingGenerations = 0
  private initialization: Promise<boolean> | null = null
  private reloadPromise: Promise<boolean> | null = null
  private readonly maxPendingGenerations = 4

  async init(modelDir: string) {
    if (this.tts && this.modelDir === modelDir) return true
    if (this.initialization) return this.initialization
    this.initialization = this.initialize(modelDir)
    try {
      return await this.initialization
    } finally {
      this.initialization = null
    }
  }

  /**
   * Replace the native Kokoro handle after a model download/update.  The
   * sherpa binding owns native memory, so disposing it while generateAsync is
   * using it can crash Electron.  Waiting for the serialized queue gives the
   * current utterance a clean boundary, then the next request sees the new
   * files without requiring an application restart.
   */
  async reload(modelDir: string): Promise<boolean> {
    if (this.reloadPromise) return this.reloadPromise
    this.reloadPromise = (async () => {
      await this.generationTail.catch(() => undefined)
      if (this.initialization) await this.initialization.catch(() => undefined)
      this.tts = null
      this.modelDir = null
      this.lastError = null
      return this.init(modelDir)
    })().finally(() => {
      this.reloadPromise = null
    })
    return this.reloadPromise
  }

  private async initialize(modelDir: string) {
    const required = ['model.onnx', 'voices.bin', 'tokens.txt', 'espeak-ng-data']
    if (!required.every((file) => existsSync(join(modelDir, file)))) {
      this.tts = null
      this.modelDir = null
      this.lastError = 'Kokoro 模型文件不完整。'
      return false
    }

    try {
      const numThreads = Math.max(2, Math.min(8, availableParallelism()))
      this.tts = await OfflineTts.createAsync({
        model: {
          kokoro: {
            model: join(modelDir, 'model.onnx'),
            voices: join(modelDir, 'voices.bin'),
            tokens: join(modelDir, 'tokens.txt'),
            dataDir: join(modelDir, 'espeak-ng-data')
          },
          debug: false,
          numThreads,
          provider: 'cpu'
        },
        // A single-sentence batch gives lower first-response latency on CPU.
        maxNumSentences: 1
      })
      this.modelDir = modelDir
      this.lastError = null
      return true
    } catch (error) {
      this.tts = null
      this.modelDir = null
      this.lastError = error instanceof Error ? error.message : 'Kokoro 初始化失败。'
      return false
    }
  }

  isInitialized() {
    return Boolean(this.tts)
  }

  getModelDir() {
    return this.modelDir
  }

  getLastError() {
    return this.lastError
  }

  async synthesize(text: string): Promise<Buffer> {
    const content = text.trim()
    if (!content) return Buffer.alloc(0)
    if (!this.tts) {
      throw new Error(this.lastError || '离线 Kokoro 语音模型尚未初始化。')
    }

    if (this.pendingGenerations >= this.maxPendingGenerations) {
      throw new Error('语音生成任务较多，请等待当前语音播放完成后再重听。')
    }

    let releaseGeneration!: () => void
    const previousGeneration = this.generationTail
    this.generationTail = new Promise<void>((resolve) => {
      releaseGeneration = resolve
    })
    this.pendingGenerations += 1

    try {
      await previousGeneration
      const sid = Number(this.voice.split(':')[1] || 2)
      const audio = await this.tts.generateAsync({
        text: content,
        // Electron cannot safely receive native external ArrayBuffers from the
        // addon. Force copied buffers and never access this handle concurrently.
        enableExternalBuffer: false,
        sid,
        speed: this.speed
      })
      return this.encodeWav(audio.samples, audio.sampleRate)
    } finally {
      releaseGeneration()
      this.pendingGenerations -= 1
    }
  }

  setVoice(voice: string) {
    this.voice = TTS_VOICES.some((item) => item.id === voice) ? voice : 'kokoro:2'
  }

  getVoice() {
    return this.voice
  }

  setSpeed(speed: number) {
    if (!Number.isFinite(speed)) return
    this.speed = Math.max(0.6, Math.min(1.2, Math.round(speed * 20) / 20))
  }

  getSpeed() {
    return this.speed
  }

  getVoices() {
    return TTS_VOICES
  }

  private encodeWav(samples: Float32Array, sampleRate: number) {
    const dataSize = samples.length * 2
    const buffer = Buffer.alloc(44 + dataSize)
    buffer.write('RIFF', 0)
    buffer.writeUInt32LE(36 + dataSize, 4)
    buffer.write('WAVE', 8)
    buffer.write('fmt ', 12)
    buffer.writeUInt32LE(16, 16)
    buffer.writeUInt16LE(1, 20)
    buffer.writeUInt16LE(1, 22)
    buffer.writeUInt32LE(sampleRate, 24)
    buffer.writeUInt32LE(sampleRate * 2, 28)
    buffer.writeUInt16LE(2, 32)
    buffer.writeUInt16LE(16, 34)
    buffer.write('data', 36)
    buffer.writeUInt32LE(dataSize, 40)
    for (let index = 0; index < samples.length; index += 1) {
      const sample = Math.max(-1, Math.min(1, samples[index]))
      buffer.writeInt16LE(sample < 0 ? sample * 0x8000 : sample * 0x7fff, 44 + index * 2)
    }
    return buffer
  }
}

export const TTS_VOICES = [
  { id: 'kokoro:2', label: 'Nicole（女声，美国，自然）' },
  { id: 'kokoro:1', label: 'Bella（女声，美国）' },
  { id: 'kokoro:3', label: 'Sarah（女声，美国）' },
  { id: 'kokoro:5', label: 'Adam（男声，美国）' },
  { id: 'kokoro:6', label: 'Michael（男声，美国）' },
  { id: 'kokoro:7', label: 'Emma（女声，英国）' },
  { id: 'kokoro:9', label: 'George（男声，英国）' }
]
