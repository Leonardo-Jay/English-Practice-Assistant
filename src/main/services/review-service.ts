import type {
  ConversationReview,
  LearningReviewData,
  Message,
  ReviewDashboard,
  ReviewAgentResult,
  ReviewAnswerEvaluation,
  ReviewAttemptEvidence,
  ReviewGrade,
  ReviewGenerationResult
} from '../../shared/types'
import type { ConversationRepository } from '../database/repositories'
import { ReviewPracticeRepository, ReviewRepository } from '../database/repositories'
import type { LLMClient } from './llm-client'

const REVIEW_PROMPT_VERSION = 2
const CHUNK_CHARACTER_BUDGET = 12_000
const DIRECT_REVIEW_CHARACTER_BUDGET = 18_000

export class ReviewService {
  private readonly active = new Map<string, Promise<ReviewGenerationResult>>()

  constructor(
    private readonly conversations: ConversationRepository,
    private readonly reviews: ReviewRepository,
    private readonly practice: ReviewPracticeRepository,
    private readonly llm: LLMClient,
    private readonly onUpdated: (conversationId: string) => void
  ) {}

  get(conversationId: string): LearningReviewData {
    const conversation = this.conversations.getDetail(conversationId)
    if (!conversation) throw new Error('会话不存在或已删除。')
    return {
      conversation,
      review: this.reviews.getLatest(conversationId)
    }
  }

  generate(conversationId: string, force = false): Promise<ReviewGenerationResult> {
    const existingJob = this.active.get(conversationId)
    if (existingJob) return existingJob

    const data = this.get(conversationId)
    if (data.conversation.messages.length === 0) {
      throw new Error('空会话无法生成学习复习。')
    }
    if (
      !force &&
      data.review?.status === 'ready' &&
      !data.review.stale &&
      data.review.promptVersion === REVIEW_PROMPT_VERSION
    ) {
      return Promise.resolve({ conversationId, review: data.review })
    }

    const job = this.runGeneration(data)
    this.active.set(conversationId, job)
    void job.finally(() => this.active.delete(conversationId))
    return job
  }

  dashboard(limit?: number): ReviewDashboard {
    return this.practice.dashboard(limit)
  }

  async evaluateAnswer(itemId: string, response: string): Promise<ReviewAnswerEvaluation> {
    const item = this.practice.get(itemId)
    if (!item) throw new Error('复习项目不存在。')
    const answer = response.trim()
    if (!answer) throw new Error('请先输入或说出你的答案。')
    if (item.kind === 'vocabulary') return evaluateVocabularyLocally(item.answer, answer)
    try {
      return await this.llm.evaluateReviewAnswer(item, answer)
    } catch {
      return evaluateSentenceLocally(item.answer, answer)
    }
  }

  gradeItem(itemId: string, grade: ReviewGrade, evidence?: ReviewAttemptEvidence) {
    return this.practice.grade(itemId, grade, evidence)
  }

  listLibrary(filter: import('../../shared/types').ReviewLibraryFilter) {
    return this.practice.list(filter)
  }

  setItemMastered(itemId: string, mastered: boolean) {
    return this.practice.setMastered(itemId, mastered)
  }

  deleteItem(itemId: string): void {
    this.practice.delete(itemId)
  }

  private async runGeneration(data: LearningReviewData): Promise<ReviewGenerationResult> {
    const conversation = data.conversation
    try {
      const input = this.buildInput(conversation.messages)
      let result: ReviewAgentResult
      if (input.length <= DIRECT_REVIEW_CHARACTER_BUDGET) {
        result = await this.llm.generateLearningReview(input)
      } else {
        const chunks = this.chunkMessages(conversation.messages)
        const chunkNotes: ReviewAgentResult[] = []
        for (let index = 0; index < chunks.length; index += 1) {
          chunkNotes.push(
            await this.llm.generateLearningReview(
              `这是长会话的第 ${index + 1}/${chunks.length} 段。先生成结构化分段复习笔记。\n\n${this.buildInput(chunks[index])}`
            )
          )
        }
        result = await this.llm.generateLearningReview(
          `请将以下分段复习笔记合并成一份最终报告。只能保留笔记中已有的消息 ID 和纠错 ID。\n${JSON.stringify(chunkNotes)}`
        )
      }

      const validated = this.validateReferences(conversation.messages, result)
      const revisions = this.conversations.getRevisions(conversation.id)
      const review = this.reviews.save({
        conversationId: conversation.id,
        contentRevision: conversation.contentRevision,
        analysisRevision: conversation.analysisRevision,
        promptVersion: REVIEW_PROMPT_VERSION,
        status: 'ready',
        summary: validated.summary,
        topics: validated.topics,
        strengths: validated.strengths,
        priorities: validated.priorities,
        expressions: validated.expressions,
        selectedCorrections: validated.selectedCorrections
      })
      review.stale =
        revisions.contentRevision !== conversation.contentRevision ||
        revisions.analysisRevision !== conversation.analysisRevision
      this.onUpdated(conversation.id)
      return { conversationId: conversation.id, review }
    } catch (error) {
      const review = this.reviews.save({
        conversationId: conversation.id,
        contentRevision: conversation.contentRevision,
        analysisRevision: conversation.analysisRevision,
        promptVersion: REVIEW_PROMPT_VERSION,
        status: 'failed',
        summary: '',
        topics: [],
        strengths: [],
        priorities: [],
        expressions: [],
        selectedCorrections: [],
        error: error instanceof Error ? error.message : String(error)
      })
      this.onUpdated(conversation.id)
      return { conversationId: conversation.id, review }
    }
  }

