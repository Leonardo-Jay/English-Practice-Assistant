export type MessageRole = 'user' | 'assistant'
export type PracticeMode = 'free' | 'topic' | 'vocab'
export type InputMode = 'voice' | 'text'
export type PersistedMessageStatus = 'pending' | 'complete' | 'failed'
export type AnalysisStatus = 'pending' | 'complete' | 'failed'

export interface Correction {
  id?: string
  original: string
  corrected: string
  type: 'grammar' | 'expression' | 'vocabulary'
  scope?: 'span' | 'sentence'
  sentenceIndex?: number
  explanation: string
  learningValue?: number
}

export interface CorrectionSentenceUnit {
  index: number
  text: string
  startOffset: number
  endOffset: number
}

export interface CorrectionContextMessage {
  role: MessageRole
  content: string
}

export interface CorrectionContext {
  conversationId: string
  userMessageId: string
  practiceMode: PracticeMode
  topic?: string
  contextSummary: string
  previousMessages: CorrectionContextMessage[]
  targetText: string
  sentences: CorrectionSentenceUnit[]
  degraded?: boolean
}

export interface VocabularyInsight {
  id?: string
  term: string
  normalizedTerm?: string
  partOfSpeech: string
  chineseMeaning: string
  sourceSentence?: string
  startOffset?: number
  endOffset?: number
  dictionaryEntryKey?: string
  dictionaryEdition?: string
}

export interface Message {
  id: string
  conversationId?: string
  sequence?: number
  role: MessageRole
  content: string
  timestamp: number
  inputMode?: InputMode
  replyToMessageId?: string
  status?: PersistedMessageStatus
  corrections?: Correction[]
  vocabulary?: VocabularyInsight[]
  correctionStatus?: AnalysisStatus
  vocabularyStatus?: AnalysisStatus
}

export interface ConversationSummary {
  id: string
  title: string
  practiceMode: PracticeMode
  topic?: string
  preview: string
  messageCount: number
  contentRevision: number
  analysisRevision: number
  createdAt: number
  updatedAt: number
  lastOpenedAt: number
}

export interface ConversationDetail extends ConversationSummary {
  messages: Message[]
  hasEarlierMessages: boolean
  contextSummary: string
  summaryThroughSequence: number
  contextPromptVersion: number
  mediaContext?: ConversationMediaContext
}

export interface ConversationPage {
  items: ConversationSummary[]
  nextCursor?: number
}

export interface ConversationMessagePage {
  messages: Message[]
  hasEarlierMessages: boolean
}

export interface ChatSendRequest {
  conversationId?: string
  clientRequestId: string
  content: string
  inputMode: InputMode
}

export interface ChatResponse {
  conversationId: string
  reply: string
  userMessageId: string
  assistantMessageId: string
}

export interface ConversationUpdateEvent {
  conversationId: string
  reason: 'message' | 'analysis' | 'metadata' | 'delete'
}

export interface ReviewExpression {
  id: string
  sourceUserMessageId: string
  original: string
  improved: string
  explanation: string
}

export interface ReviewCorrectionSelection {
  correctionId: string
  reason: string
  correctedMeaning: string
}

export interface ConversationReview {
  id: string
  conversationId: string
  sourceContentRevision: number
  sourceAnalysisRevision: number
  promptVersion: number
  status: 'generating' | 'ready' | 'failed'
  stale: boolean
  summary: string
  topics: string[]
  strengths: string[]
  priorities: string[]
  expressions: ReviewExpression[]
  selectedCorrections: ReviewCorrectionSelection[]
  error?: string
  generatedAt: number
}

export interface LearningReviewData {
  conversation: ConversationDetail
  review?: ConversationReview
}

export interface ReviewGenerationResult {
  conversationId: string
  review: ConversationReview
}

export type ReviewItemKind = 'vocabulary' | 'correction' | 'expression'
export type ReviewGrade = 'again' | 'hard' | 'good' | 'easy'
export type ReviewAnswerInputMode = 'text' | 'voice'

export interface ReviewAnswerEvaluation {
  level: 'strong' | 'close' | 'retry'
  score: number
  feedback: string
  strengths: string[]
  improvements: string[]
  suggestedGrade: ReviewGrade
}

export interface ReviewAttemptEvidence {
  response: string
  inputMode: ReviewAnswerInputMode
  evaluation: ReviewAnswerEvaluation
}

