import type Database from 'better-sqlite3'
import { randomUUID } from 'crypto'
import type {
  AnalysisStatus,
  ConversationDetail,
  ConversationMessagePage,
  ConversationPage,
  ConversationReview,
  ConversationSummary,
  Correction,
  InputMode,
  Message,
  PracticeMode,
  ReviewCorrectionSelection,
  ReviewExpression,
  ReviewDashboard,
  ReviewGrade,
  ReviewAttemptEvidence,
  ReviewItem,
  ReviewItemKind,
  ReviewLibraryFilter,
  VocabularyInsight
} from '../../shared/types'

type Sqlite = Database.Database
type Row = Record<string, unknown>

const numberValue = (value: unknown): number => Number(value || 0)
const stringValue = (value: unknown): string => String(value ?? '')
const optionalString = (value: unknown): string | undefined =>
  value === null || value === undefined || value === '' ? undefined : String(value)

function safeStringArray(value: unknown): string[] {
  try {
    const parsed = JSON.parse(stringValue(value))
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
  } catch {
    return []
  }
}

function mapConversation(row: Row): ConversationSummary {
  return {
    id: stringValue(row.id),
    title: stringValue(row.title),
    practiceMode: stringValue(row.practice_mode) as PracticeMode,
    topic: optionalString(row.topic),
    preview: stringValue(row.preview),
    messageCount: numberValue(row.message_count),
    contentRevision: numberValue(row.content_revision),
    analysisRevision: numberValue(row.analysis_revision),
    createdAt: numberValue(row.created_at),
    updatedAt: numberValue(row.updated_at),
    lastOpenedAt: numberValue(row.last_opened_at)
  }
}

export class ConversationRepository {
  constructor(private readonly db: Sqlite) {}

  create(
    id: string,
    title: string,
    mode: PracticeMode = 'free',
    topic?: string
  ): ConversationSummary {
    const now = Date.now()
    this.db.prepare(`
      INSERT INTO conversations(
        id, title, practice_mode, topic, created_at, updated_at, last_opened_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, title, mode, topic || null, now, now, now)
    return this.getSummary(id)!
  }

  list(cursor = 0, limit = 40, query = ''): ConversationPage {
    const safeLimit = Math.max(1, Math.min(limit, 100))
    const safeCursor = Math.max(0, cursor)
    const normalizedQuery = query.trim()
    const rows = this.db.prepare(`
      SELECT c.*,
        COALESCE((SELECT content FROM messages m
          WHERE m.conversation_id = c.id ORDER BY m.sequence DESC LIMIT 1), '') AS preview,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
      FROM conversations c
      WHERE c.status = 'active'
        AND (
          ? = '' OR c.title LIKE '%' || ? || '%'
          OR EXISTS (
            SELECT 1 FROM messages search_messages
            WHERE search_messages.conversation_id = c.id
              AND search_messages.content LIKE '%' || ? || '%'
          )
        )
      ORDER BY c.updated_at DESC
      LIMIT ? OFFSET ?
    `).all(
      normalizedQuery,
      normalizedQuery,
      normalizedQuery,
      safeLimit + 1,
      safeCursor
    ) as Row[]
    const hasMore = rows.length > safeLimit
    return {
      items: rows.slice(0, safeLimit).map(mapConversation),
      nextCursor: hasMore ? safeCursor + safeLimit : undefined
    }
  }

  getSummary(id: string): ConversationSummary | null {
    const row = this.db.prepare(`
      SELECT c.*,
        COALESCE((SELECT content FROM messages m
          WHERE m.conversation_id = c.id ORDER BY m.sequence DESC LIMIT 1), '') AS preview,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
      FROM conversations c
      WHERE c.id = ? AND c.status = 'active'
    `).get(id) as Row | undefined
    return row ? mapConversation(row) : null
  }

  getDetail(id: string, messageLimit?: number): ConversationDetail | null {
    const summary = this.getSummary(id)
    if (!summary) return null
    const conversation = this.db.prepare(
      'SELECT context_summary, summary_through_sequence, context_prompt_version FROM conversations WHERE id = ?'
    ).get(id) as Row
    const safeLimit = messageLimit === undefined
      ? undefined
      : Math.max(1, Math.min(messageLimit, 200))
    const messageRows = safeLimit === undefined
      ? this.db.prepare(
          'SELECT * FROM messages WHERE conversation_id = ? ORDER BY sequence'
        ).all(id) as Row[]
      : this.db.prepare(`
          SELECT * FROM (
            SELECT * FROM messages
            WHERE conversation_id = ?
            ORDER BY sequence DESC
            LIMIT ?
          ) ORDER BY sequence ASC
        `).all(id, safeLimit) as Row[]

    const messages = messageRows.map((row) => this.mapMessage(row))
    const earliestSequence = messages[0]?.sequence
    const hasEarlierMessages = earliestSequence !== undefined && Boolean(
      this.db.prepare(
        'SELECT 1 FROM messages WHERE conversation_id = ? AND sequence < ? LIMIT 1'
      ).get(id, earliestSequence)
    )
    if (messages.length > 0) {
      const byId = new Map(messages.map((message) => [message.id, message]))
      const corrections = this.db.prepare(`
        SELECT c.* FROM corrections c
        JOIN messages m ON m.id = c.user_message_id
        WHERE m.conversation_id = ?
        ORDER BY m.sequence, c.ordinal
      `).all(id) as Row[]
      for (const row of corrections) {
        const message = byId.get(stringValue(row.user_message_id))
        if (!message) continue
        message.corrections ||= []
        message.corrections.push(this.mapCorrection(row))
      }

      const vocabulary = this.db.prepare(`
        SELECT v.* FROM vocabulary_occurrences v
        JOIN messages m ON m.id = v.assistant_message_id
        WHERE m.conversation_id = ?
        ORDER BY m.sequence, v.ordinal
      `).all(id) as Row[]
      for (const row of vocabulary) {
        const message = byId.get(stringValue(row.assistant_message_id))
        if (!message) continue
        message.vocabulary ||= []
        message.vocabulary.push(this.mapVocabulary(row))
      }

      const analyses = this.db.prepare(
        'SELECT message_id, kind, status FROM message_analyses WHERE conversation_id = ?'
      ).all(id) as Row[]
      for (const row of analyses) {
        const message = byId.get(stringValue(row.message_id))
        if (!message) continue
        if (row.kind === 'correction') {
          message.correctionStatus = row.status as AnalysisStatus
        } else if (row.kind === 'vocabulary') {
          message.vocabularyStatus = row.status as AnalysisStatus
        }
      }
    }

    return {
      ...summary,
      messages,
      hasEarlierMessages,
      contextSummary: stringValue(conversation.context_summary),
      summaryThroughSequence: numberValue(conversation.summary_through_sequence),
      contextPromptVersion: numberValue(conversation.context_prompt_version)
    }
  }

  getMessagePage(
    conversationId: string,
    beforeSequence?: number,
    limit = 80
  ): ConversationMessagePage {
    const safeLimit = Math.max(1, Math.min(limit, 200))
    const boundary = Number.isFinite(beforeSequence) ? Number(beforeSequence) : Number.MAX_SAFE_INTEGER
    const rows = this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM messages
        WHERE conversation_id = ? AND sequence < ?
        ORDER BY sequence DESC
        LIMIT ?
      ) ORDER BY sequence ASC
    `).all(conversationId, boundary, safeLimit) as Row[]
    const messages = rows.map((row) => this.mapMessage(row))
    const earliestSequence = messages[0]?.sequence
    const hasEarlierMessages = earliestSequence !== undefined && Boolean(
      this.db.prepare(
        'SELECT 1 FROM messages WHERE conversation_id = ? AND sequence < ? LIMIT 1'
      ).get(conversationId, earliestSequence)
    )
    if (messages.length > 0) {
      const byId = new Map(messages.map((message) => [message.id, message]))
      const corrections = this.db.prepare(`
        SELECT c.* FROM corrections c
        JOIN messages m ON m.id = c.user_message_id
        WHERE m.conversation_id = ? AND m.sequence < ? AND m.sequence >= ?
        ORDER BY m.sequence, c.ordinal
      `).all(
        conversationId,
        (messages[messages.length - 1].sequence || 0) + 1,
        earliestSequence
      ) as Row[]
      for (const row of corrections) {
        const message = byId.get(stringValue(row.user_message_id))
        if (!message) continue
        message.corrections ||= []
        message.corrections.push(this.mapCorrection(row))
      }
      const vocabulary = this.db.prepare(`
        SELECT v.* FROM vocabulary_occurrences v
        JOIN messages m ON m.id = v.assistant_message_id
        WHERE m.conversation_id = ? AND m.sequence < ? AND m.sequence >= ?
        ORDER BY m.sequence, v.ordinal
      `).all(
        conversationId,
        (messages[messages.length - 1].sequence || 0) + 1,
        earliestSequence
      ) as Row[]
      for (const row of vocabulary) {
        const message = byId.get(stringValue(row.assistant_message_id))
        if (!message) continue
        message.vocabulary ||= []
        message.vocabulary.push(this.mapVocabulary(row))
      }
      const analyses = this.db.prepare(`
        SELECT ma.message_id, ma.kind, ma.status
        FROM message_analyses ma
        JOIN messages m ON m.id = ma.message_id
        WHERE ma.conversation_id = ? AND m.sequence < ? AND m.sequence >= ?
      `).all(
        conversationId,
        (messages[messages.length - 1].sequence || 0) + 1,
        earliestSequence
      ) as Row[]
      for (const row of analyses) {
        const message = byId.get(stringValue(row.message_id))
        if (!message) continue
        if (row.kind === 'correction') message.correctionStatus = row.status as AnalysisStatus
        if (row.kind === 'vocabulary') message.vocabularyStatus = row.status as AnalysisStatus
      }
    }
    return { messages, hasEarlierMessages }
  }

