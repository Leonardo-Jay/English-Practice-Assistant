import { useCallback, useEffect, useState } from 'react'
import {
  getLLMProviderDefinition,
  LLM_PROVIDER_DEFINITIONS,
  MODELSCOPE_MODEL_FALLBACKS,
  normalizeLLMConfig,
  validateLLMConfig
} from '../../../shared/llm-providers'
import type {
  DatabaseStatus,
  LLMDiagnosticLogStatus,
  LLMProfile,
  LLMProvider,
  SttInstallerState,
  SttModelPreset,
  SttStatus,
  TTSVoice,
  SubtitleFeatureConfig,
  SubtitleFeatureStatus,
  SubtitleLibraryEntry,
  SubtitleLibrarySummary,
  SubtitleWorkflowRequest,
  MediaType,
  ConversationSummary,
  VoiceCaptureSettings
} from '../../types'
import {
  getActiveLLMProfile,
  loadLLMProfileStore,
  newLLMProfile,
  saveLLMProfileStore
} from '../utils/llm-config-storage'

const VOICE_STORAGE_KEY = 'english-practice-tts-voice'
const TTS_SPEED_STORAGE_KEY = 'english-practice-tts-speed'

const DEFAULT_TTS_VOICES: TTSVoice[] = [
  { id: 'kokoro:2', label: 'Nicole（女声，美国，自然）' }
]

const DEFAULT_INSTALLER_STATE: SttInstallerState = {
  isInstalling: false,
  progress: 0,
  message: '尚未开始安装。',
  downloadedBytes: 0
}

interface Props {
  onConfigSaved?: (model: string) => void
  onOpenSubtitleWorkflow?: (
    title: string,
    mediaType: MediaType | 'auto',
    details?: Partial<SubtitleWorkflowRequest>
  ) => void
}

function profileDisplayName(profile: LLMProfile): string {
  return profile.model
    ? `${profile.name} · ${profile.model}`
    : profile.name
}

