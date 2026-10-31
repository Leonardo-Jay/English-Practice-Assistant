import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import type {
  ChatResponse,
  ChatSendRequest,
  ConversationDetail,
  ConversationMessagePage,
  ConversationPage,
  ConversationSummary,
  Correction,
  Message,
  PracticeMode,
  VocabularyInsight
} from '../../shared/types'
import {
  AnalysisRepository,
  AppStateRepository,
  ConversationRepository,
  MessageRepository,
  normalizeEnglishTerm
} from '../database/repositories'
import type { LLMClient } from './llm-client'
import { CorrectionContextAssembler } from './correction-context'
import type { MediaMentionService } from '../subtitles/media-mention-service'
import type { MediaKnowledgeDecisionService } from '../subtitles/media-knowledge-decision-service'

const CONTEXT_TOKEN_TRIGGER = 6_000
const CONTEXT_MESSAGE_TRIGGER = 24
const RECENT_MESSAGES_AFTER_COMPRESSION = 10
const RECENT_MESSAGES_FOR_LARGE_CONTEXT = 6
const CONTEXT_PROMPT_VERSION = 1
const ACTIVE_CONVERSATION_KEY = 'last_conversation_id'
const CORRECTION_PROMPT_VERSION = 2
const RENDERER_MESSAGE_PAGE_SIZE = 80

export class ConversationService {
  readonly conversations: ConversationRepository
  readonly messages: MessageRepository
  readonly analyses: AnalysisRepository
  readonly appState: AppStateRepository
  private readonly correctionContexts: CorrectionContextAssembler
  private acceptingWrites = true

  constructor(
    private readonly db: Database.Database,
    private readonly llm: LLMClient,
    private readonly onUpdated: (
      conversationId: string,
      reason: 'message' | 'analysis' | 'metadata' | 'delete'
    ) => void,
    private readonly mediaMentions?: MediaMentionService,
    private readonly mediaKnowledge?: MediaKnowledgeDecisionService
  ) {
    this.conversations = new ConversationRepository(db)
    this.messages = new MessageRepository(db)
    this.analyses = new AnalysisRepository(db, this.conversations)
    this.appState = new AppStateRepository(db)
    this.correctionContexts = new CorrectionContextAssembler(
      this.conversations,
      this.messages
    )
    this.analyses.markInterruptedJobsRetryable()
  }

  list(cursor?: number, limit?: number, query?: string): ConversationPage {
    return this.conversations.list(cursor, limit, query)
  }

  get(conversationId: string): ConversationDetail | null {
    return this.withMedia(
      this.conversations.getDetail(conversationId, RENDERER_MESSAGE_PAGE_SIZE)
    )
  }

  getMessagePage(
    conversationId: string,
    beforeSequence?: number,
    limit?: number
  ): ConversationMessagePage {
    if (!this.conversations.getSummary(conversationId)) {
      throw new Error('会话不存在或已删除。')
    }
    return this.conversations.getMessagePage(conversationId, beforeSequence, limit)
  }

  getActive(): ConversationDetail | null {
    const storedId = this.appState.get(ACTIVE_CONVERSATION_KEY)
    const id =
      (storedId && this.conversations.getSummary(storedId) ? storedId : undefined) ||
      this.conversations.getMostRecentId()
    if (!id) return null
    this.appState.set(ACTIVE_CONVERSATION_KEY, id)
    this.conversations.touchOpened(id)
    return this.withMedia(
      this.conversations.getDetail(id, RENDERER_MESSAGE_PAGE_SIZE)
    )
  }

  setActive(conversationId: string): ConversationDetail | null {
    const detail = this.conversations.getDetail(conversationId, RENDERER_MESSAGE_PAGE_SIZE)
    if (!detail) return null
    this.appState.set(ACTIVE_CONVERSATION_KEY, conversationId)
    this.conversations.touchOpened(conversationId)
    return this.withMedia(
      this.conversations.getDetail(conversationId, RENDERER_MESSAGE_PAGE_SIZE)
    )
  }

  rename(conversationId: string, title: string): void {
    this.assertWritable()
    this.conversations.rename(conversationId, title)
    this.onUpdated(conversationId, 'metadata')
  }

