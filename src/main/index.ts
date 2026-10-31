import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { mkdirSync } from 'fs'
import { join } from 'path'
import { LLMClient } from './services/llm-client'
import { LLMDiagnosticLogger } from './services/llm-diagnostic-logger'
import { TtsService } from './services/tts-service'
import { SttService } from './services/stt-service'
import { AppConfigService } from './services/app-config'
import { SttModelInstallerService } from './services/stt-model-installer'
import { DatabaseService } from './database/database-service'
import { ReviewPracticeRepository, ReviewRepository } from './database/repositories'
import { ConversationService } from './services/conversation-service'
import { ReviewService } from './services/review-service'
import type {
  ChatSendRequest,
  ConversationUpdateEvent,
  LLMConfig,
  LLMModelSwitchEvent,
  PracticeMode,
  SubtitleFeatureConfig,
  SubtitleWorkflowRequest
} from '../shared/types'
import { SubtitleStorage } from './subtitles/storage'
import { SubtitleService } from './subtitles/subtitle-service'
import { subtitleSourceProvider } from '@subtitle-source-provider'
import { SubtitleLibraryService } from './subtitles/subtitle-library-service'
import { MediaMentionService } from './subtitles/media-mention-service'
import { MediaKnowledgeDecisionService } from './subtitles/media-knowledge-decision-service'

// Keep the same data directory in development, installed builds, and future
// product-name changes. Existing downloaded models and config.json remain
// available after installing or upgrading the Windows application.
app.setPath('userData', join(app.getPath('appData'), 'new-practice-english'))

let mainWindow: BrowserWindow | null = null
const appConfigService = new AppConfigService()
const llmDiagnosticLogDirectory = join(
  app.getPath('userData'),
  'logs',
  'llm'
)
const llmDiagnosticLogger = new LLMDiagnosticLogger(
  llmDiagnosticLogDirectory,
  () => appConfigService.getLLMDiagnosticLoggingEnabled()
)
const llmClient = new LLMClient((event: LLMModelSwitchEvent) => {
  mainWindow?.webContents.send('llm:model-switched', event)
}, llmDiagnosticLogger)
const ttsService = new TtsService()
const sttService = new SttService()
const sttModelInstallerService = new SttModelInstallerService()
const databaseService = new DatabaseService(app.getPath('userData'))
let conversationService: ConversationService | null = null
let reviewService: ReviewService | null = null
let subtitleService: SubtitleService | null = null
let subtitleLibraryService: SubtitleLibraryService | null = null
let mediaMentionService: MediaMentionService | null = null
const subtitleTerminalProgress = new Map<
  string,
  { phase: string; percentBucket?: number }
>()
const subtitlePhaseLogLabels: Record<string, string> = {
  searching: 'searching subtitle sources',
  'awaiting-candidate-selection': 'waiting for candidate selection',
  verifying: 'verifying subtitle source',
  downloading: 'downloading subtitle',
  extracting: 'extracting archive locally',
  processing: 'building dialogue knowledge',
  ready: 'subtitle knowledge ready',
  failed: 'subtitle job failed',
  cancelled: 'subtitle job cancelled'
}

function logSubtitleProgress(progress: import('../shared/types').SubtitleJobProgress) {
  const percentBucket =
    typeof progress.percent === 'number'
      ? Math.floor(progress.percent / 5) * 5
      : undefined
  const previous = subtitleTerminalProgress.get(progress.jobId)
  const shouldLog =
    previous?.phase !== progress.phase ||
    (progress.phase === 'downloading' &&
      percentBucket !== undefined &&
      previous?.percentBucket !== percentBucket)
  if (!shouldLog) return
  subtitleTerminalProgress.set(progress.jobId, {
    phase: progress.phase,
    percentBucket
  })
  const fields = [
    `[subtitle ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}]`,
    `job=${progress.jobId.slice(0, 8)}`,
    progress.conversationId
      ? `conversation=${progress.conversationId.slice(0, 8)}`
      : 'conversation=none',
    `phase=${progress.phase}`,
    progress.source ? `source=${progress.source}` : '',
    percentBucket !== undefined ? `progress=${percentBucket}%` : '',
    subtitlePhaseLogLabels[progress.phase] || 'subtitle progress'
  ].filter(Boolean)
  const line = fields.join(' ')
  if (progress.phase === 'failed') {
    console.error(
      line,
      progress.errorCode ? `error=${progress.errorCode}` : '',
      progress.diagnostic ? `diagnostic=${asciiTerminalText(progress.diagnostic)}` : ''
    )
  } else {
    console.info(line)
  }
  if (['ready', 'failed', 'cancelled'].includes(progress.phase)) {
    subtitleTerminalProgress.delete(progress.jobId)
  }
}