export interface ReviewItem {
  id: string
  kind: ReviewItemKind
  conversationId?: string
  sourceMessageId?: string
  prompt: string
  answer: string
  explanation: string
  meaning?: string
  sourceSentence?: string
  dueAt: number
  intervalDays: number
  repetitions: number
  lapses: number
  lastGrade?: ReviewGrade
  status: 'learning' | 'mastered'
  createdAt: number
  updatedAt: number
}

export interface ReviewDashboard {
  dueCount: number
  newCount: number
  masteredCount: number
  totalCount: number
  reviewedToday: number
  streakDays: number
  estimatedMinutes: number
  items: ReviewItem[]
}

export interface ReviewLibraryFilter {
  kind?: ReviewItemKind | 'all'
  status?: 'all' | 'due' | 'learning' | 'mastered'
  query?: string
  limit?: number
}

export interface ReviewAgentExpression {
  sourceUserMessageId: string
  original: string
  improved: string
  explanation: string
}

export interface ReviewAgentCorrection {
  correctionId: string
  reason: string
  correctedMeaning: string
}

export interface ReviewAgentResult {
  summary: string
  topics: string[]
  strengths: string[]
  priorities: string[]
  expressions: ReviewAgentExpression[]
  selectedCorrections: ReviewAgentCorrection[]
}

export interface DatabaseStatus {
  ready: boolean
  path: string
  error?: string
  diagnostic?: string
}

export type LLMProvider =
  | 'openai'
  | 'anthropic'
  | 'apihz'
  | 'qianfan'
  | 'longcat'
  | 'modelscope'

export interface LLMConfig {
  id?: string
  name?: string
  provider?: LLMProvider
  baseUrl: string
  apiKey: string
  apiId: string
  model: string
}

export interface LLMProfile extends LLMConfig {
  id: string
  name: string
  provider: LLMProvider
}

export interface LLMProfileStore {
  version: 2
  activeId: string
  profiles: LLMProfile[]
}

export interface LLMModelSwitchEvent {
  profileId?: string
  previousModel: string
  model: string
  reason:
    | 'daily-quota-exhausted'
    | 'model-rate-limited'
    | 'model-unavailable'
    | 'empty-response'
}

export interface LLMDiagnosticLogStatus {
  enabled: boolean
  directory: string
  containsFullContent: true
}

export interface ConversationState {
  messages: Message[]
  allCorrections: Correction[]
  mode: PracticeMode
  topic?: string
  isRecording: boolean
  isPlaying: boolean
  isLoading: boolean
}

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

export interface VoiceCaptureSettings {
  initialSilenceMs: number
  silenceAfterSpeechMs: number
  speechRmsThreshold: number
}

export interface TTSVoice {
  id: string
  label: string
}

export interface FileActionResult {
  success: boolean
  path: string
  error?: string
}

export type MediaType = 'movie' | 'tv'
export type MediaIntentAction = 'none' | 'clarify' | 'prepare'
export type MediaContextPhase =
  | 'idle'
  | 'candidate-detected'
  | 'awaiting-title-confirmation'
  | 'awaiting-season-episode'
  | 'confirmed'
  | 'searching'
  | 'awaiting-candidate-selection'
  | 'verifying'
  | 'downloading'
  | 'extracting'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'cancelled'

export interface MediaIdentity {
  id?: string
  type: MediaType
  title: string
  normalizedTitle: string
  aliases: string[]
  year?: number
  confirmed: boolean
}

export interface MediaIntent {
  action: MediaIntentAction
  mediaType?: MediaType
  title?: string
  aliases: string[]
  year?: number
  season?: number
  episode?: number
  plotIntent: boolean
  confirmed: boolean
  confidence: number
}

export interface ConversationMediaContext {
  conversationId: string
  media?: MediaIdentity
  season?: number
  episode?: number
  spoilerBoundary?: string
  phase: MediaContextPhase
  activeJobId?: string
  continueWithoutSubtitles?: boolean
  errorCode?: SubtitleErrorCode
  errorMessage?: string
  updatedAt: number
}

export type SubtitleOnlineSourceId = 'subhd' | 'zimuwang'
export type SubtitleSourceId = SubtitleOnlineSourceId | 'local'
export type SubtitleSourceOutcome =
  | 'ok'
  | 'no-results'
  | 'verification-required'
  | 'verification-failed'
  | 'rate-limited'
  | 'layout-changed'
  | 'unavailable'
  | 'download-rejected'

