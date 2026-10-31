import { app, net } from 'electron'
import {
  copyFileSync,
  cpSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync
} from 'fs'
import { basename, dirname, join, resolve } from 'path'
import { finished } from 'stream/promises'
import { execFile } from 'child_process'

export interface SttModelPreset {
  id: string
  label: string
  description: string
  archiveUrl: string
  modelType: 'streaming-transducer' | 'offline-fire-red' | 'offline-sense-voice'
  installed?: boolean
  modelDir?: string
}

export interface SttInstallerState {
  isInstalling: boolean
  presetId?: string
  progress: number
  message: string
  downloadedBytes: number
  totalBytes?: number
  error?: string
}

const STT_MODEL_PRESETS: SttModelPreset[] = [
  {
    id: 'sense-voice-small-int8',
    label: 'SenseVoice-Small INT8（轻量推荐）',
    description: '约 228 MB 的开源离线模型，支持中英日韩粤语、标点和小型 CPU，速度与准确率平衡。',
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-int8-2024-07-17.tar.bz2',
    modelType: 'offline-sense-voice'
  },
  {
    id: 'fire-red-asr2-2026-02-26',
    label: 'FireRedASR2 2026 高精度（强力推荐）',
    description: '2026 年中英双语 AED 模型，支持多种口音，准确率优先；约 1.2 GB，识别在停止录音后完成。',
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-fire-red-asr2-zh_en-int8-2026-02-26.tar.bz2',
    modelType: 'offline-fire-red'
  },
  {
    id: 'zipformer-en-2023-06-26',
    label: '英语高精度 Zipformer（推荐）',
    description: '英语专用流式模型，适合口语练习；准确率优先，模型较大、CPU 占用略高。',
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-en-2023-06-26.tar.bz2',
    modelType: 'streaming-transducer'
  },
  {
    id: 'zipformer-bilingual-zh-en',
    label: '英中双语 Zipformer',
    description: '支持英语、中文和中英混说；覆盖语言更广，但纯英语识别建议选择英语高精度模型。',
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20.tar.bz2',
    modelType: 'streaming-transducer'
  },
  {
    id: 'zipformer-en-20m',
    label: '英语轻量 Zipformer（低配置）',
    description: '约 2000 万参数的英语流式模型，下载更小、运行更快，准确率低于推荐模型。',
    archiveUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-streaming-zipformer-en-20M-2023-02-17.tar.bz2',
    modelType: 'streaming-transducer'
  }
]

const DOWNLOAD_RETRY_COUNT = 3
const DOWNLOAD_TIMEOUT_MS = 60_000
const KOKORO_TTS_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/kokoro-en-v0_19.tar.bz2'

export class SttModelInstallerService {
  private state: SttInstallerState = {
    isInstalling: false,
    progress: 0,
    message: '尚未开始安装 STT 模型。',
    downloadedBytes: 0
  }

  getPresets() {
    return STT_MODEL_PRESETS.map((preset) => {
      const modelDir = this.getPresetInstallDir(preset.id)
      return {
        ...preset,
        installed: this.hasRequiredFiles(preset, modelDir),
        modelDir
      }
    })
  }

  getPreset(presetId: string) {
    return STT_MODEL_PRESETS.find((item) => item.id === presetId)
  }

  getPresetInstallDir(presetId: string) {
    return join(app.getPath('userData'), 'models', 'stt', presetId)
  }

  getTtsModelDir() {
    return join(app.getPath('userData'), 'models', 'tts', 'kokoro-en-v0_19')
  }

  getTtsModelStatus() {
    const modelDir = this.getTtsModelDir()
    return {
      installed: ['model.onnx', 'voices.bin', 'tokens.txt', 'espeak-ng-data']
        .every((file) => existsSync(join(modelDir, file))),
      modelDir,
      installer: this.getState()
    }
  }