function asciiTerminalText(value: string): string {
  return value.replace(/[^\x20-\x7e]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  )
}

// Voice replies happen after an asynchronous model request, outside the
// original click event. Allow that expected conversational playback.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    title: '英语练习助手',
    backgroundColor: '#0f172a'
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// Initialize STT on app ready
app.whenReady().then(() => {
  app.setAppUserModelId('com.leofzzf.english-practice-assistant')
  try {
    databaseService.initialize()
    const notify = (
      conversationId: string,
      reason: ConversationUpdateEvent['reason']
    ) => {
      mainWindow?.webContents.send('conversation:updated', {
        conversationId,
        reason
      } satisfies ConversationUpdateEvent)
    }
    const subtitleStorage = new SubtitleStorage()
    subtitleService = new SubtitleService(
      databaseService.connection,
      llmClient,
      subtitleStorage,
      () => appConfigService.getSubtitleConfig(),
      (progress) => {
        logSubtitleProgress(progress)
        mainWindow?.webContents.send('subtitle:job-progress', progress)
        // Keep the old event during migration for renderer compatibility.
        mainWindow?.webContents.send('subtitle:progress', progress)
        if (progress.conversationId) {
          mainWindow?.webContents.send('conversation:updated', {
            conversationId: progress.conversationId,
            reason: 'metadata'
          } satisfies ConversationUpdateEvent)
        }
      },
      subtitleSourceProvider
    )
    subtitleLibraryService = new SubtitleLibraryService(
      databaseService.connection,
      subtitleService,
      (summary) => mainWindow?.webContents.send('subtitle:library-updated', summary),
      (conversationId) => notify(conversationId, 'metadata')
    )
    mediaMentionService = new MediaMentionService(
      databaseService.connection,
      llmClient,
      (suggestion) => {
        mainWindow?.webContents.send('subtitle:mention-detected', suggestion)
        notify(suggestion.conversationId, 'metadata')
      }
    )
    const mediaKnowledge = new MediaKnowledgeDecisionService(
      llmClient,
      subtitleLibraryService
    )
    conversationService = new ConversationService(
      databaseService.connection,
      llmClient,
      notify,
      mediaMentionService,
      mediaKnowledge
    )
      reviewService = new ReviewService(
        conversationService.conversations,
        new ReviewRepository(databaseService.connection, conversationService.conversations),
        new ReviewPracticeRepository(databaseService.connection),
        llmClient,
      (conversationId) => {
        mainWindow?.webContents.send('review:updated', {
          conversationId,
          reason: 'analysis'
        } satisfies ConversationUpdateEvent)
      }
    )
  } catch (error) {
    console.error('Failed to initialize learning database:', error)
  }
  sttService.init(appConfigService.getSttModelDir())
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
    }
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  conversationService?.stopAcceptingWrites()
  databaseService.close()
})

// IPC handlers

const requireConversations = (): ConversationService => {
  if (!conversationService) {
    throw new Error('学习数据库尚未就绪，请打开数据目录检查或重启应用。')
  }
  return conversationService
}

const requireReviews = (): ReviewService => {
  if (!reviewService) {
    throw new Error('学习复习服务尚未就绪。')
  }
  return reviewService
}

const requireSubtitleLibrary = (): SubtitleLibraryService => {
  if (!subtitleLibraryService) {
    throw new Error('字幕知识库尚未就绪。')
  }
  return subtitleLibraryService
}

ipcMain.handle('chat:send', (_event, request: ChatSendRequest) => {
  return requireConversations().send(request)
})

ipcMain.handle(
  'chat:retry',
  (_event, conversationId: string, userMessageId: string) => {
    return requireConversations().retry(conversationId, userMessageId)
  }
)

ipcMain.handle(
  'llm:correct',
  (
    _event,
    conversationId: string,
    content: string,
    userMessageId: string
  ) => {
    return requireConversations().analyzeCorrections(
      conversationId,
      userMessageId,
      content
    )
  }
)

ipcMain.handle(
  'llm:vocabulary',
  (
    _event,
    conversationId: string,
    content: string,
    assistantMessageId: string
  ) => {
    return requireConversations().analyzeVocabulary(
      conversationId,
      assistantMessageId,
      content
    )
  }
)

