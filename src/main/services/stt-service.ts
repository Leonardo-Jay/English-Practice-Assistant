import { existsSync } from 'fs'
import { join } from 'path'
import { app } from 'electron'
import { OnlineRecognizer, OnlineStream } from 'sherpa-onnx-node/streaming-asr'
import { OfflineRecognizer } from 'sherpa-onnx-node/non-streaming-asr'

export interface SttResult {
  text: string
  isEndpoint: boolean
}

export interface SttStatus {
  initialized: boolean
  message: string
  modelDir?: string
  configuredModelDir?: string
  defaultInstallDir: string
  requiredFiles: string[]
  missingFiles: string[]
  searchedDirs: string[]
  supportsPartialResults: boolean
}

export class SttService {
  private recognizer: OnlineRecognizer | null = null
  private stream: OnlineStream | null = null
  private offlineRecognizer: InstanceType<typeof OfflineRecognizer> | null = null
  private offlineStream: ReturnType<InstanceType<typeof OfflineRecognizer>['createStream']> | null = null
  private modelKind: 'streaming-transducer' | 'offline-fire-red' | 'offline-sense-voice' | null = null
  private finalizedSegments: string[] = []
  private initialized = false
  private modelDir: string | null = null
  private statusMessage = '语音识别尚未初始化。'

  private readonly requiredModelFiles = [
    'encoder.onnx',
    'decoder.onnx',
    'joiner.onnx',
    'tokens.txt'
  ]

  getDefaultInstallDir() {
    return join(app.getPath('userData'), 'models', 'stt')
  }

  private resolveCandidateDirs(explicitDir?: string) {
    return [
      explicitDir,
      process.env.STT_MODEL_DIR,
      this.getDefaultInstallDir(),
      join(process.cwd(), 'models', 'stt'),
      join(app.getAppPath(), 'models', 'stt'),
      join(process.resourcesPath, 'models', 'stt'),
      join(__dirname, '../../models/stt')
    ].filter((value, index, list): value is string => Boolean(value) && list.indexOf(value) === index)
  }

  private findAvailableModelDir(explicitDir?: string) {
    for (const dir of this.resolveCandidateDirs(explicitDir)) {
      if (this.detectModelKind(dir)) {
        return dir
      }
    }

    return null
  }

  init(modelDir?: string) {
    const dir = this.findAvailableModelDir(modelDir)

    if (!dir) {
      this.recognizer = null
      this.stream = null
      this.offlineRecognizer = null
      this.offlineStream = null
      this.modelKind = null
      this.modelDir = null
      this.initialized = false
      this.statusMessage =
        '未找到语音识别模型文件。请将 encoder.onnx、decoder.onnx、joiner.onnx 和 tokens.txt 放到 models/stt 目录下，或使用界面中的一键安装功能。'
      return false
    }

    try {
      const modelKind = this.detectModelKind(dir)
      // Settings and capture startup both probe STT. Reusing the loaded native
      // recognizer prevents repeated model allocations for the same directory.
      if (
        this.initialized &&
        this.modelDir === dir &&
        this.modelKind === modelKind &&
        (this.recognizer || this.offlineRecognizer)
      ) {
        return true
      }
      if (modelKind === 'offline-fire-red' || modelKind === 'offline-sense-voice') {
        this.offlineRecognizer = new OfflineRecognizer({
          featConfig: { sampleRate: 16000, featureDim: 80 },
          modelConfig: {
            ...(modelKind === 'offline-fire-red'
              ? {
                  fireRedAsr: {
                    encoder: join(dir, 'encoder.int8.onnx'),
                    decoder: join(dir, 'decoder.int8.onnx')
                  }
                }
              : {
                  senseVoice: {
                    model: join(dir, 'sense-voice.int8.onnx'),
                    language: 'auto',
                    useInverseTextNormalization: 1
                  }
                }),
            tokens: join(dir, 'tokens.txt'),
            numThreads: 2,
            provider: 'cpu'
          }
        })
        this.recognizer = null
        this.modelKind = modelKind
      } else {
        this.offlineRecognizer = null
        this.recognizer = new OnlineRecognizer({
        featConfig: { sampleRate: 16000, featureDim: 80 },
        modelConfig: {
          transducer: {
            encoder: join(dir, 'encoder.onnx'),
            decoder: join(dir, 'decoder.onnx'),
            joiner: join(dir, 'joiner.onnx'),
          },
          tokens: join(dir, 'tokens.txt'),
          numThreads: 2,
          provider: 'cpu',
        },
        decodingMethod: 'greedy_search',
        endpointConfig: {
          // Allow natural thinking pauses without prematurely sending a turn.
          rule1: { mustContainNonSilence: true, minTrailingSilence: 5.0, minUtteranceLength: 0 },
          rule2: { mustContainNonSilence: false, minTrailingSilence: 7.0, minUtteranceLength: 0 },
          // Keep a safety limit for accidentally abandoned recordings, but do
          // not cut off an ordinary longer answer after only 20 seconds.
          rule3: { mustContainNonSilence: false, minTrailingSilence: 0, minUtteranceLength: 60 },
        },
        enableEndpoint: true,
        })
        this.modelKind = 'streaming-transducer'
      }
      this.modelDir = dir
      this.initialized = true
      this.statusMessage = `语音识别已就绪（${dir}）。`
    } catch (err) {
      console.error('Failed to initialize STT service:', err)
      this.recognizer = null
      this.stream = null
      this.offlineRecognizer = null
      this.offlineStream = null
      this.modelKind = null
      this.modelDir = null
      this.initialized = false
      this.statusMessage = err instanceof Error ? err.message : '初始化语音识别服务失败。'
    }

    return this.initialized
  }