export type SubtitleErrorCode =
  | SubtitleSourceOutcome
  | 'captcha-profile-required'
  | 'captcha-recognition-failed'
  | 'captcha-rejected'
  | 'episode-not-found-in-pack'
  | 'corrupt-archive'
  | 'encrypted-archive'
  | 'archive-tool-missing'
  | 'download-truncated'
  | 'invalid-knowledge-json'
  | 'analysis-model-unavailable'
  | 'unsupported-archive'
  | 'unsafe-archive'
  | 'encoding-unknown'
  | 'storage-not-writable'
  | 'candidate-selection-timeout'
  | 'cancelled'
  | 'processing-failed'
  | 'source-extension-unavailable'

export interface SubtitleSourceHealth {
  source: SubtitleSourceId
  status: 'healthy' | 'unhealthy' | 'disabled'
  baseUrl: string
  checkedAt: number
  diagnostic?: string
}

export interface SubtitleSearchQuery {
  text: string
  kind: 'exact-episode' | 'season-pack' | 'title'
  alias: string
  priority: number
}

export interface SubtitleCandidate {
  id: string
  source: SubtitleSourceId
  title: string
  pageUrl: string
  downloadUrl?: string
  language?: 'bilingual' | 'english' | 'chinese' | 'unknown'
  format?: string
  packType?: 'episode' | 'season' | 'series' | 'movie' | 'unknown'
  season?: number
  episode?: number
  year?: number
  downloads?: number
  fileSize?: string
  score: number
  scoreReasons: string[]
}

export interface SubtitleDownloadResolution {
  source: SubtitleSourceId
  url: string
  referer?: string
  headers?: Record<string, string>
  filename?: string
}

export type SubtitleJobPhase = Exclude<MediaContextPhase, 'idle' | 'candidate-detected'>

export interface SubtitleJobProgress {
  jobId: string
  conversationId?: string
  requestId?: string
  origin?: SubtitleWorkflowOrigin
  phase: SubtitleJobPhase
  source?: SubtitleSourceId
  receivedBytes?: number
  totalBytes?: number
  percent?: number
  message: string
  candidates?: SubtitleCandidate[]
  errorCode?: SubtitleErrorCode
  diagnostic?: string
  updatedAt: number
}

export interface SubtitleDialogueScene {
  id: string
  ordinal: number
  startMs: number
  endMs: number
  dialogue: string
  analysis?: SubtitleSceneAnalysis
}

export interface SubtitleSceneAnalysis {
  summary: string
  characters: string[]
  relationshipChanges: string[]
  plotFacts: string[]
  keyDialogue: string[]
  uncertainties: string[]
}

export interface EpisodeKnowledge {
  title: string
  mediaType: MediaType
  year?: number
  season?: number
  episode?: number
  spoilerBoundary: string
  plotSummary: string
  characters: string[]
  relationships: string[]
  orderedEvents: string[]
  keyDialogue: string[]
  uncertainties: string[]
}

export interface GroundedMediaContext {
  identity: MediaIdentity
  season?: number
  episode?: number
  spoilerBoundary: string
  overview: EpisodeKnowledge
  scenes: Array<Pick<SubtitleDialogueScene, 'ordinal' | 'dialogue' | 'analysis'>>
}

export type MediaMentionStatus = 'pending' | 'dismissed' | 'accepted'
export type SubtitleWorkflowOrigin = 'chat' | 'settings'

export interface MediaMentionSuggestion {
  id: string
  conversationId: string
  messageId: string
  media: MediaIdentity
  season?: number
  episode?: number
  evidenceText: string
  confidence: number
  status: MediaMentionStatus
  availability: 'ready' | 'package' | 'missing'
  createdAt: number
  updatedAt: number
}

export interface DetectedMediaMention {
  mediaType?: MediaType
  title?: string
  aliases: string[]
  year?: number
  season?: number
  episode?: number
  evidenceText?: string
  confidence: number
}

export interface SubtitlePackage {
  id: string
  media: MediaIdentity
  season?: number
  episode?: number
  packType: SubtitleCandidate['packType']
  source: SubtitleSourceId
  rawRelativePath: string
  manifestRelativePaths: string[]
  sha256: string
  byteSize: number
  status: 'ready' | 'failed'
  createdAt: number
  updatedAt: number
}

export interface SubtitleLibraryEntry {
  scopeId: string
  media: MediaIdentity
  packageId?: string
  assetId?: string
  season?: number
  episode?: number
  packType?: SubtitleCandidate['packType']
  source?: SubtitleSourceId
  status: 'package' | 'processing' | 'ready' | 'failed'
  byteSize: number
  updatedAt: number
  linkedConversationIds?: string[]
}

