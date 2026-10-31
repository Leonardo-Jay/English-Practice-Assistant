import type Database from 'better-sqlite3'
import type {
  ConversationMediaContext,
  GroundedMediaContext,
  MediaIdentity,
  MediaIntent,
  Message
} from '../../shared/types'
import {
  ConversationMediaRepository,
  MediaRepository
} from '../database/subtitle-repositories'
import type { LLMClient } from '../services/llm-client'
import { normalizeMediaTitle } from './search-planner'
import type { SubtitleService } from './subtitle-service'

export interface MediaTurnResult {
  clarification?: string
  mediaContext?: GroundedMediaContext
}

export class MediaDiscussionCoordinator {
  private readonly media: MediaRepository
  private readonly contexts: ConversationMediaRepository

  constructor(
    db: Database.Database,
    private readonly llm: LLMClient,
    private readonly subtitles: SubtitleService,
    private readonly onUpdated: (conversationId: string) => void
  ) {
    this.media = new MediaRepository(db)
    this.contexts = new ConversationMediaRepository(db, this.media)
  }

  get(conversationId: string): ConversationMediaContext | undefined {
    return this.contexts.get(conversationId)
  }

  clear(conversationId: string): void {
    this.contexts.clear(conversationId)
    this.onUpdated(conversationId)
  }

  async retry(conversationId: string): Promise<void> {
    const current = this.contexts.get(conversationId)
    if (!current?.media) throw new Error('当前会话没有可重试的影视字幕任务。')
    current.phase = 'searching'
    current.errorCode = undefined
    current.errorMessage = undefined
    current.continueWithoutSubtitles = false
    current.updatedAt = Date.now()
    this.contexts.save(current)
    this.onUpdated(conversationId)
    const ready = await this.subtitles.prepare(
      conversationId,
      current.media,
      current.season,
      current.episode
    )
    const latest = this.contexts.get(conversationId) || current
    latest.phase = ready ? 'ready' : latest.phase === 'awaiting-candidate-selection'
      ? latest.phase
      : 'failed'
    latest.updatedAt = Date.now()
    this.contexts.save(latest)
    this.onUpdated(conversationId)
  }

  continueWithoutSubtitles(conversationId: string): void {
    const current = this.contexts.get(conversationId)
    if (!current) return
    current.continueWithoutSubtitles = true
    current.phase = 'cancelled'
    current.updatedAt = Date.now()
    this.contexts.save(current)
    this.onUpdated(conversationId)
  }

  applyProgress(progress: {
    conversationId: string
    jobId: string
    phase: ConversationMediaContext['phase']
    errorCode?: ConversationMediaContext['errorCode']
    diagnostic?: string
  }): void {
    const current = this.contexts.get(progress.conversationId)
    if (!current) return
    current.activeJobId = progress.jobId
    current.phase = progress.phase
    current.errorCode = progress.errorCode
    current.errorMessage = progress.diagnostic
    current.updatedAt = Date.now()
    this.contexts.save(current)
  }