  private buildInput(messages: Message[]): string {
    const transcript = messages
      .map(
        (message) =>
          `${message.role === 'user' ? 'USER' : 'ASSISTANT'}[${message.id}]: ${message.content}`
      )
      .join('\n')
    const corrections = messages
      .flatMap((message) =>
        (message.corrections || []).map((correction) => ({
          id: correction.id,
          sourceUserMessageId: message.id,
          original: correction.original,
          corrected: correction.corrected,
          type: correction.type,
          explanation: correction.explanation
        }))
      )
      .filter((correction) => correction.id)
    return `<transcript>\n${transcript}\n</transcript>\n<corrections>\n${JSON.stringify(corrections)}\n</corrections>`
  }

  private chunkMessages(messages: Message[]): Message[][] {
    const chunks: Message[][] = []
    let current: Message[] = []
    let length = 0
    for (const message of messages) {
      current.push(message)
      length += message.content.length + 80
      if (
        length >= CHUNK_CHARACTER_BUDGET &&
        message.role === 'assistant'
      ) {
        chunks.push(current)
        current = []
        length = 0
      }
    }
    if (current.length > 0) chunks.push(current)
    return chunks
  }

  private validateReferences(
    messages: Message[],
    result: ReviewAgentResult
  ): ReviewAgentResult {
    const users = new Map(
      messages
        .filter((message) => message.role === 'user')
        .map((message) => [message.id, message])
    )
    const correctionIds = new Set(
      messages.flatMap((message) =>
        (message.corrections || [])
          .map((correction) => correction.id)
          .filter((id): id is string => Boolean(id))
      )
    )
    const expressionKeys = new Set<string>()
    const expressions = result.expressions.filter((item) => {
      const source = users.get(item.sourceUserMessageId)
      if (
        !source ||
        !source.content
          .toLocaleLowerCase('en-US')
          .includes(item.original.toLocaleLowerCase('en-US'))
      ) {
        return false
      }
      const key = [
        item.sourceUserMessageId,
        item.original.toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim(),
        item.improved.toLocaleLowerCase('en-US').replace(/\s+/g, ' ').trim()
      ].join('|')
      if (expressionKeys.has(key)) return false
      expressionKeys.add(key)
      return true
    })
    const selectionIds = new Set<string>()
    const selectedCorrections = result.selectedCorrections.filter((item) => {
      if (
        !correctionIds.has(item.correctionId) ||
        selectionIds.has(item.correctionId)
      ) {
        return false
      }
      selectionIds.add(item.correctionId)
      return true
    })
    return {
      ...result,
      expressions,
      selectedCorrections
    }
  }
}

function normalizeReviewAnswer(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase('en-US')
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function evaluateVocabularyLocally(reference: string, response: string): ReviewAnswerEvaluation {
  const expected = normalizeReviewAnswer(reference)
  const actual = normalizeReviewAnswer(response)
  const matched = actual === expected || actual.split(' ').includes(expected) ||
    (expected.includes(' ') && actual.includes(expected))
  return matched
    ? { level: 'strong', score: 100, feedback: '目标词或短语回答正确。', strengths: ['成功主动回忆出目标表达'], improvements: [], suggestedGrade: 'good' }
    : { level: 'retry', score: 20, feedback: '这次回答还没有包含目标词或短语，可以根据原句再试一次。', strengths: [], improvements: ['重新观察中文提示或原句中的词义位置'], suggestedGrade: 'again' }
}

function evaluateSentenceLocally(reference: string, response: string): ReviewAnswerEvaluation {
  const expected = new Set(normalizeReviewAnswer(reference).split(' ').filter(Boolean))
  const actual = new Set(normalizeReviewAnswer(response).split(' ').filter(Boolean))
  const shared = [...actual].filter((token) => expected.has(token)).length
  const precision = actual.size ? shared / actual.size : 0
  const recall = expected.size ? shared / expected.size : 0
  const score = Math.round((precision + recall ? 2 * precision * recall / (precision + recall) : 0) * 100)
  if (score >= 78) return { level: 'strong', score, feedback: '表达与目标结构高度接近，意思清楚。当前为离线对比结果。', strengths: ['完整提交了自己的表达'], improvements: [], suggestedGrade: 'good' }
  if (score >= 45) return { level: 'close', score, feedback: '主要意思接近，但部分结构仍可调整。当前为离线对比结果。', strengths: ['已经覆盖部分关键意思'], improvements: ['对照参考表达检查缺少的核心结构'], suggestedGrade: 'hard' }
  return { level: 'retry', score, feedback: '当前表达与目标意思差距较大，建议根据任务背景重新组织。大模型评估不可用，本次使用离线结构对比。', strengths: ['已经实际作答'], improvements: ['先保证主语、动作和对象完整，再调整自然度'], suggestedGrade: 'again' }
}