  isInitialized(): boolean {
    return this.initialized
  }

  getMissingFiles(dir?: string | null) {
    if (!dir) {
      return [...this.requiredModelFiles]
    }

    const fireRedFiles = ['encoder.int8.onnx', 'decoder.int8.onnx', 'tokens.txt']
    const senseVoiceFiles = ['sense-voice.int8.onnx', 'tokens.txt']
    const required = existsSync(join(dir, 'sense-voice.int8.onnx'))
      ? senseVoiceFiles
      : fireRedFiles.some((file) => existsSync(join(dir, file)))
        ? fireRedFiles
        : this.requiredModelFiles
    return required.filter((file) => !existsSync(join(dir, file)))
  }

  getStatus(configuredModelDir?: string): SttStatus {
    return {
      initialized: this.initialized,
      message: this.statusMessage,
      modelDir: this.modelDir || undefined,
      configuredModelDir: configuredModelDir || undefined,
      defaultInstallDir: this.getDefaultInstallDir(),
      requiredFiles:
        this.modelKind === 'offline-sense-voice'
          ? ['sense-voice.int8.onnx', 'tokens.txt']
          : this.modelKind === 'offline-fire-red'
          ? ['encoder.int8.onnx', 'decoder.int8.onnx', 'tokens.txt']
          : [...this.requiredModelFiles],
      missingFiles: this.getMissingFiles(this.modelDir || configuredModelDir),
      searchedDirs: this.resolveCandidateDirs(configuredModelDir),
      supportsPartialResults: this.modelKind === 'streaming-transducer'
    }
  }

  start() {
    if (!this.recognizer && !this.offlineRecognizer) throw new Error('语音识别服务尚未初始化。')
    if (this.offlineRecognizer) {
      this.offlineStream = this.offlineRecognizer.createStream()
    } else {
      this.stream = this.recognizer!.createStream()
    }
    this.finalizedSegments = []
  }

  feedChunk(samples: Float32Array): SttResult {
    if (this.offlineRecognizer && this.offlineStream) {
      this.offlineStream.acceptWaveform({ samples, sampleRate: 16000 })
      return { text: '', isEndpoint: false }
    }

    if (!this.recognizer || !this.stream) {
      throw new Error('语音识别尚未开始。')
    }

    // Feed to recognizer
    this.stream.acceptWaveform({ samples, sampleRate: 16000 })

    while (this.recognizer.isReady(this.stream)) {
      this.recognizer.decode(this.stream)
    }

    const isEndpoint = this.recognizer.isEndpoint(this.stream)
    const result = this.recognizer.getResult(this.stream)

    // Preserve every completed utterance before resetting the online stream.
    // Otherwise stop() can only return the text spoken after the last pause.
    if (isEndpoint) {
      this.appendFinalizedSegment(result.text)
      this.recognizer.reset(this.stream)
    }

    return {
      text: this.combineTranscript(isEndpoint ? '' : result.text),
      isEndpoint
    }
  }

  async stop(): Promise<string> {
    if (this.offlineRecognizer && this.offlineStream) {
      const stream = this.offlineStream
      this.offlineStream = null
      await this.offlineRecognizer.decodeAsync(stream)
      return this.offlineRecognizer.getResult(stream).text || ''
    }

    if (!this.recognizer || !this.stream) {
      return ''
    }

    // Signal input finished and get final result
    this.stream.inputFinished()
    while (this.recognizer.isReady(this.stream)) {
      this.recognizer.decode(this.stream)
    }
    const result = this.recognizer.getResult(this.stream)
    this.appendFinalizedSegment(result.text)
    const transcript = this.combineTranscript()

    this.stream = null
    this.finalizedSegments = []

    return transcript
  }

  private appendFinalizedSegment(text?: string) {
    const segment = (text || '').trim()
    if (segment) {
      this.finalizedSegments.push(segment)
    }
  }

  private combineTranscript(partial = '') {
    return [...this.finalizedSegments, partial.trim()]
      .filter(Boolean)
      .join(' ')
  }

  isSpeechDetected(): boolean {
    return false
  }

  private detectModelKind(dir: string): 'streaming-transducer' | 'offline-fire-red' | 'offline-sense-voice' | null {
    const hasSenseVoice = ['sense-voice.int8.onnx', 'tokens.txt']
      .every((file) => existsSync(join(dir, file)))
    if (hasSenseVoice) return 'offline-sense-voice'

    const hasFireRed = ['encoder.int8.onnx', 'decoder.int8.onnx', 'tokens.txt']
      .every((file) => existsSync(join(dir, file)))
    if (hasFireRed) return 'offline-fire-red'

    const hasStreaming = this.requiredModelFiles
      .every((file) => existsSync(join(dir, file)))
    return hasStreaming ? 'streaming-transducer' : null
  }
}