export interface SubtitleLibrarySummary {
  works: number
  packages: number
  processedScopes: number
  cacheBytes: number
  entries: SubtitleLibraryEntry[]
}

export interface SubtitleWorkflowRequest {
  requestId: string
  origin: SubtitleWorkflowOrigin
  conversationId?: string
  mentionId?: string
  mediaType: MediaType | 'auto'
  title: string
  aliases?: string[]
  year?: number
  season?: number
  episode?: number
}

export interface SubtitleWorkflowStartResult {
  requestId: string
  jobId?: string
  status: 'started' | 'ready'
  entry?: SubtitleLibraryEntry
}

export interface MediaKnowledgeDecision {
  useKnowledge: boolean
  scopeIds: string[]
  retrievalQuery: string
  reason: string
}

export interface SubtitleFeatureConfig {
  enabled: boolean
  sources: Record<SubtitleOnlineSourceId, { enabled: boolean; baseUrls: string[] }>
  captchaProfileId?: string
  captchaProfile?: LLMConfig
  captchaMaxAttempts: number
  queryBudgetPerSource: number
  sceneConcurrency: number
  requestTimeoutMs: number
}

export interface SubtitleStorageStatus {
  root: string
  writable: boolean
  cacheBytes: number
  error?: string
}

export interface SubtitleFeatureStatus {
  sourceProvider: { available: boolean }
  config: SubtitleFeatureConfig
  storage: SubtitleStorageStatus
  sources: SubtitleSourceHealth[]
}

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

export interface SttInstallResult {
  installer: SttInstallerState
  status: SttStatus
}