ipcMain.handle('llm:configure', (_event, config: LLMConfig) => {
  llmClient.configure(config)
})

ipcMain.handle('llm:getProfiles', () => appConfigService.getLLMProfiles())

ipcMain.handle('llm:saveProfiles', (_event, store) => {
  return appConfigService.setLLMProfiles(store)
})

ipcMain.handle('llm:getDiagnosticLogStatus', () => ({
  enabled: appConfigService.getLLMDiagnosticLoggingEnabled(),
  directory: llmDiagnosticLogDirectory,
  containsFullContent: true as const
}))

ipcMain.handle('llm:setDiagnosticLogging', (_event, enabled: boolean) => {
  appConfigService.setLLMDiagnosticLoggingEnabled(Boolean(enabled))
  return {
    enabled: appConfigService.getLLMDiagnosticLoggingEnabled(),
    directory: llmDiagnosticLogDirectory,
    containsFullContent: true as const
  }
})

ipcMain.handle('llm:openDiagnosticLogDirectory', async () => {
  mkdirSync(llmDiagnosticLogDirectory, { recursive: true })
  const error = await shell.openPath(llmDiagnosticLogDirectory)
  return {
    success: !error,
    path: llmDiagnosticLogDirectory,
    error: error || undefined
  }
})

ipcMain.handle(
  'conversation:list',
  (_event, cursor?: number, limit?: number, query?: string) => {
    return requireConversations().list(cursor, limit, query)
  }
)

ipcMain.handle('conversation:get', (_event, conversationId: string) => {
  return requireConversations().get(conversationId)
})

ipcMain.handle(
  'conversation:getMessages',
  (_event, conversationId: string, beforeSequence?: number, limit?: number) =>
    requireConversations().getMessagePage(conversationId, beforeSequence, limit)
)

ipcMain.handle('conversation:getActive', () => {
  return requireConversations().getActive()
})

ipcMain.handle('conversation:setActive', (_event, conversationId: string) => {
  return requireConversations().setActive(conversationId)
})

ipcMain.handle(
  'conversation:rename',
  (_event, conversationId: string, title: string) => {
    requireConversations().rename(conversationId, title)
  }
)

ipcMain.handle('conversation:delete', (_event, conversationId: string) => {
  return requireConversations().delete(conversationId)
})

ipcMain.handle('conversation:listDeleted', (_event, limit?: number) => {
  return requireConversations().listDeleted(limit)
})

ipcMain.handle('conversation:restore', (_event, conversationId: string) => {
  requireConversations().restore(conversationId)
})

ipcMain.handle('conversation:purge', (_event, conversationId: string) => {
  requireConversations().purge(conversationId)
})

ipcMain.handle(
  'conversation:setMode',
  (
    _event,
    conversationId: string,
    mode: PracticeMode,
    topic?: string
  ) => {
    requireConversations().setMode(conversationId, mode, topic)
  }
)

ipcMain.handle('review:get', (_event, conversationId: string) => {
  return requireReviews().get(conversationId)
})

ipcMain.handle(
  'review:generate',
  (_event, conversationId: string, force?: boolean) => {
    return requireReviews().generate(conversationId, force)
  }
)

ipcMain.handle('review:dashboard', (_event, limit?: number) => {
  return requireReviews().dashboard(limit)
})

ipcMain.handle('review:evaluateAnswer', (_event, itemId: string, response: string) => {
  return requireReviews().evaluateAnswer(itemId, response)
})

ipcMain.handle('review:grade', (_event, itemId: string, grade, evidence) => {
  return requireReviews().gradeItem(itemId, grade, evidence)
})

ipcMain.handle('review:listLibrary', (_event, filter) => {
  return requireReviews().listLibrary(filter || {})
})

ipcMain.handle('review:setMastered', (_event, itemId: string, mastered: boolean) => {
  return requireReviews().setItemMastered(itemId, mastered)
})

ipcMain.handle('review:deleteItem', (_event, itemId: string) => {
  requireReviews().deleteItem(itemId)
})

ipcMain.handle('database:getStatus', () => databaseService.getStatus())

ipcMain.handle('database:openDirectory', async () => {
  mkdirSync(databaseService.dataDirectory, { recursive: true })
  const error = await shell.openPath(databaseService.dataDirectory)
  return {
    success: !error,
    path: databaseService.dataDirectory,
    error: error || undefined
  }
})

