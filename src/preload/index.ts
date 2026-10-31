import { contextBridge, ipcRenderer } from 'electron'
import type {
  LLMConfig,
  LLMModelSwitchEvent,
  MediaMentionSuggestion,
  SubtitleFeatureConfig,
  SubtitleJobProgress,
  SubtitleLibrarySummary,
  SubtitleWorkflowRequest,
  VoiceCaptureSettings,
  LLMProfileStore,
  ReviewGrade,
  ReviewLibraryFilter,
  ReviewAttemptEvidence
} from '../shared/types'

contextBridge.exposeInMainWorld('api', {
  sendChat: (request: {
    conversationId?: string
    clientRequestId: string
    content: string
    inputMode: 'voice' | 'text'
  }) => ipcRenderer.invoke('chat:send', request),
  retryChat: (conversationId: string, userMessageId: string) =>
    ipcRenderer.invoke('chat:retry', conversationId, userMessageId),
  analyzeCorrections: (
    conversationId: string,
    content: string,
    userMessageId: string
  ) => ipcRenderer.invoke('llm:correct', conversationId, content, userMessageId),
  analyzeVocabulary: (
    conversationId: string,
    content: string,
    assistantMessageId: string
  ) =>
    ipcRenderer.invoke(
      'llm:vocabulary',
      conversationId,
      content,
      assistantMessageId
    ),
  configureLLM: (config: LLMConfig) =>
    ipcRenderer.invoke('llm:configure', config),
  getLLMProfiles: () => ipcRenderer.invoke('llm:getProfiles'),
  saveLLMProfiles: (store: LLMProfileStore) =>
    ipcRenderer.invoke('llm:saveProfiles', store),
  getLLMDiagnosticLogStatus: () =>
    ipcRenderer.invoke('llm:getDiagnosticLogStatus'),
  setLLMDiagnosticLogging: (enabled: boolean) =>
    ipcRenderer.invoke('llm:setDiagnosticLogging', enabled),
  openLLMDiagnosticLogDirectory: () =>
    ipcRenderer.invoke('llm:openDiagnosticLogDirectory'),
  onLLMModelSwitched: (
    listener: (event: LLMModelSwitchEvent) => void
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: LLMModelSwitchEvent
    ) => listener(payload)
    ipcRenderer.on('llm:model-switched', handler)
    return () => ipcRenderer.removeListener('llm:model-switched', handler)
  },
  listConversations: (cursor?: number, limit?: number, query?: string) =>
    ipcRenderer.invoke('conversation:list', cursor, limit, query),
  getConversation: (conversationId: string) =>
    ipcRenderer.invoke('conversation:get', conversationId),
  getConversationMessages: (
    conversationId: string,
    beforeSequence?: number,
    limit?: number
  ) => ipcRenderer.invoke('conversation:getMessages', conversationId, beforeSequence, limit),
  getActiveConversation: () => ipcRenderer.invoke('conversation:getActive'),
  setActiveConversation: (conversationId: string) =>
    ipcRenderer.invoke('conversation:setActive', conversationId),
  renameConversation: (conversationId: string, title: string) =>
    ipcRenderer.invoke('conversation:rename', conversationId, title),
  deleteConversation: (conversationId: string) =>
    ipcRenderer.invoke('conversation:delete', conversationId),
  listDeletedConversations: (limit?: number) =>
    ipcRenderer.invoke('conversation:listDeleted', limit),
  restoreConversation: (conversationId: string) =>
    ipcRenderer.invoke('conversation:restore', conversationId),
  purgeConversation: (conversationId: string) =>
    ipcRenderer.invoke('conversation:purge', conversationId),
  setConversationMode: (conversationId: string, mode: string, topic?: string) =>
    ipcRenderer.invoke('conversation:setMode', conversationId, mode, topic),
  getReview: (conversationId: string) =>
    ipcRenderer.invoke('review:get', conversationId),
  generateReview: (conversationId: string, force?: boolean) =>
    ipcRenderer.invoke('review:generate', conversationId, force),
  getReviewDashboard: (limit?: number) => ipcRenderer.invoke('review:dashboard', limit),
  evaluateReviewAnswer: (itemId: string, response: string) =>
    ipcRenderer.invoke('review:evaluateAnswer', itemId, response),
  gradeReviewItem: (itemId: string, grade: ReviewGrade, evidence?: ReviewAttemptEvidence) =>
    ipcRenderer.invoke('review:grade', itemId, grade, evidence),
  listReviewLibrary: (filter?: ReviewLibraryFilter) =>
    ipcRenderer.invoke('review:listLibrary', filter),
  setReviewItemMastered: (itemId: string, mastered: boolean) =>
    ipcRenderer.invoke('review:setMastered', itemId, mastered),
  deleteReviewItem: (itemId: string) => ipcRenderer.invoke('review:deleteItem', itemId),
  getDatabaseStatus: () => ipcRenderer.invoke('database:getStatus'),
  openDataDirectory: () => ipcRenderer.invoke('database:openDirectory'),
  getSubtitleStatus: () => ipcRenderer.invoke('subtitle:getStatus'),
  getSubtitleConfig: () => ipcRenderer.invoke('subtitle:getConfig'),
  setSubtitleConfig: (config: Partial<SubtitleFeatureConfig>) =>
    ipcRenderer.invoke('subtitle:setConfig', config),
  getMediaContext: (conversationId: string) =>
    ipcRenderer.invoke('subtitle:getContext', conversationId),
  clearMediaContext: (conversationId: string) =>
    ipcRenderer.invoke('subtitle:clearContext', conversationId),
  retryMediaContext: (conversationId: string) =>
    ipcRenderer.invoke('subtitle:retry', conversationId),
  continueWithoutSubtitles: (conversationId: string) =>
    ipcRenderer.invoke('subtitle:continueWithout', conversationId),
  cancelSubtitleJob: (jobId: string) =>
    ipcRenderer.invoke('subtitle:cancel', jobId),
  selectSubtitleCandidate: (jobId: string, candidateId: string) =>
    ipcRenderer.invoke('subtitle:selectCandidate', jobId, candidateId),
  openSubtitleDirectory: () => ipcRenderer.invoke('subtitle:openDirectory'),
  listMediaMentions: (conversationId: string) =>
    ipcRenderer.invoke('subtitle:listMentions', conversationId),
  dismissMediaMention: (mentionId: string) =>
    ipcRenderer.invoke('subtitle:dismissMention', mentionId),
  listSubtitleLibrary: () => ipcRenderer.invoke('subtitle:listLibrary'),
  importLocalSubtitle: (request: import('../shared/types').SubtitleWorkflowRequest) =>
    ipcRenderer.invoke('subtitle:importLocal', request),
  startSubtitleWorkflow: (request: SubtitleWorkflowRequest) =>
    ipcRenderer.invoke('subtitle:startWorkflow', request),
  getSubtitleJob: (jobId: string) =>
    ipcRenderer.invoke('subtitle:getJob', jobId),
  processSubtitleEpisode: (
    packageId: string,
    season: number | undefined,
    episode: number | undefined,
    request: Pick<
      SubtitleWorkflowRequest,
      'requestId' | 'origin' | 'conversationId' | 'mentionId'
    >
  ) => ipcRenderer.invoke(
    'subtitle:processEpisode',
    packageId,
    season,
    episode,
    request
  ),
  attachSubtitleKnowledge: (
    conversationId: string,
    scopeId: string,
    mentionId?: string
  ) => ipcRenderer.invoke(
    'subtitle:attachKnowledge',
    conversationId,
    scopeId,
    mentionId
  ),
  detachSubtitleKnowledge: (conversationId: string, scopeId: string) =>
    ipcRenderer.invoke('subtitle:detachKnowledge', conversationId, scopeId),
  deleteSubtitleLibraryEntry: (scopeId: string) =>
    ipcRenderer.invoke('subtitle:deleteLibraryEntry', scopeId),
  onSubtitleProgress: (
    listener: (event: SubtitleJobProgress) => void
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: SubtitleJobProgress
    ) => listener(payload)
    ipcRenderer.on('subtitle:progress', handler)
    return () => ipcRenderer.removeListener('subtitle:progress', handler)
  },
  onMediaMentionDetected: (
    listener: (event: MediaMentionSuggestion) => void
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: MediaMentionSuggestion
    ) => listener(payload)
    ipcRenderer.on('subtitle:mention-detected', handler)
    return () => ipcRenderer.removeListener('subtitle:mention-detected', handler)
  },
  onSubtitleLibraryUpdated: (
    listener: (event: SubtitleLibrarySummary) => void
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: SubtitleLibrarySummary
    ) => listener(payload)
    ipcRenderer.on('subtitle:library-updated', handler)
    return () => ipcRenderer.removeListener('subtitle:library-updated', handler)
  },
  onConversationUpdated: (
    listener: (event: { conversationId: string; reason: string }) => void
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: { conversationId: string; reason: string }
    ) => listener(payload)
    ipcRenderer.on('conversation:updated', handler)
    return () => ipcRenderer.removeListener('conversation:updated', handler)
  },
  onReviewUpdated: (
    listener: (event: { conversationId: string; reason: string }) => void
  ) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      payload: { conversationId: string; reason: string }
    ) => listener(payload)
    ipcRenderer.on('review:updated', handler)
    return () => ipcRenderer.removeListener('review:updated', handler)
  },

  // TTS
  synthesizeTTS: (text: string, voice?: string) => ipcRenderer.invoke('tts:synthesize', text, voice),
  setTTSVoice: (voice: string) => ipcRenderer.invoke('tts:setVoice', voice),
  getTTSVoice: () => ipcRenderer.invoke('tts:getVoice'),
  setTTSSpeed: (speed: number) => ipcRenderer.invoke('tts:setSpeed', speed),
  getTTSSpeed: () => ipcRenderer.invoke('tts:getSpeed'),
  getTTSVoices: () => ipcRenderer.invoke('tts:getVoices'),
  getLocalTTSModelStatus: () => ipcRenderer.invoke('tts:getLocalModelStatus'),
  installLocalTTSModel: () => ipcRenderer.invoke('tts:installLocalModel'),

  // STT
  initSTT: () => ipcRenderer.invoke('stt:init'),
  isSTTInitialized: () => ipcRenderer.invoke('stt:isInitialized'),
  getSTTStatus: () => ipcRenderer.invoke('stt:getStatus'),
  getSTTModelPresets: () => ipcRenderer.invoke('stt:getModelPresets'),
  getSTTInstallerState: () => ipcRenderer.invoke('stt:getInstallerState'),
  installSTTModelPreset: (presetId: string) => ipcRenderer.invoke('stt:installPreset', presetId),
  activateSTTModelPreset: (presetId: string) => ipcRenderer.invoke('stt:activatePreset', presetId),
  selectSTTModelDir: () => ipcRenderer.invoke('stt:selectModelDir'),
  clearSTTModelDir: () => ipcRenderer.invoke('stt:clearModelDir'),
  openSTTModelDir: (targetDir?: string) => ipcRenderer.invoke('stt:openModelDir', targetDir),
  openSTTDownloadPage: () => ipcRenderer.invoke('stt:openDownloadPage'),
  getVoiceCaptureSettings: () => ipcRenderer.invoke('voiceCapture:getSettings'),
  setVoiceCaptureSettings: (settings: Partial<VoiceCaptureSettings>) =>
    ipcRenderer.invoke('voiceCapture:setSettings', settings),
  startSTT: () => ipcRenderer.invoke('stt:start'),
  feedSTTChunk: (samples: Float32Array) => ipcRenderer.invoke('stt:feedChunk', samples),
  stopSTT: () => ipcRenderer.invoke('stt:stop')
})