  async prepareTurn(
    conversationId: string,
    message: Message
  ): Promise<MediaTurnResult> {
    const current = this.contexts.get(conversationId)
    const likelyMediaPlot = this.isLikelyMediaPlotMessage(message.content, current)
    console.info(
      `[subtitle-intent] conversation=${conversationId.slice(0, 8)} ` +
        `gate=${likelyMediaPlot ? 'matched' : 'skipped'} ` +
        `existing=${current?.phase || 'none'}`
    )
    if (!likelyMediaPlot) {
      return current?.phase === 'ready' && !current.continueWithoutSubtitles
          ? { mediaContext: await this.subtitles.prepare(
            conversationId,
            current.media!,
            current.season,
            current.episode,
            message.content
          ) }
        : {}
    }
    const pending = current?.media
      ? JSON.stringify({
          title: current.media.title,
          type: current.media.type,
          year: current.media.year,
          season: current.season,
          episode: current.episode,
          phase: current.phase
        })
      : undefined
    console.info(
      `[subtitle-intent] conversation=${conversationId.slice(0, 8)} ` +
        'requesting structured media intent'
    )
    const intent = await this.llm.extractMediaIntent(message.content, pending)
    console.info(
      `[subtitle-intent] conversation=${conversationId.slice(0, 8)} ` +
        `action=${intent.action} type=${intent.mediaType || 'unknown'} ` +
        `title=${JSON.stringify(intent.title || '')} ` +
        `season=${intent.season || '-'} episode=${intent.episode || '-'} ` +
        `plot=${intent.plotIntent} confidence=${intent.confidence.toFixed(2)}`
    )
    const merged = this.mergeIntent(intent, current)
    if (!merged.media) return {}
    if (
      current?.media &&
      ['failed', 'cancelled'].includes(current.phase) &&
      this.isSameMediaScope(current, merged) &&
      !this.isExplicitRetryRequest(message.content)
    ) {
      console.info(
        `[subtitle-intent] conversation=${conversationId.slice(0, 8)} ` +
          `suppressed=failed-scope-requires-explicit-retry phase=${current.phase}`
      )
      return {}
    }
    const media = this.media.upsert(merged.media)
    const context: ConversationMediaContext = {
      conversationId,
      media,
      season: merged.season,
      episode: merged.episode,
      spoilerBoundary:
        media.type === 'tv' && merged.season && merged.episode
          ? `S${String(merged.season).padStart(2, '0')}E${String(merged.episode).padStart(2, '0')}`
          : `${media.title}${media.year ? ` (${media.year})` : ''}`,
      phase: merged.phase,
      updatedAt: Date.now()
    }
    this.contexts.save(context)
    this.onUpdated(conversationId)
    if (context.phase === 'awaiting-season-episode') {
      console.info(
        `[subtitle-intent] conversation=${conversationId.slice(0, 8)} ` +
          'waiting for season and episode'
      )
      return {
        clarification:
          'Which season and episode would you like to discuss? You can say something like season one, episode three.'
      }
    }
    if (context.phase === 'awaiting-title-confirmation') {
      console.info(
        `[subtitle-intent] conversation=${conversationId.slice(0, 8)} ` +
          'waiting for title confirmation'
      )
      return {
        clarification:
          'Which version do you mean? Please tell me the movie year or the exact title.'
      }
    }
    context.phase = 'searching'
    this.contexts.save(context)
    this.onUpdated(conversationId)
    const mediaContext = await this.subtitles.prepare(
      conversationId,
      media,
      context.season,
      context.episode,
      message.content
    )
    const latest = this.contexts.get(conversationId) || context
    latest.phase = mediaContext
      ? 'ready'
      : latest.phase === 'awaiting-candidate-selection'
        ? latest.phase
        : 'failed'
    latest.updatedAt = Date.now()
    this.contexts.save(latest)
    this.onUpdated(conversationId)
    return { mediaContext }
  }

  private mergeIntent(
    intent: MediaIntent,
    current?: ConversationMediaContext
  ): {
    media?: MediaIdentity
    season?: number
    episode?: number
    phase:
      | 'awaiting-season-episode'
      | 'awaiting-title-confirmation'
      | 'confirmed'
  } {
    const title = intent.title || current?.media?.title
    const type = intent.mediaType || current?.media?.type
    if (!title || !type || !intent.plotIntent && !current?.media) {
      return { phase: 'awaiting-title-confirmation' }
    }
    const season = intent.season || current?.season
    const episode = intent.episode || current?.episode
    const media: MediaIdentity = {
      id: current?.media?.id,
      type,
      title,
      normalizedTitle: normalizeMediaTitle(title),
      aliases: [...new Set([...(current?.media?.aliases || []), ...intent.aliases])],
      year: intent.year || current?.media?.year,
      confirmed: intent.confirmed || intent.confidence >= 0.65
    }
    if (type === 'tv' && (!season || !episode)) {
      return { media, season, episode, phase: 'awaiting-season-episode' }
    }
    if (!media.confirmed) {
      return { media, season, episode, phase: 'awaiting-title-confirmation' }
    }
    return { media, season, episode, phase: 'confirmed' }
  }

  private isLikelyMediaPlotMessage(
    content: string,
    current?: ConversationMediaContext
  ): boolean {
    if (
      current?.phase === 'awaiting-season-episode' &&
      /(?:S\d{1,2}E\d{1,3}|\d{1,2}x\d{1,3}|season|episode|第\s*\d+\s*[季集])/i.test(content)
    ) {
      return true
    }
    const hasPlotIntent =
      /(?:plot|story|scene|ending|what happened|剧情|情节|结局|第\s*\d+\s*[季集]|season\s*\d|episode\s*\d)/i.test(content)
    const hasMediaCue =
      /(?:movie|film|drama|show|series|episode|season|电影|电视剧|剧集|这一集|这部)/i.test(content) ||
      /["“'][^"”']{2,80}["”']/.test(content)
    return hasPlotIntent && (hasMediaCue || Boolean(current?.media))
  }

  private isSameMediaScope(
    current: ConversationMediaContext,
    merged: {
      media?: MediaIdentity
      season?: number
      episode?: number
    }
  ): boolean {
    if (!current.media || !merged.media) return false
    return (
      current.media.type === merged.media.type &&
      normalizeMediaTitle(current.media.title) ===
        normalizeMediaTitle(merged.media.title) &&
      (current.season || 0) === (merged.season || 0) &&
      (current.episode || 0) === (merged.episode || 0)
    )
  }

  private isExplicitRetryRequest(content: string): boolean {
    return /(?:retry|try\s+again|search\s+again|重新搜索|重新下载|重试|再试一次)/i
      .test(content)
  }
}
