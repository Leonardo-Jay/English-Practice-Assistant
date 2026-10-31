import type Database from 'better-sqlite3'
import type {
  MediaIdentity,
  MediaMentionSuggestion,
  Message
} from '../../shared/types'
import {
  MediaMentionRepository,
  MediaRepository
} from '../database/subtitle-repositories'
import type { LLMClient } from '../services/llm-client'
import { normalizeMediaTitle } from './search-planner'

export class MediaMentionService {
  private readonly media: MediaRepository
  private readonly mentions: MediaMentionRepository

  constructor(
    db: Database.Database,
    private readonly llm: LLMClient,
    private readonly onDetected: (suggestion: MediaMentionSuggestion) => void
  ) {
    this.media = new MediaRepository(db)
    this.mentions = new MediaMentionRepository(db, this.media)
  }

  list(conversationId: string): MediaMentionSuggestion[] {
    return this.mentions.list(conversationId)
  }

  dismiss(mentionId: string): void {
    this.mentions.setStatus(mentionId, 'dismissed')
  }

  accept(mentionId: string): void {
    this.mentions.setStatus(mentionId, 'accepted')
  }

  async detect(
    conversationId: string,
    message: Message,
    recentMessages: Message[] = []
  ): Promise<MediaMentionSuggestion | undefined> {
    const evidenceMessages = [
      ...recentMessages.filter((item) => item.role === 'user').slice(-6),
      message
    ]
    const detected = await this.llm.detectMediaMention(
      message.content,
      evidenceMessages
    )
    if (
      !detected.mediaType ||
      !detected.title ||
      !detected.evidenceText ||
      detected.confidence < 0.72 ||
      !evidenceMessages.some((item) =>
        containsExactEvidence(item.content, detected.evidenceText!)
      )
    ) {
      return undefined
    }
    const media: MediaIdentity = {
      type: detected.mediaType,
      title: detected.title,
      normalizedTitle: normalizeMediaTitle(detected.title),
      aliases: [...new Set([
        detected.evidenceText,
        ...detected.aliases
      ].filter(Boolean))],
      year: detected.year,
      confirmed: true
    }
    const suggestion = this.mentions.save({
      conversationId,
      messageId: message.id,
      media,
      season: detected.season,
      episode: detected.episode,
      evidenceText: detected.evidenceText,
      confidence: detected.confidence
    })
    if (suggestion.status === 'pending') {
      this.onDetected(suggestion)
    }
    return suggestion
  }
}

const containsExactEvidence = (content: string, evidence: string) =>
  content.toLocaleLowerCase().includes(evidence.toLocaleLowerCase())