  rename(id: string, title: string): void {
    const normalized = title.replace(/\s+/g, ' ').trim().slice(0, 80)
    if (!normalized) throw new Error('会话标题不能为空。')
    this.db.prepare(
      'UPDATE conversations SET title = ?, updated_at = ? WHERE id = ? AND status = ?'
    ).run(normalized, Date.now(), id, 'active')
  }

  softDelete(id: string): void {
    this.db.prepare(
      'UPDATE conversations SET status = ?, updated_at = ? WHERE id = ?'
    ).run('deleted', Date.now(), id)
  }

  listDeleted(limit = 50): ConversationSummary[] {
    const safeLimit = Math.max(1, Math.min(limit, 200))
    const rows = this.db.prepare(`
      SELECT c.*,
        COALESCE((SELECT content FROM messages m
          WHERE m.conversation_id = c.id ORDER BY m.sequence DESC LIMIT 1), '') AS preview,
        (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id) AS message_count
      FROM conversations c
      WHERE c.status = 'deleted'
      ORDER BY c.updated_at DESC
      LIMIT ?
    `).all(safeLimit) as Row[]
    return rows.map(mapConversation)
  }

  restore(id: string): void {
    const result = this.db.prepare(
      'UPDATE conversations SET status = ?, updated_at = ? WHERE id = ? AND status = ?'
    ).run('active', Date.now(), id, 'deleted')
    if (result.changes === 0) throw new Error('会话不存在或无法恢复。')
  }

  purge(id: string): void {
    const result = this.db.prepare(
      'DELETE FROM conversations WHERE id = ? AND status = ?'
    ).run(id, 'deleted')
    if (result.changes === 0) throw new Error('会话不存在或尚未移入回收站。')
  }

  touchOpened(id: string): void {
    this.db.prepare(
      'UPDATE conversations SET last_opened_at = ? WHERE id = ? AND status = ?'
    ).run(Date.now(), id, 'active')
  }