ipcMain.handle('subtitle:getStatus', () => {
  if (!subtitleService) throw new Error('字幕服务尚未就绪。')
  return subtitleService.status()
})

ipcMain.handle('subtitle:getConfig', () => appConfigService.getSubtitleConfig())

ipcMain.handle(
  'subtitle:setConfig',
  (_event, config: Partial<SubtitleFeatureConfig>) =>
    appConfigService.setSubtitleConfig(config)
)

ipcMain.handle('subtitle:getContext', (_event, conversationId: string) => {
  void conversationId
  return undefined
})

ipcMain.handle('subtitle:clearContext', (_event, conversationId: string) => {
  void conversationId
})

ipcMain.handle('subtitle:retry', (_event, conversationId: string) => {
  void conversationId
  throw new Error('请在字幕工作流弹窗中重新搜索。')
})

ipcMain.handle('subtitle:continueWithout', (_event, conversationId: string) => {
  void conversationId
})

ipcMain.handle('subtitle:cancel', (_event, jobId: string) => {
  subtitleService?.cancel(jobId)
})

ipcMain.handle(
  'subtitle:selectCandidate',
  (_event, jobId: string, candidateId: string) => {
    if (!subtitleService) throw new Error('字幕服务尚未就绪。')
    return subtitleService.selectCandidate(jobId, candidateId)
  }
)

ipcMain.handle('subtitle:openDirectory', async () => {
  const storage = new SubtitleStorage()
  storage.assertWritable()
  const error = await shell.openPath(storage.root)
  return {
    success: !error,
    path: storage.root,
    error: error || undefined
  }
})

ipcMain.handle('subtitle:listMentions', (_event, conversationId: string) => {
  return mediaMentionService?.list(conversationId) || []
})

ipcMain.handle('subtitle:dismissMention', (_event, mentionId: string) => {
  mediaMentionService?.dismiss(mentionId)
})

ipcMain.handle('subtitle:listLibrary', () => {
  return requireSubtitleLibrary().list()
})

ipcMain.handle(
  'subtitle:startWorkflow',
  (_event, request: SubtitleWorkflowRequest) => {
    return requireSubtitleLibrary().start(request)
  }
)

ipcMain.handle('subtitle:getJob', (_event, jobId: string) => {
  return requireSubtitleLibrary().getJob(jobId)
})

ipcMain.handle('subtitle:importLocal', async (_event, request: SubtitleWorkflowRequest) => {
  const library = requireSubtitleLibrary()
  const selection = await dialog.showOpenDialog({
    title: '选择字幕文件或字幕压缩包',
    properties: ['openFile'],
    filters: [{ name: '字幕与字幕包', extensions: ['srt', 'ass', 'ssa', 'vtt', 'zip', 'rar', '7z'] }]
  })
  if (selection.canceled || !selection.filePaths[0]) return null
  return library.start(request, selection.filePaths[0])
})

ipcMain.handle(
  'subtitle:processEpisode',
  (
    _event,
    packageId: string,
    season: number | undefined,
    episode: number | undefined,
    request: Pick<
      SubtitleWorkflowRequest,
      'requestId' | 'origin' | 'conversationId' | 'mentionId'
    >
  ) => requireSubtitleLibrary().processEpisode(
    packageId,
    season,
    episode,
    request
  )
)

ipcMain.handle(
  'subtitle:attachKnowledge',
  (
    _event,
    conversationId: string,
    scopeId: string,
    mentionId?: string
  ) => requireSubtitleLibrary().attach(conversationId, scopeId, mentionId)
)

ipcMain.handle(
  'subtitle:detachKnowledge',
  (_event, conversationId: string, scopeId: string) =>
    requireSubtitleLibrary().detach(conversationId, scopeId)
)

ipcMain.handle('subtitle:deleteLibraryEntry', (_event, scopeId: string) => {
  requireSubtitleLibrary().delete(scopeId)
})

// TTS handlers

ipcMain.handle('tts:synthesize', async (_event, text: string, voice?: string) => {
  if (voice) ttsService.setVoice(voice)
  if (!ttsService.isInitialized()) {
    await ttsService.init(sttModelInstallerService.getTtsModelDir())
  }
  const buffer = await ttsService.synthesize(text)
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
})

ipcMain.handle('tts:setVoice', (_event, voice: string) => {
  ttsService.setVoice(voice)
})

ipcMain.handle('tts:getVoice', () => {
  return ttsService.getVoice()
})