  delete(conversationId: string): string | null {
    this.assertWritable()
    this.conversations.softDelete(conversationId)
    if (this.appState.get(ACTIVE_CONVERSATION_KEY) === conversationId) {
      this.appState.delete(ACTIVE_CONVERSATION_KEY)
    }
    const nextId = this.conversations.getMostRecentId()
    if (nextId) this.appState.set(ACTIVE_CONVERSATION_KEY, nextId)
    this.onUpdated(conversationId, 'delete')
    return nextId
  }

  listDeleted(limit?: number): ConversationSummary[] {
    return this.conversations.listDeleted(limit)
  }

  restore(conversationId: string): void {
    this.assertWritable()
    this.conversations.restore(conversationId)
    this.onUpdated(conversationId, 'metadata')
  }

  purge(conversationId: string): void {
    this.assertWritable()
    this.conversations.purge(conversationId)
    this.onUpdated(conversationId, 'delete')
  }

  setMode(conversationId: string, mode: PracticeMode, topic?: string): void {
    this.assertWritable()
    this.conversations.setMode(conversationId, mode, topic)
    this.onUpdated(conversationId, 'metadata')
  }

  async send(request: ChatSendRequest): Promise<ChatResponse> {
    this.assertWritable()
    const content = request.content.replace(/\s+/g, ' ').trim()
    if (!content) throw new Error('请输入要发送的内容。')

    let conversationId = request.conversationId
    let userMessage: Message
    if (!conversationId) {
      conversationId = randomUUID()
      const newId = conversationId
      const create = this.db.transaction(() => {
        this.conversations.create(newId, this.createTitle(content))
        return this.messages.insertUser(
          newId,
          request.clientRequestId,
          content,
          request.inputMode
        )
      })
      userMessage = create()
      this.appState.set(ACTIVE_CONVERSATION_KEY, conversationId)
    } else {
      if (!this.conversations.getSummary(conversationId)) {
        throw new Error('当前会话不存在或已删除，请新建对话。')
      }
      userMessage = this.messages.insertUser(
        conversationId,
        request.clientRequestId,
        content,
        request.inputMode
      )
    }

    const existingReply = this.messages.getReplyTo(userMessage.id)
    if (existingReply) {
      return {
        conversationId,
        reply: existingReply.content,
        userMessageId: userMessage.id,
        assistantMessageId: existingReply.id
      }
    }

    this.onUpdated(conversationId, 'message')
    return this.completeReply(conversationId, userMessage)
  }

  async retry(conversationId: string, userMessageId: string): Promise<ChatResponse> {
    this.assertWritable()
    const userMessage = this.messages.get(userMessageId)
    if (
      !userMessage ||
      userMessage.role !== 'user' ||
      userMessage.conversationId !== conversationId
    ) {
      throw new Error('找不到需要重试的用户消息。')
    }
    const existingReply = this.messages.getReplyTo(userMessageId)
    if (existingReply) {
      return {
        conversationId,
        reply: existingReply.content,
        userMessageId,
        assistantMessageId: existingReply.id
      }
    }
    this.messages.markPending(userMessageId)
    this.onUpdated(conversationId, 'message')
    return this.completeReply(conversationId, userMessage)
  }

  async analyzeCorrections(
    conversationId: string,
    userMessageId: string,
    _content: string
  ): Promise<Correction[]> {
    this.assertMessageOwnership(conversationId, userMessageId, 'user')
    const context = this.correctionContexts.build(
      conversationId,
      userMessageId
    )
    this.analyses.start(
      conversationId,
      userMessageId,
      'correction',
      CORRECTION_PROMPT_VERSION
    )
    this.onUpdated(conversationId, 'analysis')
    try {
      const corrections = await this.llm.analyzeCorrections(
        context.targetText,
        context
      )
      this.analyses.saveCorrections(conversationId, userMessageId, corrections)
      this.onUpdated(conversationId, 'analysis')
      return corrections
    } catch (error) {
      this.analyses.fail(userMessageId, 'correction', error)
      this.onUpdated(conversationId, 'analysis')
      throw error
    }
  }