function StatusBadge({ ready, readyText, pendingText }: {
  ready: boolean
  readyText: string
  pendingText: string
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${
      ready ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'
    }`}>
      <span className={`h-1.5 w-1.5 rounded-full ${ready ? 'bg-emerald-500' : 'bg-amber-500'}`} />
      {ready ? readyText : pendingText}
    </span>
  )
}

function Section({ title, description, children }: {
  title: string
  description: string
  children: React.ReactNode
}) {
  return (
    <section className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <div className="mb-5">
        <h2 className="text-lg font-semibold text-slate-900">{title}</h2>
        <p className="mt-1 text-sm leading-6 text-slate-500">{description}</p>
      </div>
      {children}
    </section>
  )
}

export default function SettingsPage({
  onConfigSaved,
  onOpenSubtitleWorkflow
}: Props) {
  const [llmStore, setLlmStore] = useState(loadLLMProfileStore)
  const [voice, setVoice] = useState(() => localStorage.getItem(VOICE_STORAGE_KEY) || 'kokoro:2')
  const [ttsSpeed, setTtsSpeed] = useState(() => {
    const saved = Number(localStorage.getItem(TTS_SPEED_STORAGE_KEY))
    return Number.isFinite(saved) && saved >= 0.6 && saved <= 1.2 ? saved : 0.75
  })
  const [voices, setVoices] = useState<TTSVoice[]>(DEFAULT_TTS_VOICES)
  const [localTtsStatus, setLocalTtsStatus] = useState<{
    installed: boolean
    initialized: boolean
    modelDir: string
    error?: string | null
  } | null>(null)
  const [sttStatus, setSttStatus] = useState<SttStatus | null>(null)
  const [sttPresets, setSttPresets] = useState<SttModelPreset[]>([])
  const [selectedPresetId, setSelectedPresetId] = useState('')
  const [installerState, setInstallerState] = useState<SttInstallerState>(DEFAULT_INSTALLER_STATE)
  const [sttBusy, setSttBusy] = useState(false)
  const [sttMessage, setSttMessage] = useState('')
  const [voiceCaptureSettings, setVoiceCaptureSettings] =
    useState<VoiceCaptureSettings>({
      initialSilenceMs: 20_000,
      silenceAfterSpeechMs: 5_000,
      speechRmsThreshold: 0.012
    })
  const [voiceCaptureMessage, setVoiceCaptureMessage] = useState('')
  const [ttsBusy, setTtsBusy] = useState(false)
  const [ttsMessage, setTtsMessage] = useState('')
  const [saved, setSaved] = useState(false)
  const [loadError, setLoadError] = useState('')
  const [databaseStatus, setDatabaseStatus] = useState<DatabaseStatus | null>(null)
  const [llmDiagnosticStatus, setLlmDiagnosticStatus] =
    useState<LLMDiagnosticLogStatus | null>(null)
  const [subtitleConfig, setSubtitleConfig] =
    useState<SubtitleFeatureConfig | null>(null)
  const [subtitleStatus, setSubtitleStatus] =
    useState<SubtitleFeatureStatus | null>(null)
  const [subtitleMessage, setSubtitleMessage] = useState('')
  const [subtitleSearchTitle, setSubtitleSearchTitle] = useState('')
  const [subtitleSearchType, setSubtitleSearchType] =
    useState<MediaType | 'auto'>('auto')
  const [subtitleLibrary, setSubtitleLibrary] =
    useState<SubtitleLibrarySummary | null>(null)
  const [continuingSubtitle, setContinuingSubtitle] = useState<{
    requestId: string
    scopeId: string
  } | null>(null)
  const [deletedConversations, setDeletedConversations] = useState<ConversationSummary[]>([])
  const [recycleBusyId, setRecycleBusyId] = useState<string>()
  const config = getActiveLLMProfile(llmStore)!
  const providerDefinition = getLLMProviderDefinition(config.provider)

  const updateConfig = (patch: Partial<LLMProfile>) => {
    setLlmStore((current) => ({
      ...current,
      profiles: current.profiles.map((item) =>
        item.id === current.activeId ? { ...item, ...patch } : item
      )
    }))
    setSaved(false)
  }

  const persistLLMProfiles = (store: typeof llmStore) => {
    saveLLMProfileStore(store)
    void window.api.saveLLMProfiles(store).catch(() => {
      setLoadError('大模型配置已暂存于当前窗口，但写入本地配置文件失败。请稍后再次保存。')
    })
  }

  const refreshSttStatus = useCallback(async () => {
    const status = await window.api.getSTTStatus()
    setSttStatus(status)
    return status
  }, [])

  const refreshInstallerState = useCallback(async () => {
    const state = await window.api.getSTTInstallerState()
    setInstallerState(state)
    return state
  }, [])

  const refreshPresets = useCallback(async () => {
    const presets = await window.api.getSTTModelPresets()
    setSttPresets(presets)
    return presets
  }, [])

  const refreshDeletedConversations = useCallback(async () => {
    const deleted = await window.api.listDeletedConversations()
    setDeletedConversations(deleted)
    return deleted
  }, [])

  useEffect(() => {
    if (!saved) return
    const timer = window.setTimeout(() => setSaved(false), 2000)
    return () => window.clearTimeout(timer)
  }, [saved])

  useEffect(() => {
    return window.api.onLLMModelSwitched((event) => {
      setLlmStore((current) => {
        const targetId = event.profileId || current.activeId
        const next = {
          ...current,
          profiles: current.profiles.map((profile) =>
            profile.id === targetId
              ? { ...profile, model: event.model }
              : profile
          )
        }
        const active = getActiveLLMProfile(next)
        if (active) onConfigSaved?.(profileDisplayName(active))
        return next
      })
      setSaved(true)
      setLoadError(
        event.reason === 'daily-quota-exhausted'
          ? `当前模型今日额度已用尽，已自动切换为 ${event.model} 并继续请求。`
          : event.reason === 'model-rate-limited'
            ? `当前模型受到接口限流，已自动切换为 ${event.model} 并继续请求。`
            : event.reason === 'model-unavailable'
              ? `候选模型当前没有可用推理服务，已跳过并切换为 ${event.model}。`
              : `当前模型连续返回空响应，已自动切换为 ${event.model} 并继续请求。`
      )
    })
  }, [onConfigSaved])

  useEffect(() => {
    let cancelled = false
    void window.api.getLLMProfiles().then((store) => {
      if (cancelled) return
      if (store) {
        setLlmStore(store)
        saveLLMProfileStore(store)
      } else {
        persistLLMProfiles(llmStore)
      }
    }).catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const results = await Promise.allSettled([
            window.api.getTTSVoices(),
            window.api.getTTSVoice(),
            window.api.getTTSSpeed(),
            window.api.getSTTStatus(),
            window.api.getSTTModelPresets(),
            window.api.getSTTInstallerState(),
            window.api.getLocalTTSModelStatus(),
            window.api.getDatabaseStatus(),
            window.api.getSubtitleStatus(),
            window.api.listSubtitleLibrary(),
            window.api.getLLMDiagnosticLogStatus(),
            window.api.getVoiceCaptureSettings(),
            window.api.listDeletedConversations()
          ])
        if (cancelled) return
        const valueAt = <T,>(index: number): T | undefined => {
          const result = results[index]
          return result.status === 'fulfilled' ? result.value as T : undefined
        }
        const failed = results.filter((result) => result.status === 'rejected').length
        const availableVoices = valueAt<TTSVoice[]>(0)
        const currentVoice = valueAt<string>(1)
        const currentSpeed = valueAt<number>(2)
        const status = valueAt<SttStatus>(3)
        const presets = valueAt<SttModelPreset[]>(4)
        const installer = valueAt<SttInstallerState>(5)
        const ttsStatus = valueAt<typeof localTtsStatus>(6)
        const learningDatabase = valueAt<DatabaseStatus>(7)
        const subtitleFeature = valueAt<SubtitleFeatureStatus>(8)
        const subtitleLibraryData = valueAt<SubtitleLibrarySummary>(9)
        const llmDiagnostics = valueAt<LLMDiagnosticLogStatus>(10)
        const captureSettings = valueAt<VoiceCaptureSettings>(11)
        const deleted = valueAt<ConversationSummary[]>(12)
        const nextVoices = availableVoices && availableVoices.length > 0
          ? availableVoices
          : DEFAULT_TTS_VOICES
        const savedVoice = localStorage.getItem(VOICE_STORAGE_KEY)
        setVoices(nextVoices)
        setVoice(nextVoices.some((item) => item.id === savedVoice) ? savedVoice! : currentVoice || nextVoices[0].id)
        const savedSpeed = Number(localStorage.getItem(TTS_SPEED_STORAGE_KEY))
        setTtsSpeed(
          Number.isFinite(savedSpeed) && savedSpeed >= 0.6 && savedSpeed <= 1.2
            ? savedSpeed
            : currentSpeed || 0.75
        )
        if (status) setSttStatus(status)
        if (presets) setSttPresets(presets)
        const activePreset = presets?.find(
          (preset) =>
            preset.modelDir &&
            status?.modelDir &&
            preset.modelDir.toLowerCase() === status.modelDir.toLowerCase()
        )
        if (presets) setSelectedPresetId(activePreset?.id || presets[0]?.id || '')
        if (installer) setInstallerState(installer)
        if (ttsStatus) setLocalTtsStatus(ttsStatus)
        if (learningDatabase) setDatabaseStatus(learningDatabase)
        if (subtitleFeature) {
          setSubtitleStatus(subtitleFeature)
          setSubtitleConfig(subtitleFeature.config)
        }
        if (subtitleLibraryData) setSubtitleLibrary(subtitleLibraryData)
        if (llmDiagnostics) setLlmDiagnosticStatus(llmDiagnostics)
        if (captureSettings) setVoiceCaptureSettings(captureSettings)
        if (deleted) setDeletedConversations(deleted)
        if (failed > 0) {
          setLoadError(`有 ${failed} 项状态暂时无法读取；其余设置仍可正常使用。`)
        }
      } catch {
        if (!cancelled) {
          setLoadError('部分模型状态暂时无法读取，你仍然可以修改并保存大模型配置。')
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => window.api.onSubtitleLibraryUpdated((summary) => {
    setSubtitleLibrary(summary)
  }), [])

  useEffect(
    () => window.api.onConversationUpdated(() => {
      void refreshDeletedConversations().catch(() => undefined)
    }),
    [refreshDeletedConversations]
  )

  useEffect(() => window.api.onSubtitleProgress((progress) => {
    if (!continuingSubtitle || progress.requestId !== continuingSubtitle.requestId) {
      return
    }
    setSubtitleMessage(progress.message)
    if (['ready', 'failed', 'cancelled'].includes(progress.phase)) {
      setContinuingSubtitle(null)
      if (progress.phase === 'ready') {
        void window.api.listSubtitleLibrary().then(setSubtitleLibrary)
      }
    }
  }), [continuingSubtitle])

  const continueSubtitleSummary = async (entry: SubtitleLibraryEntry) => {
    if (!entry.packageId || continuingSubtitle) return
    if (entry.media.type === 'tv' && !entry.episode) {
      onOpenSubtitleWorkflow?.(entry.media.title, 'tv', {
        aliases: entry.media.aliases,
        year: entry.media.year,
        season: entry.season
      })
      return
    }
    const requestId = crypto.randomUUID()
    setContinuingSubtitle({ requestId, scopeId: entry.scopeId })
    setSubtitleMessage('正在从本地字幕继续生成剧情知识…')
    try {
      const result = await window.api.processSubtitleEpisode(
        entry.packageId,
        entry.season,
        entry.episode,
        { requestId, origin: 'settings' }
      )
      if (result.status === 'ready') {
        setContinuingSubtitle(null)
        setSubtitleMessage('剧情知识已经生成完成。')
        setSubtitleLibrary(await window.api.listSubtitleLibrary())
      }
    } catch (error) {
      setContinuingSubtitle(null)
      setSubtitleMessage(
        error instanceof Error ? error.message : '继续生成剧情知识失败。'
      )
    }
  }

  useEffect(() => {
    if (!installerState.isInstalling) return
    const timer = window.setInterval(() => void refreshInstallerState(), 800)
    return () => window.clearInterval(timer)
  }, [installerState.isInstalling, refreshInstallerState])

  const handleSave = async () => {
    try {
      const normalized = {
        ...config,
        ...normalizeLLMConfig(config),
        name: config.name.trim() || providerDefinition.label
      } satisfies LLMProfile
      const validationError = validateLLMConfig(normalized)
      if (validationError) throw new Error(validationError)
      const nextStore = {
        ...llmStore,
        profiles: llmStore.profiles.map((item) =>
          item.id === normalized.id ? normalized : item
        )
      }
      setLlmStore(nextStore)
      await window.api.saveLLMProfiles(nextStore)
      saveLLMProfileStore(nextStore)
      await window.api.configureLLM(normalized)
      setSaved(true)
      setLoadError('')
      onConfigSaved?.(profileDisplayName(normalized))
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '大模型配置保存失败。')
    }
  }

  const handleSaveSubtitleConfig = async () => {
    if (!subtitleConfig) return
    try {
      const selectedProfile = llmStore.profiles.find(
        (profile) => profile.id === subtitleConfig.captchaProfileId
      )
      const savedConfig = await window.api.setSubtitleConfig({
        ...subtitleConfig,
        captchaProfile:
          selectedProfile?.provider === 'qianfan' ? selectedProfile : undefined
      })
      setSubtitleConfig(savedConfig)
      const nextStatus = await window.api.getSubtitleStatus()
      setSubtitleStatus(nextStatus)
      setSubtitleMessage('字幕功能设置已保存。')
    } catch (error) {
      setSubtitleMessage(
        error instanceof Error ? error.message : '字幕功能设置保存失败。'
      )
    }
  }

  const handleProfileChange = async (profileId: string) => {
    const nextStore = { ...llmStore, activeId: profileId }
    setLlmStore(nextStore)
    await window.api.saveLLMProfiles(nextStore)
    saveLLMProfileStore(nextStore)
    setSaved(false)
    const profile = getActiveLLMProfile(nextStore)
    if (!profile) return
    const validationError = validateLLMConfig(profile)
    if (validationError) {
      setLoadError(`已切换到“${profile.name}”，但配置尚未完整：${validationError}`)
      onConfigSaved?.('')
      return
    }
    try {
      await window.api.configureLLM(profile)
      setLoadError('')
      onConfigSaved?.(profileDisplayName(profile))
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : '大模型配置切换失败。')
    }
  }

  const handleAddProfile = () => {
    const profile = newLLMProfile(
      'openai',
      `模型配置 ${llmStore.profiles.length + 1}`
    )
    const nextStore = {
      ...llmStore,
      activeId: profile.id,
      profiles: [...llmStore.profiles, profile]
    }
    setLlmStore(nextStore)
    persistLLMProfiles(nextStore)
    setSaved(false)
    setLoadError('新配置已创建，请填写并保存后使用。')
  }

  const handleDeleteProfile = async () => {
    if (
      !window.confirm(
        `确定删除大模型配置“${config.name}”吗？此操作不会删除历史会话。`
      )
    ) {
      return
    }
    const remaining = llmStore.profiles.filter((item) => item.id !== config.id)
    const profiles =
      remaining.length > 0
        ? remaining
        : [newLLMProfile('openai', '模型配置 1')]
    const nextStore = {
      version: 2 as const,
      activeId: profiles[0].id,
      profiles
    }
    setLlmStore(nextStore)
    await window.api.saveLLMProfiles(nextStore)
    saveLLMProfileStore(nextStore)
    setSaved(false)
    const next = profiles[0]
    if (!validateLLMConfig(next)) {
      await window.api.configureLLM(next)
      onConfigSaved?.(profileDisplayName(next))
      setLoadError('')
    } else {
      onConfigSaved?.('')
      setLoadError('配置已删除，请完善新的大模型配置。')
    }
  }

  const handleProviderChange = (provider: LLMProvider) => {
    const previousDefinition = getLLMProviderDefinition(config.provider)
    const nextDefinition = getLLMProviderDefinition(provider)
    updateConfig({
      provider,
      name:
        config.name === previousDefinition.label
          ? nextDefinition.label
          : config.name,
      baseUrl:
        provider === 'modelscope' ||
        !config.baseUrl ||
        config.baseUrl === previousDefinition.defaultBaseUrl
          ? nextDefinition.defaultBaseUrl
          : config.baseUrl,
      model:
        provider === 'modelscope' ||
        !config.model ||
        config.model === previousDefinition.defaultModel
          ? nextDefinition.defaultModel
          : config.model
    })
  }

  const handleVoiceChange = async (nextVoice: string) => {
    setVoice(nextVoice)
    localStorage.setItem(VOICE_STORAGE_KEY, nextVoice)
    await window.api.setTTSVoice(nextVoice)
  }

  const handleSpeedChange = async (nextSpeed: number) => {
    const speed = Math.max(0.6, Math.min(1.2, Math.round(nextSpeed * 20) / 20))
    setTtsSpeed(speed)
    localStorage.setItem(TTS_SPEED_STORAGE_KEY, String(speed))
    await window.api.setTTSSpeed(speed)
  }

  const handleInstallLocalTts = async () => {
    setTtsBusy(true)
    setTtsMessage('')
    try {
      const status = await window.api.installLocalTTSModel()
      setLocalTtsStatus(status)
      setTtsMessage(status.initialized ? '离线语音回复已准备好。' : '模型已下载，但暂时无法启用。')
    } catch {
      setTtsMessage('下载或启用失败，请稍后重试。详细信息可在高级设置中查看。')
    } finally {
      setTtsBusy(false)
    }
  }

  const handleInstallPreset = async () => {
    if (!selectedPresetId) return
    setSttBusy(true)
    setSttMessage('')
    setInstallerState({
      ...DEFAULT_INSTALLER_STATE,
      isInstalling: true,
      presetId: selectedPresetId,
      message: '正在准备下载…'
    })
    try {
      const result = await window.api.installSTTModelPreset(selectedPresetId)
      setInstallerState(result.installer)
      setSttStatus(result.status)
      await refreshPresets()
      setSttMessage(result.status.initialized ? '模型安装完成并已启用。' : '模型已下载，请尝试重新启用。')
    } catch {
      await refreshInstallerState()
      setSttMessage('模型安装失败，请检查网络后重试。')
    } finally {
      setSttBusy(false)
    }
  }

  const handleActivatePreset = async () => {
    if (!selectedPresetId) return
    setSttBusy(true)
    setSttMessage('')
    try {
      const status = await window.api.activateSTTModelPreset(selectedPresetId)
      setSttStatus(status)
      setSttMessage(status.initialized ? '已切换到所选语音识别模型。' : '模型暂时无法启用。')
    } catch {
      setSttMessage('模型启用失败，请展开高级设置检查模型文件。')
    } finally {
      setSttBusy(false)
    }
  }

  const handleDetectStt = async () => {
    setSttBusy(true)
    setSttMessage('')
    try {
      await window.api.initSTT()
      const status = await refreshSttStatus()
      await refreshPresets()
      setSttMessage(status.initialized ? '模型检测完成，语音识别可以使用。' : '尚未检测到可用模型。')
    } finally {
      setSttBusy(false)
    }
  }

  const handleSaveVoiceCaptureSettings = async () => {
    setVoiceCaptureMessage('')
    try {
      const savedSettings = await window.api.setVoiceCaptureSettings(voiceCaptureSettings)
      setVoiceCaptureSettings(savedSettings)
      setVoiceCaptureMessage('自动发送设置已保存。离线识别模型只会在结束录音后显示完整转写。')
    } catch (error) {
      setVoiceCaptureMessage(
        error instanceof Error ? error.message : '自动发送设置保存失败，请稍后重试。'
      )
    }
  }

  const handleRestoreConversation = async (conversationId: string) => {
    setRecycleBusyId(conversationId)
    try {
      await window.api.restoreConversation(conversationId)
      await refreshDeletedConversations()
    } finally {
      setRecycleBusyId(undefined)
    }
  }

  const handlePurgeConversation = async (conversation: ConversationSummary) => {
    if (!window.confirm(`彻底删除“${conversation.title}”吗？该会话的消息、纠错和复习数据将无法恢复。`)) {
      return
    }
    setRecycleBusyId(conversation.id)
    try {
      await window.api.purgeConversation(conversation.id)
      await refreshDeletedConversations()
    } finally {
      setRecycleBusyId(undefined)
    }
  }

  const handleSelectSttDir = async () => {
    setSttBusy(true)
    try {
      const status = await window.api.selectSTTModelDir()
      setSttStatus(status)
      await refreshPresets()
      setSttMessage(status.initialized ? '已加载所选模型目录。' : '所选目录不是完整的兼容模型。')
    } finally {
      setSttBusy(false)
    }
  }

  const handleClearSttDir = async () => {
    setSttBusy(true)
    try {
      setSttStatus(await window.api.clearSTTModelDir())
      await refreshPresets()
      setSttMessage('已恢复自动检测模型。')
    } finally {
      setSttBusy(false)
    }
  }

  const selectedPreset = sttPresets.find((item) => item.id === selectedPresetId)
  const selectedIsActive = Boolean(
    selectedPreset?.modelDir &&
    sttStatus?.modelDir &&
    selectedPreset.modelDir.toLowerCase() === sttStatus.modelDir.toLowerCase()
  )
  const progress = Math.max(0, Math.min(installerState.progress, 100))

  return (
    <div className="h-full overflow-y-auto bg-slate-50">
      <div className="mx-auto max-w-4xl px-4 py-6 pb-16 sm:px-8 sm:py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-slate-900">设置</h1>
          <p className="mt-1 text-sm text-slate-500">管理对话模型、语音识别和离线语音回复。</p>
        </div>

        {loadError && (
          <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {loadError}
          </div>
        )}

        <div className="space-y-5">
          <Section title="大模型" description="保存多套模型配置，并随时切换当前用于对话、纠错和复习的模型。">
            <div className="rounded-2xl border border-blue-100 bg-blue-50/70 p-4">
              <div className="flex flex-wrap items-end gap-3">
                <label className="min-w-0 flex-1">
                  <span className="mb-1.5 block text-sm font-medium text-slate-700">
                    当前配置
                  </span>
                  <select
                    value={llmStore.activeId}
                    onChange={(event) => void handleProfileChange(event.target.value)}
                    className="w-full rounded-xl border border-blue-200 bg-white px-3.5 py-2.5 text-sm font-medium text-slate-900 focus:border-blue-500 focus:outline-none"
                  >
                    {llmStore.profiles.map((profile) => (
                      <option key={profile.id} value={profile.id}>
                        {profileDisplayName(profile)}
                      </option>
                    ))}
                  </select>
                </label>
                <button
                  type="button"
                  onClick={handleAddProfile}
                  className="rounded-xl border border-blue-200 bg-white px-4 py-2.5 text-sm font-semibold text-blue-700 hover:bg-blue-50"
                >
                  ＋ 新增配置
                </button>
                <button
                  type="button"
                  onClick={() => void handleDeleteProfile()}
                  className="rounded-xl border border-red-200 bg-white px-4 py-2.5 text-sm font-medium text-red-600 hover:bg-red-50"
                >
                  删除
                </button>
              </div>
              <p className="mt-2 text-xs leading-5 text-blue-700">
                切换已保存配置后会立即生效；修改字段后请点击“保存并使用”。
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <label>
                <span className="mb-1.5 block text-sm font-medium text-slate-700">
                  配置名称
                </span>
                <input
                  type="text"
                  value={config.name}
                  onChange={(event) => updateConfig({ name: event.target.value })}
                  placeholder="例如：千帆日常对话"
                  className="w-full rounded-xl border border-slate-300 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:bg-white focus:outline-none"
                />
              </label>
              <label>
                <span className="mb-1.5 block text-sm font-medium text-slate-700">
                  接口类型
                </span>
                <select
                  value={config.provider}
                  onChange={(event) =>
                    handleProviderChange(event.target.value as LLMProvider)
                  }
                  className="w-full rounded-xl border border-slate-300 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-500 focus:bg-white focus:outline-none"
                >
                  {LLM_PROVIDER_DEFINITIONS.map((provider) => (
                    <option key={provider.id} value={provider.id}>
                      {provider.label}
                    </option>
                  ))}
                </select>
              </label>
              <p className="sm:col-span-2 -mt-2 rounded-xl bg-slate-50 px-3.5 py-2.5 text-sm leading-6 text-slate-600">
                {providerDefinition.description}
              </p>
              <label className="sm:col-span-2">
                <span className="mb-1.5 block text-sm font-medium text-slate-700">接口地址</span>
                <input
                  type="url"
                  value={config.baseUrl}
                  onChange={(event) => updateConfig({ baseUrl: event.target.value })}
                  placeholder={providerDefinition.baseUrlPlaceholder}
                  className="w-full rounded-xl border border-slate-300 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:bg-white focus:outline-none"
                />
              </label>
              <label>
                <span className="mb-1.5 block text-sm font-medium text-slate-700">API 密钥</span>
                <input
                  type="password"
                  value={config.apiKey}
                  onChange={(event) => updateConfig({ apiKey: event.target.value })}
                  placeholder={config.provider === 'apihz' ? '开发者 KEY' : 'API Key'}
                  className="w-full rounded-xl border border-slate-300 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:bg-white focus:outline-none"
                />
              </label>
              {providerDefinition.requiresApiId ? (
                <label>
                  <span className="mb-1.5 block text-sm font-medium text-slate-700">
                    开发者 ID
                  </span>
                  <input
                    type="text"
                    value={config.apiId}
                    onChange={(event) => updateConfig({ apiId: event.target.value })}
                    placeholder="用户中心的数字 ID"
                    className="w-full rounded-xl border border-slate-300 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:bg-white focus:outline-none"
                  />
                </label>
              ) : (
                <div className="hidden sm:block" aria-hidden="true" />
              )}
              <label>
                <span className="mb-1.5 block text-sm font-medium text-slate-700">模型名称</span>
                {config.provider === 'modelscope' ? (
                  <select
                    value={config.model}
                    onChange={(event) => updateConfig({ model: event.target.value })}
                    className="w-full rounded-xl border border-slate-300 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-500 focus:bg-white focus:outline-none"
                  >
                    {!MODELSCOPE_MODEL_FALLBACKS.includes(
                      config.model as (typeof MODELSCOPE_MODEL_FALLBACKS)[number]
                    ) && config.model ? (
                      <option value={config.model}>{config.model}（原配置）</option>
                    ) : null}
                    {MODELSCOPE_MODEL_FALLBACKS.map((model) => (
                      <option key={model} value={model}>{model}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type="text"
                    value={config.model}
                    onChange={(event) => updateConfig({ model: event.target.value })}
                    placeholder={providerDefinition.modelPlaceholder}
                    disabled={config.provider === 'apihz'}
                    className="w-full rounded-xl border border-slate-300 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:bg-white focus:outline-none"
                  />
                )}
              </label>
              {config.provider === 'modelscope' ? (
                <p className="sm:col-span-2 -mt-2 text-xs leading-5 text-slate-500">
                  遇到明确的“今日额度已用尽”“当前模型被限流”，或同一模型连续两次返回结构性空响应时，软件会按列表顺序轮换；无法确定具体模型的普通限流和其他接口错误不会触发切换。
                </p>
              ) : null}
            </div>
            <div className="mt-5 flex items-center gap-3">
              <button onClick={handleSave} className="rounded-xl bg-blue-600 px-5 py-2.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-700">
                {saved ? '已保存并启用' : '保存并使用'}
              </button>
              <span className="text-sm text-slate-500">
                已保存 {llmStore.profiles.length} 套配置
              </span>
            </div>
          </Section>

          <Section title="语音识别" description="选择并管理用于离线识别你说话内容的模型。">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <StatusBadge ready={Boolean(sttStatus?.initialized)} readyText="识别已就绪" pendingText="需要配置" />
              <span className="text-xs text-slate-500">
                已下载 {sttPresets.filter((preset) => preset.installed).length} / {sttPresets.length} 个模型
              </span>
            </div>
            <label className="mt-4 block">
              <span className="mb-1.5 block text-sm font-medium text-slate-700">语音识别模型</span>
              <select
                value={selectedPresetId}
                onChange={(event) => setSelectedPresetId(event.target.value)}
                disabled={sttBusy || installerState.isInstalling}
                className="w-full rounded-xl border border-slate-300 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-500 focus:bg-white focus:outline-none disabled:opacity-50"
              >
                {sttPresets.map((preset) => (
                  <option key={preset.id} value={preset.id}>
                    {preset.installed ? '已下载 · ' : ''}{preset.label}
                  </option>
                ))}
              </select>
            </label>
            {selectedPreset && <p className="mt-2 text-sm leading-6 text-slate-500">{selectedPreset.description}</p>}
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {selectedPreset?.installed ? (
                <button
                  onClick={handleActivatePreset}
                  disabled={sttBusy || installerState.isInstalling || selectedIsActive}
                  className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-default disabled:bg-emerald-600"
                >
                  {selectedIsActive ? '当前正在使用' : sttBusy ? '正在启用…' : '使用这个模型'}
                </button>
              ) : (
                <button
                  onClick={handleInstallPreset}
                  disabled={sttBusy || installerState.isInstalling || !selectedPreset}
                  className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                >
                  {installerState.isInstalling ? '正在下载…' : '下载并启用'}
                </button>
              )}
              {!sttStatus?.initialized && (
                <button onClick={handleDetectStt} disabled={sttBusy} className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                  重新检测
                </button>
              )}
            </div>
            {installerState.isInstalling && (
              <div className="mt-4 rounded-xl bg-blue-50 p-3">
                <div className="flex justify-between gap-3 text-sm text-blue-800">
                  <span>{installerState.message}</span>
                  <span>{Math.round(progress)}%</span>
                </div>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-blue-100">
                  <div className="h-full rounded-full bg-blue-600 transition-all" style={{ width: `${progress}%` }} />
                </div>
              </div>
            )}
            {sttMessage && <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{sttMessage}</p>}
          </Section>

          <Section
            title="自动发送"
            description="控制语音会话中开始说话前的等待时间、说完后的静音判定，以及环境噪声灵敏度。"
          >
            <div className="grid gap-4 sm:grid-cols-2">
              <label>
                <span className="mb-1.5 block text-sm font-medium text-slate-700">开始说话前等待</span>
                <select
                  value={voiceCaptureSettings.initialSilenceMs}
                  onChange={(event) => setVoiceCaptureSettings((current) => ({
                    ...current,
                    initialSilenceMs: Number(event.target.value)
                  }))}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm"
                >
                  {[5, 10, 15, 20, 30, 45, 60].map((seconds) => (
                    <option key={seconds} value={seconds * 1000}>{seconds} 秒</option>
                  ))}
                </select>
                <span className="mt-1 block text-xs text-slate-500">大模型说完后，在未开口前保留语音会话的最长时间。</span>
              </label>
              <label>
                <span className="mb-1.5 block text-sm font-medium text-slate-700">说话后静音判定</span>
                <select
                  value={voiceCaptureSettings.silenceAfterSpeechMs}
                  onChange={(event) => setVoiceCaptureSettings((current) => ({
                    ...current,
                    silenceAfterSpeechMs: Number(event.target.value)
                  }))}
                  className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm"
                >
                  {[1, 2, 3, 4, 5, 6, 8, 10, 15, 20].map((seconds) => (
                    <option key={seconds} value={seconds * 1000}>{seconds} 秒</option>
                  ))}
                </select>
                <span className="mt-1 block text-xs text-slate-500">检测到你说过话后，连续静音多久自动发送。</span>
              </label>
            </div>
            <label className="mt-5 block">
              <span className="flex items-center justify-between gap-3 text-sm font-medium text-slate-700">
                <span>声音灵敏度</span>
                <span className="rounded-full bg-blue-50 px-2.5 py-1 font-mono text-xs text-blue-700">
                  {voiceCaptureSettings.speechRmsThreshold.toFixed(3)}
                </span>
              </span>
              <input
                type="range"
                min="0.003"
                max="0.05"
                step="0.001"
                value={voiceCaptureSettings.speechRmsThreshold}
                onChange={(event) => setVoiceCaptureSettings((current) => ({
                  ...current,
                  speechRmsThreshold: Number(event.target.value)
                }))}
                className="mt-3 w-full accent-blue-600"
              />
              <span className="mt-1 flex justify-between text-xs text-slate-400">
                <span>更灵敏</span>
                <span>更抗环境噪声</span>
              </span>
            </label>
            <div className="mt-5 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={() => void handleSaveVoiceCaptureSettings()}
                className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700"
              >
                保存自动发送设置
              </button>
              {sttStatus && !sttStatus.supportsPartialResults && (
                <span className="text-xs text-slate-500">当前离线模型不支持实时转写，结束后会显示完整识别结果。</span>
              )}
            </div>
            {voiceCaptureMessage && <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{voiceCaptureMessage}</p>}
          </Section>

          <Section title="语音回复" description="使用本地 Kokoro 模型朗读大模型的回复，无需额外语音接口。">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <StatusBadge ready={Boolean(localTtsStatus?.initialized)} readyText="语音回复已就绪" pendingText="模型未就绪" />
              <button
                onClick={handleInstallLocalTts}
                disabled={ttsBusy || installerState.isInstalling}
                className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {ttsBusy ? '正在下载…' : localTtsStatus?.installed ? '重新安装' : '下载语音模型'}
              </button>
            </div>
            <label className="mt-4 block">
              <span className="mb-1.5 block text-sm font-medium text-slate-700">回复音色</span>
              <select
                value={voice}
                onChange={(event) => void handleVoiceChange(event.target.value)}
                className="w-full rounded-xl border border-slate-300 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900 focus:border-blue-500 focus:bg-white focus:outline-none"
              >
                {voices.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
              </select>
            </label>
            <label className="mt-5 block">
              <span className="flex items-center justify-between gap-3 text-sm font-medium text-slate-700">
                <span>语音速度</span>
                <span className="rounded-full bg-blue-50 px-2.5 py-1 font-semibold text-blue-700">
                  {ttsSpeed.toFixed(2)}×
                </span>
              </span>
              <input
                type="range"
                min="0.6"
                max="1.2"
                step="0.05"
                value={ttsSpeed}
                onChange={(event) => void handleSpeedChange(Number(event.target.value))}
                className="mt-3 w-full accent-blue-600"
              />
              <span className="mt-1 flex justify-between text-xs text-slate-400">
                <span>较慢</span>
                <span>正常速度 1.00×</span>
                <span>较快</span>
              </span>
            </label>
            {ttsMessage && <p className="mt-3 rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">{ttsMessage}</p>}
          </Section>

          <Section
            title="影视字幕剧情"
            description="将字幕整理成本地剧情知识，在讨论具体电影或剧集时按需使用。"
          >
            {subtitleConfig ? (
              <div className="space-y-5">
                <div className="rounded-xl border border-blue-100 bg-blue-50 p-4">
                  <p className="text-sm font-semibold text-slate-900">添加或复用字幕剧情知识</p>
                  <p className="mt-1 text-xs leading-5 text-slate-500">
                    从设置启动的任务只保存到本地，不会自动关联某个对话。
                  </p>
                  <div className="mt-3 grid gap-2 sm:grid-cols-[140px_minmax(0,1fr)_auto]">
                    <select
                      value={subtitleSearchType}
                      onChange={(event) =>
                        setSubtitleSearchType(event.target.value as MediaType | 'auto')
                      }
                      className="rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm"
                    >
                      <option value="auto">自动识别</option>
                      <option value="movie">电影</option>
                      <option value="tv">电视剧</option>
                    </select>
                    <input
                      value={subtitleSearchTitle}
                      onChange={(event) => setSubtitleSearchTitle(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' && subtitleSearchTitle.trim()) {
                          onOpenSubtitleWorkflow?.(
                            subtitleSearchTitle.trim(),
                            subtitleSearchType
                          )
                        }
                      }}
                      placeholder="输入电影或电视剧名称"
                      className="min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm outline-none focus:border-blue-500"
                    />
                    <button
                      type="button"
                      disabled={!subtitleSearchTitle.trim()}
                      onClick={() =>
                        onOpenSubtitleWorkflow?.(
                          subtitleSearchTitle.trim(),
                          subtitleSearchType
                        )
                      }
                      className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50"
                    >
                      打开字幕知识库
                    </button>
                  </div>
                </div>

                <div className="grid gap-3 sm:grid-cols-4">
                  <LibraryMetric label="影视作品" value={subtitleLibrary?.works || 0} />
                  <LibraryMetric label="字幕包" value={subtitleLibrary?.packages || 0} />
                  <LibraryMetric label="已处理剧集" value={subtitleLibrary?.processedScopes || 0} />
                  <LibraryMetric
                    label="占用空间"
                    value={formatStorageSize(subtitleLibrary?.cacheBytes || 0)}
                  />
                </div>
                {subtitleLibrary && subtitleLibrary.entries.length > 0 && (
                  <details className="rounded-xl border border-slate-200 bg-white">
                    <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-slate-700">
                      管理本地知识库（{subtitleLibrary.entries.length}）
                    </summary>
                    <div className="max-h-72 space-y-2 overflow-y-auto border-t border-slate-200 p-3">
                      {subtitleLibrary.entries.map((entry) => (
                        <div
                          key={entry.scopeId}
                          className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-slate-50 px-3 py-2"
                        >
                          <div>
                            <p className="text-sm font-medium text-slate-800">
                              {entry.media.title}
                              {entry.season ? ` · S${String(entry.season).padStart(2, '0')}` : ''}
                              {entry.episode ? `E${String(entry.episode).padStart(2, '0')}` : ''}
                            </p>
                            <p className="mt-0.5 text-xs text-slate-500">
                              {entry.status === 'ready' ? '剧情知识已就绪' : '字幕包已保存'}
                              {entry.source ? ` · ${entry.source}` : ''}
                            </p>
                          </div>
                          <div className="flex items-center gap-2">
                            {entry.status !== 'ready' && entry.packageId && (
                              <button
                                type="button"
                                disabled={Boolean(continuingSubtitle)}
                                onClick={() => void continueSubtitleSummary(entry)}
                                className="rounded-lg bg-blue-600 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
                              >
                                {continuingSubtitle?.scopeId === entry.scopeId
                                  ? '正在继续…'
                                  : entry.media.type === 'tv' && !entry.episode
                                    ? '选择集数继续'
                                    : '继续总结剧情'}
                              </button>
                            )}
                            <button
                              type="button"
                              onClick={() => {
                                if (!window.confirm('确定删除这条本地字幕知识记录吗？')) return
                                void window.api.deleteSubtitleLibraryEntry(entry.scopeId)
                              }}
                              className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50"
                            >
                              删除
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
                <label className="flex items-center justify-between gap-4 rounded-xl bg-slate-50 px-4 py-3">
                  <span>
                    <span className="block text-sm font-semibold text-slate-800">启用字幕剧情辅助</span>
                    <span className="mt-1 block text-xs text-slate-500">按需使用已关联的本地剧情知识。</span>
                  </span>
                  <input
                    type="checkbox"
                    checked={subtitleConfig.enabled}
                    onChange={(event) =>
                      setSubtitleConfig({ ...subtitleConfig, enabled: event.target.checked })
                    }
                    className="h-5 w-5 accent-blue-600"
                  />
                </label>
                {subtitleStatus?.sourceProvider?.available ? <>
                <div className="grid gap-3 sm:grid-cols-2">
                  {(['subhd', 'zimuwang'] as const).map((source) => (
                    <label key={source} className="rounded-xl border border-slate-200 p-3">
                      <span className="flex items-center justify-between gap-3">
                        <span className="text-sm font-semibold text-slate-800">
                          {source === 'subhd' ? 'SubHD' : 'ZiMuWang'}
                        </span>
                        <input
                          type="checkbox"
                          checked={subtitleConfig.sources[source].enabled}
                          onChange={(event) =>
                            setSubtitleConfig({
                              ...subtitleConfig,
                              sources: {
                                ...subtitleConfig.sources,
                                [source]: {
                                  ...subtitleConfig.sources[source],
                                  enabled: event.target.checked
                                }
                              }
                            })
                          }
                          className="h-4 w-4 accent-blue-600"
                        />
                      </span>
                      <span className="mt-2 block text-xs text-slate-500">
                        {subtitleStatus?.sources.find((item) => item.source === source)?.status === 'healthy'
                          ? '当前可访问'
                          : '尚未通过健康检查'}
                      </span>
                    </label>
                  ))}
                </div>
                <label className="block">
                  <span className="mb-1.5 block text-sm font-medium text-slate-700">
                    ZiMuWang 验证码识别模型
                  </span>
                  <select
                    value={subtitleConfig.captchaProfileId || ''}
                    onChange={(event) =>
                      setSubtitleConfig({
                        ...subtitleConfig,
                        captchaProfileId: event.target.value || undefined
                      })
                    }
                    className="w-full rounded-xl border border-slate-300 bg-slate-50 px-3.5 py-2.5 text-sm text-slate-900"
                  >
                    <option value="">请选择百度千帆视觉模型</option>
                    {llmStore.profiles
                      .filter((profile) => profile.provider === 'qianfan')
                      .map((profile) => (
                        <option key={profile.id} value={profile.id}>
                          {profileDisplayName(profile)}
                        </option>
                      ))}
                  </select>
                  <span className="mt-1.5 block text-xs leading-5 text-slate-500">
                    此配置只用于自动识别 ZiMuWang 五位验证码，不跟随当前对话模型切换。
                  </span>
                </label>
                </> : (
                  <p className="rounded-xl bg-slate-50 px-4 py-3 text-sm leading-6 text-slate-600">
                    此版本支持导入本地字幕、继续总结和复用剧情知识，未包含在线字幕搜索。
                  </p>
                )}
                <div className="rounded-xl bg-slate-50 px-4 py-3">
                  <p className="text-xs font-medium text-slate-700">字幕存储目录</p>
                  <p className="mt-1 break-all font-mono text-xs text-slate-500">
                    {subtitleStatus?.storage.root || '正在检测…'}
                  </p>
                  <p className={`mt-1 text-xs ${
                    subtitleStatus?.storage.writable ? 'text-emerald-600' : 'text-red-600'
                  }`}>
                    {subtitleStatus?.storage.writable
                      ? '目录可写，字幕不会转存到 AppData。'
                      : subtitleStatus?.storage.error || '目录不可写。'}
                  </p>
                </div>
                <details className="rounded-xl border border-slate-200 bg-white">
                  <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-slate-700">
                    高级字幕参数
                  </summary>
                  <div className="grid gap-3 border-t border-slate-200 p-4 sm:grid-cols-3">
                    {subtitleStatus?.sourceProvider?.available && <>
                    <label className="text-xs text-slate-600">
                      验证码尝试次数
                      <input
                        type="number"
                        min="1"
                        max="5"
                        value={subtitleConfig.captchaMaxAttempts}
                        onChange={(event) =>
                          setSubtitleConfig({
                            ...subtitleConfig,
                            captchaMaxAttempts: Number(event.target.value)
                          })
                        }
                        className="mt-1 block w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm"
                      />
                    </label>
                    <label className="text-xs text-slate-600">
                      每站搜索预算
                      <input
                        type="number"
                        min="1"
                        max="20"
                        value={subtitleConfig.queryBudgetPerSource}
                        onChange={(event) =>
                          setSubtitleConfig({
                            ...subtitleConfig,
                            queryBudgetPerSource: Number(event.target.value)
                          })
                        }
                        className="mt-1 block w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm"
                      />
                    </label>
                    </>}
                    <label className="text-xs text-slate-600">
                      场景分析并发数
                      <input
                        type="number"
                        min="1"
                        max="4"
                        value={subtitleConfig.sceneConcurrency}
                        onChange={(event) =>
                          setSubtitleConfig({
                            ...subtitleConfig,
                            sceneConcurrency: Number(event.target.value)
                          })
                        }
                        className="mt-1 block w-full rounded-lg border border-slate-300 px-2.5 py-2 text-sm"
                      />
                    </label>
                  </div>
                </details>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void handleSaveSubtitleConfig()}
                    className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700"
                  >
                    保存字幕设置
                  </button>
                  <button
                    type="button"
                    onClick={() => void window.api.openSubtitleDirectory()}
                    className="rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm text-slate-700 hover:bg-slate-50"
                  >
                    打开字幕目录
                  </button>
                </div>
                {subtitleMessage && (
                  <p className="rounded-lg bg-slate-50 px-3 py-2 text-sm text-slate-600">
                    {subtitleMessage}
                  </p>
                )}
              </div>
            ) : (
              <p className="text-sm text-slate-500">正在读取字幕功能状态…</p>
            )}
          </Section>

          <Section
            title="回收站"
            description="已删除的会话会暂存于此。恢复不会影响字幕知识库；彻底删除会级联清理该会话的消息、纠错与复习数据。"
          >
            {deletedConversations.length === 0 ? (
              <p className="rounded-xl bg-slate-50 px-4 py-3 text-sm text-slate-500">回收站为空。</p>
            ) : (
              <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
                {deletedConversations.map((conversation) => (
                  <div
                    key={conversation.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-4 py-3"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold text-slate-800">{conversation.title}</p>
                      <p className="mt-1 truncate text-xs text-slate-500">
                        {conversation.messageCount} 条消息 · {new Date(conversation.updatedAt).toLocaleString()}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-2">
                      <button
                        type="button"
                        disabled={recycleBusyId === conversation.id}
                        onClick={() => void handleRestoreConversation(conversation.id)}
                        className="rounded-lg border border-blue-200 bg-white px-3 py-1.5 text-xs font-semibold text-blue-700 hover:bg-blue-50 disabled:opacity-50"
                      >
                        恢复
                      </button>
                      <button
                        type="button"
                        disabled={recycleBusyId === conversation.id}
                        onClick={() => void handlePurgeConversation(conversation)}
                        className="rounded-lg border border-red-200 bg-white px-3 py-1.5 text-xs font-semibold text-red-700 hover:bg-red-50 disabled:opacity-50"
                      >
                        彻底删除
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Section>

          <details className="group rounded-2xl border border-slate-200 bg-white shadow-sm">
            <summary className="flex cursor-pointer list-none items-center justify-between gap-4 px-5 py-4 text-sm font-semibold text-slate-800 sm:px-6">
              <span>
                高级设置与诊断
                <span className="ml-2 font-normal text-slate-400">模型目录、文件检测和原始错误</span>
              </span>
              <span className="text-lg text-slate-400 transition group-open:rotate-180">⌄</span>
            </summary>
            <div className="border-t border-slate-200 px-5 py-5 sm:px-6">
              {llmDiagnosticStatus && (
                <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 p-4">
                  <label className="flex items-start justify-between gap-4">
                    <span>
                      <span className="block text-sm font-semibold text-slate-800">
                        完整大模型交互日志
                      </span>
                      <span className="mt-1 block text-xs leading-5 text-amber-800">
                        记录用户和助手对话、完整系统提示词、模型输入、原始返回与错误。不会记录 API Key、Authorization 或 Cookie。
                      </span>
                    </span>
                    <input
                      type="checkbox"
                      checked={llmDiagnosticStatus.enabled}
                      onChange={(event) => {
                        void window.api
                          .setLLMDiagnosticLogging(event.target.checked)
                          .then(setLlmDiagnosticStatus)
                      }}
                      className="mt-0.5 h-5 w-5 shrink-0 accent-blue-600"
                    />
                  </label>
                  <p className="mt-3 break-all font-mono text-xs text-slate-600">
                    {llmDiagnosticStatus.directory}
                  </p>
                  <button
                    type="button"
                    onClick={() => void window.api.openLLMDiagnosticLogDirectory()}
                    className="mt-3 rounded-lg border border-amber-300 bg-white px-3 py-2 text-sm font-medium text-amber-900 hover:bg-amber-100"
                  >
                    打开大模型日志目录
                  </button>
                </div>
              )}
              <div className="flex flex-wrap gap-2">
                <button onClick={handleSelectSttDir} disabled={sttBusy} className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50 disabled:opacity-50">选择模型目录</button>
                <button onClick={() => void window.api.openSTTModelDir(sttStatus?.defaultInstallDir)} className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">打开默认目录</button>
                <button onClick={() => void window.api.openSTTDownloadPage()} className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50">打开模型下载页</button>
                {sttStatus?.configuredModelDir && (
                  <button onClick={handleClearSttDir} disabled={sttBusy} className="rounded-lg border border-red-200 px-3 py-2 text-sm text-red-700 hover:bg-red-50">恢复自动检测</button>
                )}
              </div>
              <dl className="mt-5 grid gap-4 text-sm">
                <div>
                  <dt className="font-medium text-slate-700">当前识别状态</dt>
                  <dd className="mt-1 text-slate-500">{sttStatus?.message || '状态未知'}</dd>
                </div>
                <div>
                  <dt className="font-medium text-slate-700">当前模型目录</dt>
                  <dd className="mt-1 break-all font-mono text-xs text-slate-500">{sttStatus?.modelDir || '未检测到'}</dd>
                </div>
                <div>
                  <dt className="font-medium text-slate-700">默认安装目录</dt>
                  <dd className="mt-1 break-all font-mono text-xs text-slate-500">{sttStatus?.defaultInstallDir || '未知'}</dd>
                </div>
                {sttStatus?.missingFiles && sttStatus.missingFiles.length > 0 && (
                  <div>
                    <dt className="font-medium text-red-700">缺失文件</dt>
                    <dd className="mt-1 break-all font-mono text-xs text-red-600">{sttStatus.missingFiles.join(', ')}</dd>
                  </div>
                )}
                {localTtsStatus?.modelDir && (
                  <div>
                    <dt className="font-medium text-slate-700">语音回复模型目录</dt>
                    <dd className="mt-1 break-all font-mono text-xs text-slate-500">{localTtsStatus.modelDir}</dd>
                  </div>
                )}
                {localTtsStatus?.error && (
                  <div>
                    <dt className="font-medium text-red-700">语音回复原始错误</dt>
                    <dd className="mt-1 break-all font-mono text-xs text-red-600">{localTtsStatus.error}</dd>
                  </div>
                )}
                {installerState.error && (
                  <div>
                    <dt className="font-medium text-red-700">模型安装原始错误</dt>
                    <dd className="mt-1 break-all font-mono text-xs text-red-600">{installerState.error}</dd>
                  </div>
                )}
                {databaseStatus && (
                  <div>
                    <dt className="font-medium text-slate-700">学习数据库</dt>
                    <dd className="mt-1 break-all font-mono text-xs text-slate-500">
                      {databaseStatus.path}
                    </dd>
                    <div className="mt-2 flex items-center gap-2">
                      <span className={`text-xs font-medium ${
                        databaseStatus.ready ? 'text-emerald-600' : 'text-red-600'
                      }`}>
                        {databaseStatus.ready ? '运行正常' : databaseStatus.error || '不可用'}
                      </span>
                      <button
                        onClick={() => void window.api.openDataDirectory()}
                        className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-600 hover:bg-slate-50"
                      >
                        打开数据目录
                      </button>
                    </div>
                    {databaseStatus.diagnostic && (
                      <p className="mt-2 break-all font-mono text-xs text-red-600">
                        {databaseStatus.diagnostic}
                      </p>
                    )}
                  </div>
                )}
                {sttStatus?.searchedDirs && sttStatus.searchedDirs.length > 0 && (
                  <div>
                    <dt className="font-medium text-slate-700">自动检测过的目录</dt>
                    <dd className="mt-1 space-y-1">
                      {sttStatus.searchedDirs.map((dir) => <p key={dir} className="break-all font-mono text-xs text-slate-500">{dir}</p>)}
                    </dd>
                  </div>
                )}
              </dl>
            </div>
          </details>
        </div>
      </div>
    </div>
  )
}

function LibraryMetric({
  label,
  value
}: {
  label: string
  value: string | number
}) {
  return (
    <div className="rounded-xl bg-slate-50 px-3 py-3">
      <p className="text-xs text-slate-500">{label}</p>
      <p className="mt-1 text-lg font-semibold text-slate-900">{value}</p>
    </div>
  )
}

const formatStorageSize = (bytes: number) =>
  bytes >= 1024 * 1024 * 1024
    ? `${(bytes / 1024 / 1024 / 1024).toFixed(1)} GB`
    : bytes >= 1024 * 1024
      ? `${(bytes / 1024 / 1024).toFixed(1)} MB`
      : `${Math.round(bytes / 1024)} KB`