  async installTtsModel() {
    if (this.state.isInstalling) {
      throw new Error('另一个语音模型正在安装中，请稍候。')
    }
    const targetDir = this.getTtsModelDir()
    const workDir = join(app.getPath('userData'), 'stt-installer', `kokoro-${Date.now()}`)
    const archivePath = join(workDir, basename(new URL(KOKORO_TTS_URL).pathname))
    const extractDir = join(workDir, 'extracted')
    mkdirSync(extractDir, { recursive: true })
    this.setState({
      isInstalling: true,
      presetId: 'kokoro-en-v0_19',
      progress: 0,
      message: '准备下载离线 Kokoro 语音模型...',
      downloadedBytes: 0
    })
    try {
      await this.downloadArchive(KOKORO_TTS_URL, archivePath)
      this.setState({ ...this.state, progress: 72, message: '正在解压离线语音模型...' })
      await this.extractArchive(archivePath, extractDir)
      const modelFile = this.pickBestMatch(this.walkFiles(extractDir), [/\/model\.onnx$/i])
      if (!modelFile) throw new Error('Kokoro 模型包中缺少 model.onnx。')
      const sourceDir = dirname(modelFile)
      rmSync(targetDir, { recursive: true, force: true })
      mkdirSync(targetDir, { recursive: true })
      cpSync(sourceDir, targetDir, { recursive: true })
      this.setState({
        ...this.state,
        isInstalling: false,
        progress: 100,
        message: '离线 Kokoro 语音模型安装完成。'
      })
      return this.getTtsModelStatus()
    } catch (error) {
      const message = this.formatInstallerError(error)
      this.setState({ ...this.state, isInstalling: false, error: message, message })
      throw error
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  }

  getState(): SttInstallerState {
    return { ...this.state }
  }

  async installPreset(presetId: string, targetDir: string) {
    if (this.state.isInstalling) {
      while (this.state.isInstalling) {
        await this.delay(250)
      }
      const completedPreset = STT_MODEL_PRESETS.find((item) => item.id === presetId)
      if (completedPreset && this.hasRequiredFiles(completedPreset, targetDir)) {
        return
      }
    }

    const preset = STT_MODEL_PRESETS.find((item) => item.id === presetId)
    if (!preset) {
      throw new Error(`未知的语音识别模型预设：${presetId}`)
    }

    const workDir = join(app.getPath('userData'), 'stt-installer', `${preset.id}-${Date.now()}`)
    const archivePath = join(workDir, basename(new URL(preset.archiveUrl).pathname))
    const extractDir = join(workDir, 'extracted')

    mkdirSync(workDir, { recursive: true })
    mkdirSync(extractDir, { recursive: true })
    mkdirSync(targetDir, { recursive: true })

    this.setState({
      isInstalling: true,
      presetId,
      progress: 0,
      message: '准备下载 STT 模型...',
      downloadedBytes: 0,
      totalBytes: undefined,
      error: undefined
    })

    try {
      await this.downloadArchive(preset.archiveUrl, archivePath)
      this.setState({
        ...this.state,
        progress: 72,
        message: '正在解压模型包...'
      })

      await this.extractArchive(archivePath, extractDir)

      this.setState({
        ...this.state,
        progress: 86,
        message: '正在整理并安装模型文件...'
      })

      this.normalizeInstalledFiles(preset, extractDir, targetDir)

      this.setState({
        isInstalling: false,
        presetId,
        progress: 100,
        message: 'STT 模型安装完成。',
        downloadedBytes: this.state.downloadedBytes,
        totalBytes: this.state.totalBytes
      })
    } catch (error) {
      const userMessage = this.formatInstallerError(error)
      this.setState({
        ...this.state,
        isInstalling: false,
        error: userMessage,
        message: userMessage
      })
      throw new Error('STT model install failed. See installer status in app.')
    } finally {
      rmSync(workDir, { recursive: true, force: true })
    }
  }

  private setState(nextState: SttInstallerState) {
    this.state = nextState
  }

  private async downloadArchive(url: string, outputPath: string) {
    let lastError: Error | null = null

    for (let attempt = 1; attempt <= DOWNLOAD_RETRY_COUNT; attempt += 1) {
      this.setState({
        ...this.state,
        downloadedBytes: 0,
        totalBytes: undefined,
        progress: 0,
        message:
          attempt === 1
            ? '正在连接下载服务器...'
            : `下载中断，正在重试（第 ${attempt} 次，共 ${DOWNLOAD_RETRY_COUNT} 次）...`
      })

      try {
        await this.downloadArchiveOnce(url, outputPath)
        return
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('下载模型压缩包失败。')
        rmSync(outputPath, { force: true })

        if (attempt < DOWNLOAD_RETRY_COUNT) {
          await this.delay(attempt * 1500)
        }
      }
    }

    throw new Error(
      `${lastError?.message || '下载模型压缩包失败。'} 请检查网络是否可以访问 GitHub，或稍后重试；如果仍然失败，可点击“打开下载页”手动下载模型。`
    )
  }

  private async downloadArchiveOnce(url: string, outputPath: string) {
    const controller = new AbortController()
    let timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
    const resetTimeout = () => {
      clearTimeout(timeout)
      timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
    }

    // Electron's networking stack follows the operating system's proxy/PAC
    // configuration. Node's https module does not, which made GitHub downloads
    // fail on otherwise connected machines that require a proxy.
    let response: Response
    try {
      response = await net.fetch(url, {
        headers: {
          'User-Agent': 'new-practice-english/1.0',
          Accept: 'application/octet-stream'
        },
        redirect: 'follow',
        signal: controller.signal
      })
    } catch (error) {
      clearTimeout(timeout)
      if (controller.signal.aborted) {
        throw new Error(`连接下载服务器超时（${DOWNLOAD_TIMEOUT_MS / 1000} 秒）。`)
      }
      throw error
    }

    if (!response.ok) {
      clearTimeout(timeout)
      await response.body?.cancel()
      throw new Error(`下载模型压缩包失败：HTTP ${response.status}`)
    }

    if (!response.body) {
      clearTimeout(timeout)
      throw new Error('下载服务器没有返回模型文件。')
    }

    const totalBytesHeader = response.headers.get('content-length')
    const parsedTotalBytes = totalBytesHeader ? Number(totalBytesHeader) : undefined
    const totalBytes =
      parsedTotalBytes && Number.isFinite(parsedTotalBytes) ? parsedTotalBytes : undefined
    const fileStream = createWriteStream(outputPath)
    const reader = response.body.getReader()
    let downloadedBytes = 0

    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break

        resetTimeout()
        downloadedBytes += value.byteLength
        if (!fileStream.write(Buffer.from(value))) {
          await new Promise<void>((resolvePromise, rejectPromise) => {
            const cleanup = () => {
              fileStream.off('drain', onDrain)
              fileStream.off('error', onError)
            }
            const onDrain = () => {
              cleanup()
              resolvePromise()
            }
            const onError = (error: Error) => {
              cleanup()
              rejectPromise(error)
            }
            fileStream.once('drain', onDrain)
            fileStream.once('error', onError)
          })
        }

        const progress = totalBytes
          ? Math.min(68, Math.round((downloadedBytes / totalBytes) * 68))
          : Math.min(68, Math.round(downloadedBytes / 1024 / 1024))

        this.setState({
          ...this.state,
          downloadedBytes,
          totalBytes,
          progress,
          message: totalBytes
            ? `正在下载模型包... ${Math.round((downloadedBytes / totalBytes) * 100)}%`
            : `正在下载模型包... ${Math.round(downloadedBytes / 1024 / 1024)} MB`
        })
      }

      fileStream.end()
      await finished(fileStream)
      if (downloadedBytes === 0) {
        throw new Error('下载服务器返回了空文件。')
      }
    } catch (error) {
      fileStream.destroy()
      await reader.cancel().catch(() => undefined)
      if (controller.signal.aborted) {
        throw new Error(`模型下载停滞超过 ${DOWNLOAD_TIMEOUT_MS / 1000} 秒，已自动重试。`)
      }
      throw error
    } finally {
      clearTimeout(timeout)
    }
  }

  private delay(ms: number) {
    return new Promise<void>((resolvePromise) => {
      setTimeout(resolvePromise, ms)
    })
  }

  private formatInstallerError(error: unknown) {
    if (!(error instanceof Error)) {
      return '安装语音识别模型失败。'
    }

    return error.message || '安装语音识别模型失败。'
  }

  private async extractArchive(archivePath: string, extractDir: string) {
    await new Promise<void>((resolvePromise, rejectPromise) => {
      execFile(
        'tar',
        ['-xf', archivePath, '-C', extractDir],
        (error) => {
          if (error) {
            rejectPromise(error)
            return
          }

          resolvePromise()
        }
      )
    })
  }

  private normalizeInstalledFiles(preset: SttModelPreset, extractDir: string, targetDir: string) {
    const files = this.walkFiles(extractDir)

    const tokens = this.pickBestMatch(files, [/tokens\.txt$/i])
    if (preset.modelType === 'offline-sense-voice') {
      const model = this.pickBestMatch(files, [/model\.int8\.onnx$/i])
      if (!tokens || !model) {
        throw new Error('SenseVoice 模型包缺少 model.int8.onnx 或 tokens.txt。')
      }
      copyFileSync(model, join(targetDir, 'sense-voice.int8.onnx'))
      copyFileSync(tokens, join(targetDir, 'tokens.txt'))
      return
    }
    if (preset.modelType === 'offline-fire-red') {
      const encoder = this.pickBestMatch(files, [/encoder\.int8\.onnx$/i])
      const decoder = this.pickBestMatch(files, [/decoder\.int8\.onnx$/i])
      if (!tokens || !encoder || !decoder) {
        throw new Error('下载的 FireRedASR2 模型包缺少 encoder、decoder 或 tokens 文件。')
      }
      copyFileSync(encoder, join(targetDir, 'encoder.int8.onnx'))
      copyFileSync(decoder, join(targetDir, 'decoder.int8.onnx'))
      copyFileSync(tokens, join(targetDir, 'tokens.txt'))
      return
    }

    // Prefer full-precision files when a package includes both fp32 and int8.
    // The larger files are slower, but give the best recognition quality.
    const encoder = this.pickBestMatch(files, [/encoder\.onnx$/i, /encoder.*(?<!int8)\.onnx$/i, /encoder.*\.onnx$/i])
    const decoder = this.pickBestMatch(files, [/decoder\.onnx$/i, /decoder.*(?<!int8)\.onnx$/i, /decoder.*\.onnx$/i])
    const joiner = this.pickBestMatch(files, [/joiner\.onnx$/i, /joiner.*(?<!int8)\.onnx$/i, /joiner.*\.onnx$/i])

    if (!tokens || !encoder || !decoder || !joiner) {
      throw new Error('下载的模型包中缺少兼容的 encoder/decoder/joiner/tokens 文件。')
    }

    copyFileSync(encoder, join(targetDir, 'encoder.onnx'))
    copyFileSync(decoder, join(targetDir, 'decoder.onnx'))
    copyFileSync(joiner, join(targetDir, 'joiner.onnx'))
    copyFileSync(tokens, join(targetDir, 'tokens.txt'))
  }

  private walkFiles(rootDir: string) {
    const result: string[] = []
    const stack = [resolve(rootDir)]

    while (stack.length > 0) {
      const current = stack.pop()!
      for (const entry of readdirSync(current, { withFileTypes: true })) {
        const fullPath = join(current, entry.name)
        if (entry.isDirectory()) {
          stack.push(fullPath)
          continue
        }

        if (entry.isFile()) {
          result.push(fullPath)
        }
      }
    }

    return result
  }

  private pickBestMatch(files: string[], matchers: RegExp[]) {
    for (const matcher of matchers) {
      const matched = files.find((file) => matcher.test(file.replace(/\\/g, '/')))
      if (matched) {
        return matched
      }
    }

    return undefined
  }

  private hasRequiredFiles(preset: SttModelPreset, modelDir: string) {
    const required =
      preset.modelType === 'offline-sense-voice'
        ? ['sense-voice.int8.onnx', 'tokens.txt']
        : preset.modelType === 'offline-fire-red'
        ? ['encoder.int8.onnx', 'decoder.int8.onnx', 'tokens.txt']
        : ['encoder.onnx', 'decoder.onnx', 'joiner.onnx', 'tokens.txt']
    return required.every((file) => existsSync(join(modelDir, file)))
  }
}