  async analyzeVocabulary(
    conversationId: string,
    assistantMessageId: string,
    content: string
  ): Promise<VocabularyInsight[]> {
    this.assertMessageOwnership(conversationId, assistantMessageId, 'assistant')
    this.analyses.start(conversationId, assistantMessageId, 'vocabulary', 1)
    this.onUpdated(conversationId, 'analysis')
    try {
      const rawVocabulary = await this.llm.analyzeVocabulary(content)
      const vocabulary = rawVocabulary
        .map((item) => this.enrichVocabulary(content, item))
        .sort((left, right) => (left.startOffset ?? 0) - (right.startOffset ?? 0))
      this.analyses.saveVocabulary(conversationId, assistantMessageId, vocabulary)
      this.onUpdated(conversationId, 'analysis')
      return vocabulary
    } catch (error) {
      this.analyses.fail(assistantMessageId, 'vocabulary', error)
      this.onUpdated(conversationId, 'analysis')
      throw error
    }
  }

  stopAcceptingWrites(): void {
    this.acceptingWrites = false
  }

  private async completeReply(
    conversationId: string,
    userMessage: Message
  ): Promise<ChatResponse> {
    try {
      await this.rebuildContextIfOutdated(conversationId)
      await this.compressContextIfNeeded(conversationId)
      const contextState = this.conversations.getContextState(conversationId)
      const contextMessages = this.messages.getAfterSequence(
        conversationId,
        contextState.throughSequence
      )
      const conversation = this.conversations.getSummary(conversationId)
      const mediaContexts = await this.mediaKnowledge?.contextsForReply(
        conversationId,
        userMessage.content,
        contextMessages
      ) || []
      const replyPromise = this.llm.chatReply(
        contextMessages,
        contextState.summary,
        conversation
          ? { mode: conversation.practiceMode, topic: conversation.topic }
          : undefined,
        mediaContexts
      )
      // Queue mention detection only after the primary chat request has started.
      // This prevents ModelScope's serialized analysis queue from delaying the reply.
      void this.mediaMentions?.detect(
        conversationId,
        userMessage,
        contextMessages
      ).catch((error) => {
        console.warn('[subtitle-mention] background detection failed:', error)
      })
      const reply = await replyPromise
      const assistantMessage = this.messages.insertAssistant(
        conversationId,
        reply,
        userMessage.id
      )
      this.onUpdated(conversationId, 'message')
      return {
        conversationId,
        reply,
        userMessageId: userMessage.id,
        assistantMessageId: assistantMessage.id
      }
    } catch (error) {
      this.messages.markFailed(userMessage.id)
      this.onUpdated(conversationId, 'message')
      throw error
    }
  }

  private async rebuildContextIfOutdated(conversationId: string): Promise<void> {
    const state = this.conversations.getContextState(conversationId)
    if (state.promptVersion === CONTEXT_PROMPT_VERSION) return
    const allMessages = this.messages.getAll(conversationId)
    let compressCount = Math.max(0, allMessages.length - RECENT_MESSAGES_AFTER_COMPRESSION)
    while (
      compressCount > 0 &&
      allMessages[compressCount - 1]?.role !== 'assistant'
    ) {
      compressCount -= 1
    }
    if (compressCount < 2) {
      this.conversations.replaceContextSummary(
        conversationId,
        '',
        0,
        CONTEXT_PROMPT_VERSION
      )
      return
    }
    const candidates = allMessages.slice(0, compressCount)
    let summary: string
    try {
      summary = await this.llm.summarizeContext('', candidates)
    } catch {
      summary = this.createFallbackContextSummary('', candidates)
    }
    this.conversations.replaceContextSummary(
      conversationId,
      summary,
      candidates[candidates.length - 1]?.sequence || 0,
      CONTEXT_PROMPT_VERSION
    )
  }