ipcMain.handle('tts:setSpeed', (_event, speed: number) => {
  ttsService.setSpeed(speed)
})

ipcMain.handle('tts:getSpeed', () => {
  return ttsService.getSpeed()
})

ipcMain.handle('tts:getVoices', () => {
  return ttsService.getVoices()
})

ipcMain.handle('tts:getLocalModelStatus', async () => {
  const modelStatus = sttModelInstallerService.getTtsModelStatus()
  if (modelStatus.installed && !ttsService.isInitialized()) {
    await ttsService.init(modelStatus.modelDir)
  }
  return {
    ...modelStatus,
    initialized: ttsService.isInitialized(),
    error: ttsService.getLastError()
  }
})

ipcMain.handle('tts:installLocalModel', async () => {
  await sttModelInstallerService.installTtsModel()
  await ttsService.reload(sttModelInstallerService.getTtsModelDir())
  return {
    ...sttModelInstallerService.getTtsModelStatus(),
    initialized: ttsService.isInitialized(),
    error: ttsService.getLastError()
  }
})

// STT handlers

ipcMain.handle('stt:init', () => {
  sttService.init(appConfigService.getSttModelDir())
  return sttService.isInitialized()
})

ipcMain.handle('stt:isInitialized', () => {
  return sttService.isInitialized()
})

ipcMain.handle('stt:getStatus', () => {
  return sttService.getStatus(appConfigService.getSttModelDir())
})

ipcMain.handle('voiceCapture:getSettings', () => {
  return appConfigService.getVoiceCaptureSettings()
})

ipcMain.handle('voiceCapture:setSettings', (_event, settings) => {
  return appConfigService.setVoiceCaptureSettings(settings || {})
})

ipcMain.handle('stt:getModelPresets', () => {
  return sttModelInstallerService.getPresets()
})

ipcMain.handle('stt:getInstallerState', () => {
  return sttModelInstallerService.getState()
})

ipcMain.handle('stt:installPreset', async (_event, presetId: string) => {
  const targetDir = sttModelInstallerService.getPresetInstallDir(presetId)

  appConfigService.setSttModelDir(targetDir)
  await sttModelInstallerService.installPreset(presetId, targetDir)
  sttService.init(appConfigService.getSttModelDir())

  return {
    installer: sttModelInstallerService.getState(),
    status: sttService.getStatus(appConfigService.getSttModelDir())
  }
})

ipcMain.handle('stt:activatePreset', (_event, presetId: string) => {
  const preset = sttModelInstallerService.getPresets().find((item) => item.id === presetId)
  if (!preset?.installed || !preset.modelDir) {
    throw new Error('该语音识别模型尚未完整安装。')
  }
  appConfigService.setSttModelDir(preset.modelDir)
  sttService.init(preset.modelDir)
  return sttService.getStatus(appConfigService.getSttModelDir())
})

ipcMain.handle('stt:selectModelDir', async () => {
  const options: Electron.OpenDialogOptions = {
    title: '选择语音识别模型目录',
    properties: ['openDirectory']
  }
  const result = mainWindow
    ? await dialog.showOpenDialog(mainWindow, options)
    : await dialog.showOpenDialog(options)

  if (!result.canceled && result.filePaths[0]) {
    appConfigService.setSttModelDir(result.filePaths[0])
    sttService.init(appConfigService.getSttModelDir())
  }

  return sttService.getStatus(appConfigService.getSttModelDir())
})

ipcMain.handle('stt:clearModelDir', () => {
  appConfigService.setSttModelDir()
  sttService.init(appConfigService.getSttModelDir())
  return sttService.getStatus(appConfigService.getSttModelDir())
})

ipcMain.handle('stt:openModelDir', async (_event, targetDir?: string) => {
  const dir =
    targetDir ||
    appConfigService.getSttModelDir() ||
    sttService.getDefaultInstallDir()

  mkdirSync(dir, { recursive: true })
  const error = await shell.openPath(dir)

  return {
    success: !error,
    path: dir,
    error: error || undefined
  }
})

ipcMain.handle('stt:openDownloadPage', async () => {
  await shell.openExternal('https://k2-fsa.github.io/sherpa/onnx/pretrained_models/')
})

ipcMain.handle('stt:start', () => {
  sttService.start()
})

ipcMain.handle('stt:feedChunk', (_event, samples: Float32Array) => {
  return sttService.feedChunk(samples)
})

ipcMain.handle('stt:stop', () => {
  return sttService.stop()
})