  setMode(id: string, mode: PracticeMode, topic?: string): void {
    this.db.prepare(
      'UPDATE conversations SET practice_mode = ?, topic = ?, updated_at = ? WHERE id = ?'
    ).run(mode, topic || null, Date.now(), id)
  }

  getMostRecentId(): string | null {
    const row = this.db.prepare(
      "SELECT id FROM conversations WHERE status = 'active' ORDER BY updated_at DESC LIMIT 1"
    ).get() as Row | undefined
    return row ? stringValue(row.id) : null
  }

  getContextState(id: string): {
    summary: string
    throughSequence: number
    promptVersion: number
  } {
    const row = this.db.prepare(`
      SELECT context_summary, summary_through_sequence, context_prompt_version
      FROM conversations WHERE id = ? AND status = 'active'
    `).get(id) as Row | undefined
    if (!row) throw new Error('会话不存在或已删除。')
    return {
      summary: stringValue(row.context_summary),
      throughSequence: numberValue(row.summary_through_sequence),
      promptVersion: numberValue(row.context_prompt_version)
    }
  }

  commitContextSummary(
    id: string,
    summary: string,
    throughSequence: number,
    promptVersion: number
  ): void {
    this.db.prepare(`
      UPDATE conversations
      SET context_summary = ?, summary_through_sequence = ?, context_prompt_version = ?
      WHERE id = ? AND summary_through_sequence < ?
    `).run(summary, throughSequence, promptVersion, id, throughSequence)
  }

  replaceContextSummary(
    id: string,
    summary: string,
    throughSequence: number,
    promptVersion: number
  ): void {
    this.db.prepare(`
      UPDATE conversations
      SET context_summary = ?, summary_through_sequence = ?, context_prompt_version = ?
      WHERE id = ?
    `).run(summary, throughSequence, promptVersion, id)
  }

  getRevisions(id: string): { contentRevision: number; analysisRevision: number } {
    const row = this.db.prepare(
      'SELECT content_revision, analysis_revision FROM conversations WHERE id = ?'
    ).get(id) as Row | undefined
    if (!row) throw new Error('会话不存在。')
    return {
      contentRevision: numberValue(row.content_revision),
      analysisRevision: numberValue(row.analysis_revision)
    }
  }

  incrementAnalysisRevision(id: string): void {
    this.db.prepare(`
      UPDATE conversations
      SET analysis_revision = analysis_revision + 1, updated_at = ?
      WHERE id = ?
    `).run(Date.now(), id)
  }

  private mapMessage(row: Row): Message {
    return {
      id: stringValue(row.id),
      conversationId: stringValue(row.conversation_id),
      sequence: numberValue(row.sequence),
      role: stringValue(row.role) as Message['role'],
      content: stringValue(row.content),
      timestamp: numberValue(row.created_at),
      inputMode: stringValue(row.input_mode) as InputMode,
      replyToMessageId: optionalString(row.reply_to_message_id),
      status: stringValue(row.status) as Message['status']
    }
  }

  private mapCorrection(row: Row): Correction {
    const scope = row.scope === 'sentence' ? 'sentence' : 'span'
    return {
      id: stringValue(row.id),
      original: stringValue(row.original),
      corrected: stringValue(row.corrected),
      type: stringValue(row.type) as Correction['type'],
      scope,
      sentenceIndex:
        row.sentence_index === null || row.sentence_index === undefined
          ? undefined
          : numberValue(row.sentence_index),
      explanation: stringValue(row.explanation_zh),
      learningValue:
        row.learning_value === null || row.learning_value === undefined
          ? undefined
          : numberValue(row.learning_value)
    }
  }

  private mapVocabulary(row: Row): VocabularyInsight {
    return {
      id: stringValue(row.id),
      term: stringValue(row.term),
      normalizedTerm: stringValue(row.normalized_term),
      partOfSpeech: stringValue(row.part_of_speech_zh),
      chineseMeaning: stringValue(row.chinese_meaning),
      sourceSentence: stringValue(row.source_sentence),
      startOffset: row.start_offset === null ? undefined : numberValue(row.start_offset),
      endOffset: row.end_offset === null ? undefined : numberValue(row.end_offset),
      dictionaryEntryKey: optionalString(row.dictionary_entry_key),
      dictionaryEdition: optionalString(row.dictionary_edition)
    }
  }
}

export class MessageRepository {
  constructor(private readonly db: Sqlite) {}

  findByClientRequest(
    conversationId: string,
    clientRequestId: string
  ): Message | null {
    const row = this.db.prepare(`
      SELECT * FROM messages
      WHERE conversation_id = ? AND client_request_id = ?
    `).get(conversationId, clientRequestId) as Row | undefined
    return row ? this.map(row) : null
  }

  insertUser(
    conversationId: string,
    clientRequestId: string,
    content: string,
    inputMode: InputMode
  ): Message {
    const existing = this.findByClientRequest(conversationId, clientRequestId)
    if (existing) return existing
    const message = this.insert(
      conversationId,
      'user',
      content,
      inputMode,
      undefined,
      clientRequestId,
      'pending'
    )
    this.touchConversation(conversationId)
    return message
  }

  insertAssistant(
    conversationId: string,
    content: string,
    replyToMessageId: string
  ): Message {
    const message = this.insert(
      conversationId,
      'assistant',
      content,
      'text',
      replyToMessageId,
      undefined,
      'complete'
    )
    this.db.prepare(
      "UPDATE messages SET status = 'complete' WHERE id = ?"
    ).run(replyToMessageId)
    this.touchConversation(conversationId)
    return message
  }

  markFailed(messageId: string): void {
    this.db.prepare("UPDATE messages SET status = 'failed' WHERE id = ?").run(messageId)
  }

  markPending(messageId: string): void {
    this.db.prepare("UPDATE messages SET status = 'pending' WHERE id = ?").run(messageId)
  }

  get(messageId: string): Message | null {
    const row = this.db.prepare('SELECT * FROM messages WHERE id = ?').get(messageId) as
      | Row
      | undefined
    return row ? this.map(row) : null
  }