  private async compressContextIfNeeded(conversationId: string): Promise<void> {
    const state = this.conversations.getContextState(conversationId)
    const unsummarized = this.messages.getAfterSequence(
      conversationId,
      state.throughSequence
    )
    const estimatedTokens = this.estimateTokens(unsummarized)
    if (
      estimatedTokens <= CONTEXT_TOKEN_TRIGGER &&
      unsummarized.length <= CONTEXT_MESSAGE_TRIGGER
    ) {
      return
    }

    const keepCount =
      estimatedTokens > CONTEXT_TOKEN_TRIGGER
        ? RECENT_MESSAGES_FOR_LARGE_CONTEXT
        : RECENT_MESSAGES_AFTER_COMPRESSION
    let compressCount = unsummarized.length - keepCount
    while (
      compressCount > 0 &&
      unsummarized[compressCount - 1]?.role !== 'assistant'
    ) {
      compressCount -= 1
    }
    if (compressCount < 2) return
    const candidates = unsummarized.slice(0, compressCount)
    const throughSequence = candidates[candidates.length - 1]?.sequence || 0
    let summary: string
    try {
      summary = await this.llm.summarizeContext(state.summary, candidates)
    } catch {
      summary = this.createFallbackContextSummary(state.summary, candidates)
    }
    this.conversations.commitContextSummary(
      conversationId,
      summary,
      throughSequence,
      CONTEXT_PROMPT_VERSION
    )
  }

  private createFallbackContextSummary(previous: string, messages: Message[]): string {
    const compactPrevious =
      previous.length <= 2_200
        ? previous
        : `${previous.slice(0, 1_100)}\n...\n${previous.slice(-1_100)}`
    const prefix = compactPrevious
      ? `Previous retained memory:\n${compactPrevious}\n`
      : ''
    const transcript = messages
      .map((message) => {
        const compact = message.content.replace(/\s+/g, ' ').trim().slice(0, 600)
        return `${message.role === 'user' ? 'User said' : 'Assistant replied'}: ${compact}`
      })
      .join('\n')
    const availableLength = Math.max(1_500, 6_000 - prefix.length)
    return `[local fallback]\n${prefix}Older transcript notes:\n${transcript.slice(-availableLength)}`.trim()
  }

  private enrichVocabulary(
    content: string,
    item: VocabularyInsight
  ): VocabularyInsight {
    const startOffset = content.toLocaleLowerCase('en-US').indexOf(
      item.term.toLocaleLowerCase('en-US')
    )
    const safeStart = Math.max(0, startOffset)
    const endOffset = startOffset >= 0 ? startOffset + item.term.length : undefined
    return {
      ...item,
      normalizedTerm: normalizeEnglishTerm(item.term),
      sourceSentence: this.findSourceSentence(content, safeStart),
      startOffset: startOffset >= 0 ? startOffset : undefined,
      endOffset
    }
  }

  private findSourceSentence(content: string, offset: number): string {
    const sentenceStart = Math.max(
      content.lastIndexOf('.', Math.max(0, offset - 1)),
      content.lastIndexOf('!', Math.max(0, offset - 1)),
      content.lastIndexOf('?', Math.max(0, offset - 1))
    )
    const candidates = [
      content.indexOf('.', offset),
      content.indexOf('!', offset),
      content.indexOf('?', offset)
    ].filter((value) => value >= 0)
    const sentenceEnd = candidates.length > 0 ? Math.min(...candidates) + 1 : content.length
    return content.slice(sentenceStart + 1, sentenceEnd).trim() || content.trim()
  }

  private assertMessageOwnership(
    conversationId: string,
    messageId: string,
    role: Message['role']
  ): void {
    const message = this.messages.get(messageId)
    if (
      !message ||
      message.conversationId !== conversationId ||
      message.role !== role
    ) {
      throw new Error('分析目标消息不存在或不属于当前会话。')
    }
  }

  private createTitle(content: string): string {
    const oneLine = content.replace(/\s+/g, ' ').trim()
    const hasCjk = /[\u3400-\u9fff]/.test(oneLine)
    const limit = hasCjk ? 24 : 48
    return oneLine.length > limit ? `${oneLine.slice(0, limit).trim()}…` : oneLine
  }

  private estimateTokens(messages: Message[]): number {
    return messages.reduce((total, message) => {
      const cjkCount = (message.content.match(/[\u3400-\u9fff]/g) || []).length
      const otherCharacters = Math.max(0, message.content.length - cjkCount)
      return total + 6 + cjkCount + Math.ceil(otherCharacters / 4)
    }, 0)
  }

  private assertWritable(): void {
    if (!this.acceptingWrites) {
      throw new Error('应用正在退出，暂时不能写入新消息。')
    }
  }

  private withMedia(detail: ConversationDetail | null): ConversationDetail | null {
    return detail
  }
}