export interface ElectronAPI {
  sendChat: (request: ChatSendRequest) => Promise<ChatResponse>
  retryChat: (conversationId: string, userMessageId: string) => Promise<ChatResponse>
  analyzeCorrections: (
    conversationId: string,
    content: string,
    userMessageId: string
  ) => Promise<Correction[]>
  analyzeVocabulary: (
    conversationId: string,
    content: string,
    assistantMessageId: string
  ) => Promise<VocabularyInsight[]>
  configureLLM: (config: LLMConfig) => Promise<void>
  getLLMProfiles: () => Promise<LLMProfileStore | undefined>
  saveLLMProfiles: (store: LLMProfileStore) => Promise<LLMProfileStore>
  getLLMDiagnosticLogStatus: () => Promise<LLMDiagnosticLogStatus>
  setLLMDiagnosticLogging: (
    enabled: boolean
  ) => Promise<LLMDiagnosticLogStatus>
  openLLMDiagnosticLogDirectory: () => Promise<FileActionResult>
  onLLMModelSwitched: (
    listener: (event: LLMModelSwitchEvent) => void
  ) => () => void
  listConversations: (cursor?: number, limit?: number, query?: string) => Promise<ConversationPage>
  getConversation: (conversationId: string) => Promise<ConversationDetail | null>
  getConversationMessages: (
    conversationId: string,
    beforeSequence?: number,
    limit?: number
  ) => Promise<ConversationMessagePage>
  getActiveConversation: () => Promise<ConversationDetail | null>
  setActiveConversation: (conversationId: string) => Promise<ConversationDetail | null>
  renameConversation: (conversationId: string, title: string) => Promise<void>
  deleteConversation: (conversationId: string) => Promise<string | null>
  listDeletedConversations: (limit?: number) => Promise<ConversationSummary[]>
  restoreConversation: (conversationId: string) => Promise<void>
  purgeConversation: (conversationId: string) => Promise<void>
  setConversationMode: (
    conversationId: string,
    mode: PracticeMode,
    topic?: string
  ) => Promise<void>
  getReview: (conversationId: string) => Promise<LearningReviewData>
  generateReview: (conversationId: string, force?: boolean) => Promise<ReviewGenerationResult>
  getReviewDashboard: (limit?: number) => Promise<ReviewDashboard>
  evaluateReviewAnswer: (itemId: string, response: string) => Promise<ReviewAnswerEvaluation>
  gradeReviewItem: (
    itemId: string,
    grade: ReviewGrade,
    evidence?: ReviewAttemptEvidence
  ) => Promise<ReviewItem>
  listReviewLibrary: (filter?: ReviewLibraryFilter) => Promise<ReviewItem[]>
  setReviewItemMastered: (itemId: string, mastered: boolean) => Promise<ReviewItem>
  deleteReviewItem: (itemId: string) => Promise<void>
  getDatabaseStatus: () => Promise<DatabaseStatus>
  openDataDirectory: () => Promise<FileActionResult>
  getSubtitleStatus: () => Promise<SubtitleFeatureStatus>
  getSubtitleConfig: () => Promise<SubtitleFeatureConfig>
  setSubtitleConfig: (
    config: Partial<SubtitleFeatureConfig>
  ) => Promise<SubtitleFeatureConfig>
  getMediaContext: (
    conversationId: string
  ) => Promise<ConversationMediaContext | undefined>
  clearMediaContext: (conversationId: string) => Promise<void>
  retryMediaContext: (conversationId: string) => Promise<void>
  continueWithoutSubtitles: (conversationId: string) => Promise<void>
  cancelSubtitleJob: (jobId: string) => Promise<void>
  selectSubtitleCandidate: (
    jobId: string,
    candidateId: string
  ) => Promise<void>
  openSubtitleDirectory: () => Promise<FileActionResult>
  listMediaMentions: (
    conversationId: string
  ) => Promise<MediaMentionSuggestion[]>
  dismissMediaMention: (mentionId: string) => Promise<void>
  listSubtitleLibrary: () => Promise<SubtitleLibrarySummary>
  startSubtitleWorkflow: (
    request: SubtitleWorkflowRequest
  ) => Promise<SubtitleWorkflowStartResult>
  importLocalSubtitle: (
    request: SubtitleWorkflowRequest
  ) => Promise<SubtitleWorkflowStartResult | null>
  getSubtitleJob: (jobId: string) => Promise<SubtitleJobProgress | undefined>
  processSubtitleEpisode: (
    packageId: string,
    season: number | undefined,
    episode: number | undefined,
    request: Pick<
      SubtitleWorkflowRequest,
      'requestId' | 'origin' | 'conversationId' | 'mentionId'
    >
  ) => Promise<SubtitleWorkflowStartResult>
  attachSubtitleKnowledge: (
    conversationId: string,
    scopeId: string,
    mentionId?: string
  ) => Promise<void>
  detachSubtitleKnowledge: (
    conversationId: string,
    scopeId: string
  ) => Promise<void>
  deleteSubtitleLibraryEntry: (scopeId: string) => Promise<void>
  onSubtitleProgress: (
    listener: (event: SubtitleJobProgress) => void
  ) => () => void
  onMediaMentionDetected: (
    listener: (event: MediaMentionSuggestion) => void
  ) => () => void
  onSubtitleLibraryUpdated: (
    listener: (event: SubtitleLibrarySummary) => void
  ) => () => void
  onConversationUpdated: (listener: (event: ConversationUpdateEvent) => void) => () => void
  onReviewUpdated: (listener: (event: ConversationUpdateEvent) => void) => () => void
  synthesizeTTS: (text: string, voice?: string) => Promise<ArrayBuffer>
  setTTSVoice: (voice: string) => Promise<void>
  getTTSVoice: () => Promise<string>
  setTTSSpeed: (speed: number) => Promise<void>
  getTTSSpeed: () => Promise<number>
  getTTSVoices: () => Promise<TTSVoice[]>
  getLocalTTSModelStatus: () => Promise<{
    installed: boolean
    initialized: boolean
    modelDir: string
    installer: SttInstallerState
    error?: string | null
  }>
  installLocalTTSModel: () => Promise<{
    installed: boolean
    initialized: boolean
    modelDir: string
    installer: SttInstallerState
    error?: string | null
  }>
  initSTT: () => Promise<boolean>
  isSTTInitialized: () => Promise<boolean>
  getSTTStatus: () => Promise<SttStatus>
  getSTTModelPresets: () => Promise<SttModelPreset[]>
  getSTTInstallerState: () => Promise<SttInstallerState>
  installSTTModelPreset: (presetId: string) => Promise<SttInstallResult>
  activateSTTModelPreset: (presetId: string) => Promise<SttStatus>
  selectSTTModelDir: () => Promise<SttStatus>
  clearSTTModelDir: () => Promise<SttStatus>
  openSTTModelDir: (targetDir?: string) => Promise<FileActionResult>
  openSTTDownloadPage: () => Promise<void>
  getVoiceCaptureSettings: () => Promise<VoiceCaptureSettings>
  setVoiceCaptureSettings: (
    settings: Partial<VoiceCaptureSettings>
  ) => Promise<VoiceCaptureSettings>
  startSTT: () => Promise<void>
  feedSTTChunk: (samples: Float32Array) => Promise<SttResult>
  stopSTT: () => Promise<string>
}