  getReplyTo(messageId: string): Message | null {
    const row = this.db.prepare(
      "SELECT * FROM messages WHERE reply_to_message_id = ? AND role = 'assistant' ORDER BY sequence LIMIT 1"
    ).get(messageId) as Row | undefined
    return row ? this.map(row) : null
  }

  getAfterSequence(conversationId: string, sequence: number): Message[] {
    return (this.db.prepare(`
      SELECT * FROM messages
      WHERE conversation_id = ? AND sequence > ?
      ORDER BY sequence
    `).all(conversationId, sequence) as Row[]).map((row) => this.map(row))
  }

  getBeforeSequence(
    conversationId: string,
    sequence: number,
    limit = 6
  ): Message[] {
    const safeLimit = Math.max(1, Math.min(limit, 20))
    return (this.db.prepare(`
      SELECT * FROM (
        SELECT * FROM messages
        WHERE conversation_id = ?
          AND sequence < ?
          AND status = 'complete'
        ORDER BY sequence DESC
        LIMIT ?
      )
      ORDER BY sequence
    `).all(conversationId, sequence, safeLimit) as Row[]).map((row) =>
      this.map(row)
    )
  }

  getAll(conversationId: string): Message[] {
    return this.getAfterSequence(conversationId, 0)
  }

  private insert(
    conversationId: string,
    role: Message['role'],
    content: string,
    inputMode: InputMode,
    replyToMessageId?: string,
    clientRequestId?: string,
    status: Message['status'] = 'complete'
  ): Message {
    const sequenceRow = this.db.prepare(
      'SELECT COALESCE(MAX(sequence), 0) + 1 AS next_sequence FROM messages WHERE conversation_id = ?'
    ).get(conversationId) as Row
    const id = randomUUID()
    const sequence = numberValue(sequenceRow.next_sequence)
    const createdAt = Date.now()
    this.db.prepare(`
      INSERT INTO messages(
        id, conversation_id, sequence, role, content, input_mode,
        reply_to_message_id, client_request_id, status, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      conversationId,
      sequence,
      role,
      content,
      inputMode,
      replyToMessageId || null,
      clientRequestId || null,
      status,
      createdAt
    )
    return {
      id,
      conversationId,
      sequence,
      role,
      content,
      inputMode,
      replyToMessageId,
      status,
      timestamp: createdAt
    }
  }

  private touchConversation(conversationId: string): void {
    this.db.prepare(`
      UPDATE conversations
      SET content_revision = content_revision + 1, updated_at = ?
      WHERE id = ?
    `).run(Date.now(), conversationId)
  }

  private map(row: Row): Message {
    return {
      id: stringValue(row.id),
      conversationId: stringValue(row.conversation_id),
      sequence: numberValue(row.sequence),
      role: stringValue(row.role) as Message['role'],
      content: stringValue(row.content),
      timestamp: numberValue(row.created_at),
      inputMode: stringValue(row.input_mode) as InputMode,
      replyToMessageId: optionalString(row.reply_to_message_id),
      status: stringValue(row.status) as Message['status']
    }
  }
}

export class AnalysisRepository {
  constructor(
    private readonly db: Sqlite,
    private readonly conversations: ConversationRepository
  ) {}

  start(
    conversationId: string,
    messageId: string,
    kind: 'correction' | 'vocabulary',
    promptVersion: number
  ): void {
    this.db.prepare(`
      INSERT INTO message_analyses(
        id, conversation_id, message_id, kind, status, prompt_version,
        attempt_count, updated_at
      ) VALUES (?, ?, ?, ?, 'pending', ?, 1, ?)
      ON CONFLICT(message_id, kind) DO UPDATE SET
        status = 'pending',
        prompt_version = excluded.prompt_version,
        attempt_count = message_analyses.attempt_count + 1,
        error_detail = NULL,
        updated_at = excluded.updated_at
    `).run(randomUUID(), conversationId, messageId, kind, promptVersion, Date.now())
  }

  saveCorrections(
    conversationId: string,
    messageId: string,
    corrections: Correction[]
  ): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare('DELETE FROM corrections WHERE user_message_id = ?').run(messageId)
      const insert = this.db.prepare(`
        INSERT INTO corrections(
          id, user_message_id, ordinal, type, original, corrected,
          explanation_zh, learning_value, scope, sentence_index
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      corrections.forEach((item, index) => {
        insert.run(
          randomUUID(),
          messageId,
          index,
          item.type,
          item.original,
          item.corrected,
          item.explanation,
          item.learningValue ?? null,
          item.scope === 'sentence' ? 'sentence' : 'span',
          item.sentenceIndex ?? null
        )
      })
      this.completeJob(messageId, 'correction')
      this.conversations.incrementAnalysisRevision(conversationId)
    })
    transaction()
  }

  saveVocabulary(
    conversationId: string,
    messageId: string,
    vocabulary: VocabularyInsight[]
  ): void {
    const transaction = this.db.transaction(() => {
      this.db.prepare(
        'DELETE FROM vocabulary_occurrences WHERE assistant_message_id = ?'
      ).run(messageId)
      const insert = this.db.prepare(`
        INSERT INTO vocabulary_occurrences(
          id, assistant_message_id, ordinal, term, normalized_term,
          part_of_speech_zh, chinese_meaning, source_sentence,
          start_offset, end_offset, dictionary_entry_key, dictionary_edition
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      vocabulary.forEach((item, index) => {
        insert.run(
          randomUUID(),
          messageId,
          index,
          item.term,
          item.normalizedTerm || normalizeEnglishTerm(item.term),
          item.partOfSpeech,
          item.chineseMeaning,
          item.sourceSentence || '',
          item.startOffset ?? null,
          item.endOffset ?? null,
          item.dictionaryEntryKey || null,
          item.dictionaryEdition || null
        )
      })
      this.completeJob(messageId, 'vocabulary')
      this.conversations.incrementAnalysisRevision(conversationId)
    })
    transaction()
  }

  fail(messageId: string, kind: 'correction' | 'vocabulary', error: unknown): void {
    this.db.prepare(`
      UPDATE message_analyses
      SET status = 'failed', error_detail = ?, updated_at = ?
      WHERE message_id = ? AND kind = ?
    `).run(error instanceof Error ? error.message : String(error), Date.now(), messageId, kind)
  }

  markInterruptedJobsRetryable(): void {
    this.db.prepare(`
      UPDATE message_analyses
      SET status = 'failed',
          error_detail = COALESCE(error_detail, '应用在分析完成前退出，可手动重试。'),
          updated_at = ?
      WHERE status = 'pending'
    `).run(Date.now())
  }

  private completeJob(messageId: string, kind: string): void {
    this.db.prepare(`
      UPDATE message_analyses
      SET status = 'complete', error_detail = NULL, updated_at = ?
      WHERE message_id = ? AND kind = ?
    `).run(Date.now(), messageId, kind)
  }
}

export interface StoredReviewInput {
  conversationId: string
  contentRevision: number
  analysisRevision: number
  promptVersion: number
  status: ConversationReview['status']
  summary: string
  topics: string[]
  strengths: string[]
  priorities: string[]
  expressions: Omit<ReviewExpression, 'id'>[]
  selectedCorrections: ReviewCorrectionSelection[]
  error?: string
}

export class ReviewRepository {
  constructor(
    private readonly db: Sqlite,
    private readonly conversations: ConversationRepository
  ) {}

  getLatest(conversationId: string): ConversationReview | undefined {
    const row = this.db.prepare(`
      SELECT * FROM conversation_reviews
      WHERE conversation_id = ?
      ORDER BY generated_at DESC
      LIMIT 1
    `).get(conversationId) as Row | undefined
    if (!row) return undefined
    const reviewId = stringValue(row.id)
    const expressions = (this.db.prepare(`
      SELECT * FROM review_expressions WHERE review_id = ? ORDER BY ordinal
    `).all(reviewId) as Row[]).map((item): ReviewExpression => ({
      id: stringValue(item.id),
      sourceUserMessageId: stringValue(item.source_user_message_id),
      original: stringValue(item.original),
      improved: stringValue(item.improved),
      explanation: stringValue(item.explanation_zh)
    }))
    const selectedCorrections = (this.db.prepare(`
      SELECT correction_id, reason_zh, corrected_meaning_zh
      FROM review_correction_selections
      WHERE review_id = ? ORDER BY ordinal
    `).all(reviewId) as Row[]).map((item): ReviewCorrectionSelection => ({
      correctionId: stringValue(item.correction_id),
      reason: stringValue(item.reason_zh),
      correctedMeaning: stringValue(item.corrected_meaning_zh)
    }))
    const revisions = this.conversations.getRevisions(conversationId)
    return {
      id: reviewId,
      conversationId,
      sourceContentRevision: numberValue(row.source_content_revision),
      sourceAnalysisRevision: numberValue(row.source_analysis_revision),
      promptVersion: numberValue(row.prompt_version),
      status: stringValue(row.status) as ConversationReview['status'],
      stale:
        revisions.contentRevision !== numberValue(row.source_content_revision) ||
        revisions.analysisRevision !== numberValue(row.source_analysis_revision),
      summary: stringValue(row.summary_zh),
      topics: safeStringArray(row.topics_json),
      strengths: safeStringArray(row.strengths_json),
      priorities: safeStringArray(row.priorities_json),
      expressions,
      selectedCorrections,
      error: optionalString(row.error_detail),
      generatedAt: numberValue(row.generated_at)
    }
  }

  save(input: StoredReviewInput): ConversationReview {
    const id = randomUUID()
    const generatedAt = Date.now()
    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO conversation_reviews(
          id, conversation_id, source_content_revision, source_analysis_revision,
          prompt_version, status, summary_zh, topics_json, strengths_json,
          priorities_json, error_detail, generated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        input.conversationId,
        input.contentRevision,
        input.analysisRevision,
        input.promptVersion,
        input.status,
        input.summary,
        JSON.stringify(input.topics),
        JSON.stringify(input.strengths),
        JSON.stringify(input.priorities),
        input.error || null,
        generatedAt
      )
      const insertExpression = this.db.prepare(`
        INSERT INTO review_expressions(
          id, review_id, source_user_message_id, ordinal, original, improved,
          explanation_zh
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      input.expressions.forEach((item, index) => {
        insertExpression.run(
          randomUUID(),
          id,
          item.sourceUserMessageId,
          index,
          item.original,
          item.improved,
          item.explanation
        )
      })
      const insertSelection = this.db.prepare(`
        INSERT INTO review_correction_selections(
          review_id, correction_id, ordinal, reason_zh, corrected_meaning_zh
        ) VALUES (?, ?, ?, ?, ?)
      `)
      input.selectedCorrections.forEach((item, index) => {
        insertSelection.run(
          id,
          item.correctionId,
          index,
          item.reason,
          item.correctedMeaning
        )
      })
    })
    transaction()
    return this.getLatest(input.conversationId)!
  }
}

export class ReviewPracticeRepository {
  constructor(private readonly db: Sqlite) {}

  syncFromLearningData(): void {
    const now = Date.now()
    const transaction = this.db.transaction(() => {
      // Version 6 created one card for every correction fragment. Those cards
      // had no reliable conversational meaning, so replace them with one
      // complete, context-rich card per user message.
      this.db.prepare(`
        DELETE FROM review_items
        WHERE source_key LIKE 'correction:%'
          AND source_key NOT LIKE 'correction-message:%'
      `).run()
      const excluded = new Set(
        (this.db.prepare('SELECT source_key FROM review_item_exclusions').all() as Row[])
          .map((row) => stringValue(row.source_key))
      )
      const insert = this.db.prepare(`
        INSERT INTO review_items(
          id, source_key, kind, conversation_id, source_message_id,
          prompt, answer, explanation_zh, meaning_zh, source_sentence,
          due_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_key) DO UPDATE SET
          conversation_id = excluded.conversation_id,
          source_message_id = excluded.source_message_id,
          prompt = excluded.prompt,
          answer = excluded.answer,
          explanation_zh = excluded.explanation_zh,
          meaning_zh = excluded.meaning_zh,
          source_sentence = excluded.source_sentence,
          updated_at = excluded.updated_at
      `)
      const corrections = this.db.prepare(`
        SELECT c.id, c.ordinal, c.scope, m.conversation_id, m.id AS message_id,
               m.content AS message_content, c.original, c.corrected, c.explanation_zh,
               (SELECT previous.content FROM messages previous
                WHERE previous.conversation_id = m.conversation_id
                  AND previous.role = 'assistant'
                  AND previous.sequence < m.sequence
                ORDER BY previous.sequence DESC LIMIT 1) AS assistant_context
        FROM corrections c JOIN messages m ON m.id = c.user_message_id
        JOIN conversations cv ON cv.id = m.conversation_id
        WHERE cv.status = 'active' AND TRIM(c.corrected) <> ''
        ORDER BY m.id, c.ordinal
      `).all() as Row[]
      const correctionsByMessage = new Map<string, Row[]>()
      for (const row of corrections) {
        const messageId = stringValue(row.message_id)
        const group = correctionsByMessage.get(messageId) || []
        group.push(row)
        correctionsByMessage.set(messageId, group)
      }
      for (const [messageId, group] of correctionsByMessage) {
        const sourceKey = `correction-message:${messageId}`
        if (excluded.has(sourceKey)) continue
        const originalSentence = stringValue(group[0].message_content).trim()
        const correctedSentence = rebuildCorrectedSentence(originalSentence, group)
        if (!originalSentence || !correctedSentence || sameEnglish(originalSentence, correctedSentence)) {
          continue
        }
        const assistantContext = optionalString(group[0].assistant_context)
        const ambiguousPronoun = /\b(?:she\s+he|he\s+she)\b/i.test(originalSentence)
        const explanations = [...new Set(group.map((row) => stringValue(row.explanation_zh).trim()).filter(Boolean))]
        const explanation = [
          ambiguousPronoun
            ? '这里的 he 或 she 要按你原本想说的人物选择；真正需要修正的是同一个分句里不能同时保留两个主语。'
            : '',
          ...explanations
        ].filter(Boolean).join('\n')
        insert.run(
          randomUUID(), sourceKey, 'correction', stringValue(group[0].conversation_id),
          messageId, buildCorrectionPrompt(messageId, originalSentence, assistantContext, ambiguousPronoun),
          correctedSentence, explanation,
          ambiguousPronoun ? '人称按原意选择；参考答案展示的是纠错时采用的一种有效表达。' : null,
          originalSentence, now, now, now
        )
      }

      const vocabulary = this.db.prepare(`
        SELECT v.normalized_term, v.term, v.part_of_speech_zh, v.chinese_meaning,
               v.source_sentence, m.conversation_id, m.id AS message_id
        FROM vocabulary_occurrences v
        JOIN messages m ON m.id = v.assistant_message_id
        JOIN conversations cv ON cv.id = m.conversation_id
        WHERE cv.status = 'active' AND TRIM(v.normalized_term) <> ''
        GROUP BY v.normalized_term
        ORDER BY MAX(m.created_at) DESC
      `).all() as Row[]
      for (const row of vocabulary) {
        const normalized = stringValue(row.normalized_term)
        const term = stringValue(row.term)
        const sourceKey = `vocabulary:${normalized}`
        if (excluded.has(sourceKey)) continue
        insert.run(
          randomUUID(), sourceKey, 'vocabulary', stringValue(row.conversation_id),
          stringValue(row.message_id), buildVocabularyPrompt(normalized, term, stringValue(row.chinese_meaning), stringValue(row.source_sentence)), term,
          stringValue(row.part_of_speech_zh), stringValue(row.chinese_meaning),
          stringValue(row.source_sentence), now, now, now
        )
      }

      const expressions = this.db.prepare(`
        SELECT e.id, e.source_user_message_id, e.original, e.improved, e.explanation_zh,
               m.conversation_id
        FROM review_expressions e
        JOIN messages m ON m.id = e.source_user_message_id
        JOIN conversations cv ON cv.id = m.conversation_id
        WHERE cv.status = 'active' AND TRIM(e.improved) <> ''
      `).all() as Row[]
      for (const row of expressions) {
        const sourceId = stringValue(row.id)
        const sourceKey = `expression:${sourceId}`
        if (excluded.has(sourceKey)) continue
        const original = stringValue(row.original)
        insert.run(
          randomUUID(), sourceKey, 'expression', stringValue(row.conversation_id),
          stringValue(row.source_user_message_id),
          buildExpressionPrompt(sourceId, original),
          stringValue(row.improved), stringValue(row.explanation_zh), null,
          original, now, now, now
        )
      }
    })
    transaction()
  }

  dashboard(limit = 20): ReviewDashboard {
    this.syncFromLearningData()
    const now = Date.now()
    const safeLimit = Math.max(1, Math.min(Math.floor(limit) || 20, 50))
    const items = (this.db.prepare(`
      SELECT * FROM (
        SELECT review_items.*,
               ROW_NUMBER() OVER (PARTITION BY kind ORDER BY due_at ASC, updated_at DESC) AS kind_rank
        FROM review_items
        WHERE status = 'learning' AND due_at <= ?
      )
      ORDER BY kind_rank ASC,
               CASE kind WHEN 'correction' THEN 1 WHEN 'vocabulary' THEN 2 ELSE 3 END
      LIMIT ?
    `).all(now, safeLimit) as Row[]).map(mapReviewItem)
    const countRow = this.db.prepare(`
      SELECT
        SUM(CASE WHEN status = 'learning' AND due_at <= ? THEN 1 ELSE 0 END) AS due_count,
        SUM(CASE WHEN status = 'learning' AND repetitions = 0 THEN 1 ELSE 0 END) AS new_count,
        SUM(CASE WHEN status = 'mastered' THEN 1 ELSE 0 END) AS mastered_count,
        COUNT(*) AS total_count
      FROM review_items
    `).get(now) as Row
    const startOfDay = new Date()
    startOfDay.setHours(0, 0, 0, 0)
    const todayRow = this.db.prepare(`
      SELECT COUNT(*) AS count FROM review_attempts WHERE reviewed_at >= ?
    `).get(startOfDay.getTime()) as Row
    const reviewedToday = numberValue(todayRow.count)
    return {
      dueCount: numberValue(countRow.due_count),
      newCount: numberValue(countRow.new_count),
      masteredCount: numberValue(countRow.mastered_count),
      totalCount: numberValue(countRow.total_count),
      reviewedToday,
      streakDays: this.streakDays(),
      estimatedMinutes: Math.max(1, Math.ceil(Math.min(items.length, numberValue(countRow.due_count) + numberValue(countRow.new_count)) / 4)),
      items
    }
  }

  list(filter: ReviewLibraryFilter = {}): ReviewItem[] {
    this.syncFromLearningData()
    const where = ['1 = 1']
    const parameters: unknown[] = []
    const status = filter.status || 'all'
    if (filter.kind && filter.kind !== 'all') {
      where.push('kind = ?')
      parameters.push(filter.kind)
    }
    if (status === 'due') {
      where.push("status = 'learning' AND due_at <= ?")
      parameters.push(Date.now())
    } else if (status === 'learning' || status === 'mastered') {
      where.push('status = ?')
      parameters.push(status)
    }
    if (filter.query?.trim()) {
      where.push('(prompt LIKE ? OR answer LIKE ? OR meaning_zh LIKE ? OR source_sentence LIKE ?)')
      const query = `%${filter.query.trim()}%`
      parameters.push(query, query, query, query)
    }
    parameters.push(Math.max(1, Math.min(Math.floor(filter.limit || 100), 300)))
    return (this.db.prepare(`
      SELECT * FROM review_items WHERE ${where.join(' AND ')}
      ORDER BY CASE WHEN due_at <= ${Date.now()} THEN 0 ELSE 1 END, due_at ASC, updated_at DESC
      LIMIT ?
    `).all(...parameters) as Row[]).map(mapReviewItem)
  }

  grade(itemId: string, grade: ReviewGrade, evidence?: ReviewAttemptEvidence): ReviewItem {
    const current = this.get(itemId)
    if (!current) throw new Error('复习项目不存在。')
    const now = Date.now()
    const next = nextSchedule(current, grade, now)
    this.db.transaction(() => {
      this.db.prepare(`
        UPDATE review_items SET due_at = ?, interval_days = ?, repetitions = ?, lapses = ?,
          last_grade = ?, status = 'learning', updated_at = ? WHERE id = ?
      `).run(next.dueAt, next.intervalDays, next.repetitions, next.lapses, grade, now, itemId)
      this.db.prepare(`
        INSERT INTO review_attempts(
          id, review_item_id, grade, reviewed_at, response_text, response_mode, evaluation_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(), itemId, grade, now, evidence?.response || null,
        evidence?.inputMode || null,
        evidence ? JSON.stringify(evidence.evaluation) : null
      )
    })()
    return this.get(itemId)!
  }

  setMastered(itemId: string, mastered: boolean): ReviewItem {
    const current = this.get(itemId)
    if (!current) throw new Error('复习项目不存在。')
    const now = Date.now()
    this.db.prepare(`
      UPDATE review_items SET status = ?, due_at = ?, updated_at = ? WHERE id = ?
    `).run(mastered ? 'mastered' : 'learning', mastered ? now + 60 * 24 * 60 * 60 * 1000 : now, now, itemId)
    return this.get(itemId)!
  }

  delete(itemId: string): void {
    const row = this.db.prepare('SELECT source_key FROM review_items WHERE id = ?').get(itemId) as Row | undefined
    if (!row) return
    this.db.transaction(() => {
      this.db.prepare(`
        INSERT OR REPLACE INTO review_item_exclusions(source_key, excluded_at) VALUES (?, ?)
      `).run(stringValue(row.source_key), Date.now())
      this.db.prepare('DELETE FROM review_items WHERE id = ?').run(itemId)
    })()
  }

  get(itemId: string): ReviewItem | undefined {
    const row = this.db.prepare('SELECT * FROM review_items WHERE id = ?').get(itemId) as Row | undefined
    return row ? mapReviewItem(row) : undefined
  }

  private streakDays(): number {
    const rows = this.db.prepare(`
      SELECT DISTINCT date(reviewed_at / 1000, 'unixepoch', 'localtime') AS day
      FROM review_attempts ORDER BY day DESC LIMIT 366
    `).all() as Row[]
    const days = new Set(rows.map((row) => stringValue(row.day)))
    let date = new Date()
    date.setHours(0, 0, 0, 0)
    if (!days.has(localDay(date))) date.setDate(date.getDate() - 1)
    let streak = 0
    while (days.has(localDay(date))) {
      streak += 1
      date.setDate(date.getDate() - 1)
    }
    return streak
  }
}

function rebuildCorrectedSentence(source: string, corrections: Row[]): string | undefined {
  const sentenceLevel = corrections
    .filter((row) => stringValue(row.scope) === 'sentence')
    .sort((left, right) => stringValue(right.original).length - stringValue(left.original).length)
  let result = source
  let changed = false
  for (const row of sentenceLevel) {
    const original = stringValue(row.original).trim()
    const corrected = stringValue(row.corrected).trim()
    if (!corrected) continue
    if (sameEnglish(original, result)) {
      result = corrected
      changed = true
      continue
    }
    const replaced = replaceEnglishOnce(result, original, corrected)
    if (replaced !== result) {
      result = replaced
      changed = true
    }
  }

  for (const row of corrections.filter((item) => stringValue(item.scope) !== 'sentence').sort(
    (left, right) => stringValue(right.original).length - stringValue(left.original).length
  )) {
    const original = stringValue(row.original).trim()
    const corrected = stringValue(row.corrected).trim()
    if (!original || !corrected) continue
    const next = replaceEnglishOnce(result, original, corrected)
    if (next !== result) {
      result = next
      changed = true
    }
  }
  return changed ? result : undefined
}

function replaceEnglishOnce(source: string, original: string, corrected: string): string {
  const directIndex = source.toLocaleLowerCase('en-US').indexOf(original.toLocaleLowerCase('en-US'))
  if (directIndex >= 0) {
    return `${source.slice(0, directIndex)}${corrected}${source.slice(directIndex + original.length)}`
  }
  const flexible = original
    .trim()
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('\\s+')
  if (!flexible) return source
  return source.replace(new RegExp(flexible, 'i'), corrected)
}

function sameEnglish(left: string, right: string): boolean {
  const normalize = (value: string) => value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/\s+/g, ' ')
    .trim()
  return normalize(left) === normalize(right)
}

export function buildCorrectionPrompt(
  seed: string,
  originalSentence: string,
  assistantContext?: string,
  ambiguousPronoun = false
): string {
  const context = assistantContext
    ? `\n对话背景：\n助手刚才说：\n“${normalizePromptText(assistantContext)}”`
    : ''
  const original = `\n你当时回答：\n“${normalizePromptText(originalSentence)}”`
  if (ambiguousPronoun) {
    return `主语选择挑战${context}${original}\n练习目标：he 或 she 按你想表达的人物任选其一，但只保留一个主语，再把整句话说清楚。`
  }
  const variants = [
    `情景重说${context}${original}\n如果重新回答一次，你会怎样用完整、自然的英语表达同一个意思？`,
    `口语修复站${context}${original}\n找出最影响理解的地方，然后完整重说这句话。`,
    `第二次机会${context}${original}\n保留原意，不逐词翻译，用更清楚的英语再说一次。`,
    `真实对话回放${context}${original}\n想象对话仍在继续，请给出一个更顺畅的完整回答。`
  ]
  return variants[stableVariant(seed, variants.length)]
}

function buildVocabularyPrompt(seed: string, term: string, meaning: string, sentence: string): string {
  const variants = [
    `中文到英文\n“${meaning}”在这次对话里对应哪个英语表达？`,
    sentence && sentence.toLocaleLowerCase('en-US').includes(term.toLocaleLowerCase('en-US'))
      ? `原句填空\n${replaceEnglishOnce(sentence, term, '______')}\n填入这次学到的关键词。`
      : `快速回忆\n看到中文“${meaning}”，说出对应的英语词或短语。`,
    `主动词汇挑战\n请回忆一个表示“${meaning}”的英语词或短语。答案来自你之前的真实对话。`
  ]
  return variants[stableVariant(seed, variants.length)]
}

function buildExpressionPrompt(seed: string, original: string): string {
  const variants = [
    `自然度升级\n你以前说过：“${compactText(original, 280)}”\n不用逐词修改，换一种更像自然口语的说法。`,
    `同义改写\n保留下面表达的意思，用更顺畅的英语重说：\n“${compactText(original, 280)}”`,
    `一句多说\n如果现在再表达一次，你会怎样改进这句话？\n“${compactText(original, 280)}”`
  ]
  return variants[stableVariant(seed, variants.length)]
}

function stableVariant(seed: string, count: number): number {
  let hash = 0
  for (const character of seed) hash = (hash * 31 + character.charCodeAt(0)) | 0
  return Math.abs(hash) % count
}

function compactText(value: string, limit: number): string {
  const compact = value.replace(/\s+/g, ' ').trim()
  return compact.length <= limit ? compact : `${compact.slice(0, limit - 1)}…`
}

function normalizePromptText(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/[\t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function mapReviewItem(row: Row): ReviewItem {
  return {
    id: stringValue(row.id), kind: stringValue(row.kind) as ReviewItemKind,
    conversationId: optionalString(row.conversation_id), sourceMessageId: optionalString(row.source_message_id),
    prompt: stringValue(row.prompt), answer: stringValue(row.answer),
    explanation: stringValue(row.explanation_zh), meaning: optionalString(row.meaning_zh),
    sourceSentence: optionalString(row.source_sentence), dueAt: numberValue(row.due_at),
    intervalDays: numberValue(row.interval_days), repetitions: numberValue(row.repetitions),
    lapses: numberValue(row.lapses), lastGrade: optionalString(row.last_grade) as ReviewGrade | undefined,
    status: stringValue(row.status) as ReviewItem['status'],
    createdAt: numberValue(row.created_at), updatedAt: numberValue(row.updated_at)
  }
}

function nextSchedule(item: ReviewItem, grade: ReviewGrade, now: number) {
  if (grade === 'again') return { dueAt: now + 10 * 60 * 1000, intervalDays: 0, repetitions: 0, lapses: item.lapses + 1 }
  const previous = Math.max(1, item.intervalDays)
  const intervalDays = grade === 'hard'
    ? Math.max(1, Math.ceil(previous * 1.2))
    : grade === 'easy'
      ? (item.repetitions === 0 ? 4 : Math.min(90, Math.ceil(previous * 2.5)))
      : item.repetitions === 0 ? 1 : item.repetitions === 1 ? 3 : item.repetitions === 2 ? 7 : Math.min(60, Math.ceil(previous * 2))
  return { dueAt: now + intervalDays * 24 * 60 * 60 * 1000, intervalDays, repetitions: item.repetitions + 1, lapses: item.lapses }
}

function localDay(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export class AppStateRepository {
  constructor(private readonly db: Sqlite) {}

  get(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM app_state WHERE key = ?').get(key) as
      | Row
      | undefined
    return row ? stringValue(row.value) : undefined
  }

  set(key: string, value: string): void {
    this.db.prepare(`
      INSERT INTO app_state(key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value
    `).run(key, value)
  }

  delete(key: string): void {
    this.db.prepare('DELETE FROM app_state WHERE key = ?').run(key)
  }
}

export const ENGLISH_NORMALIZATION_VERSION = 1

export function normalizeEnglishTerm(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[’']/g, "'")
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}
