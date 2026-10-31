import type Database from 'better-sqlite3'
import type {
  GroundedMediaContext,
  MediaIdentity,
  SubtitleLibraryEntry,
  SubtitleLibrarySummary,
  SubtitleWorkflowRequest,
  SubtitleWorkflowStartResult
} from '../../shared/types'
import {
  MediaMentionRepository,
  MediaRepository,
  SubtitleKnowledgeRepository,
  SubtitleLibraryRepository
} from '../database/subtitle-repositories'
import { normalizeMediaTitle } from './search-planner'
import type { SubtitleService } from './subtitle-service'

export class SubtitleLibraryService {
  private readonly media: MediaRepository
  private readonly mentions: MediaMentionRepository
  private readonly library: SubtitleLibraryRepository
  private readonly knowledge: SubtitleKnowledgeRepository

  constructor(
    db: Database.Database,
    private readonly subtitles: SubtitleService,
    private readonly onUpdated: (summary: SubtitleLibrarySummary) => void,
    private readonly onConversationUpdated: (conversationId: string) => void
  ) {
    this.media = new MediaRepository(db)
    this.mentions = new MediaMentionRepository(db, this.media)
    this.library = new SubtitleLibraryRepository(db, this.media)
    this.knowledge = new SubtitleKnowledgeRepository(db)
  }

  list(): SubtitleLibrarySummary {
    return this.library.list()
  }

  getJob(jobId: string) {
    return this.subtitles.getJob(jobId)
  }

  start(request: SubtitleWorkflowRequest, localFilePath?: string): SubtitleWorkflowStartResult {
    validateRequest(request)
    const identity = this.identityFor(request)
    const handle = this.subtitles.startWorkflow(request, identity, localFilePath)
    if (handle.start.status === 'ready') {
      this.attachReadyResult(request, identity, handle.start.entry)
      this.onUpdated(this.list())
      return handle.start
    }
    void handle.completion
      .then(() => {
        const ready = this.library.findReadyEntry(
          this.media.upsert(identity).id!,
          request.season,
          request.episode
        )
        this.attachReadyResult(request, identity, ready)
        this.onUpdated(this.list())
      })
      .catch((error) => {
        console.error('[subtitle-library] workflow completion failed:', error)
      })
    return handle.start
  }

  processEpisode(
    packageId: string,
    season: number | undefined,
    episode: number | undefined,
    request: Pick<
      SubtitleWorkflowRequest,
      'requestId' | 'origin' | 'conversationId' | 'mentionId'
    >
  ): SubtitleWorkflowStartResult {
    const subtitlePackage = this.library.getPackage(packageId)
    if (!subtitlePackage) throw new Error('本地字幕包不存在或已经被删除。')
    if (subtitlePackage.media.type === 'tv' && !episode) {
      throw new Error('电视剧字幕包需要先选择具体集数。')
    }
    return this.start({
      ...request,
      mediaType: subtitlePackage.media.type,
      title: subtitlePackage.media.title,
      aliases: subtitlePackage.media.aliases,
      year: subtitlePackage.media.year,
      season,
      episode
    })
  }

  attach(conversationId: string, scopeId: string, mentionId?: string): void {
    if (scopeId.startsWith('package:')) {
      throw new Error('整季字幕包需要先选择具体集数并生成剧情知识。')
    }
    this.library.link(conversationId, scopeId)
    if (mentionId) this.mentions.setStatus(mentionId, 'accepted')
    this.onConversationUpdated(conversationId)
    this.onUpdated(this.list())
  }

  detach(conversationId: string, scopeId: string): void {
    this.library.unlink(conversationId, scopeId)
    this.onConversationUpdated(conversationId)
    this.onUpdated(this.list())
  }

  delete(scopeId: string): void {
    this.library.deleteScope(scopeId)
    this.onUpdated(this.list())
  }

  linked(conversationId: string) {
    return this.library.linkedAssets(conversationId)
  }

  groundedContext(
    entry: SubtitleLibraryEntry,
    overview: GroundedMediaContext['overview'],
    query: string
  ): GroundedMediaContext {
    const scenes = entry.assetId
      ? this.knowledge.search(entry.assetId, query, 4)
      : []
    return {
      identity: entry.media,
      season: entry.season,
      episode: entry.episode,
      spoilerBoundary: overview.spoilerBoundary,
      overview,
      scenes: scenes.map((scene) => ({
        ordinal: scene.ordinal,
        dialogue: scene.dialogue.slice(0, 900),
        analysis: scene.analysis
      }))
    }
  }

  private attachReadyResult(
    request: SubtitleWorkflowRequest,
    identity: MediaIdentity,
    entry?: SubtitleLibraryEntry
  ): void {
    if (
      request.origin !== 'chat' ||
      !request.conversationId ||
      !entry ||
      entry.status !== 'ready'
    ) return
    this.library.link(request.conversationId, entry.scopeId)
    if (request.mentionId) {
      this.mentions.setStatus(request.mentionId, 'accepted')
    }
    this.onConversationUpdated(request.conversationId)
  }

  private identityFor(request: SubtitleWorkflowRequest): MediaIdentity {
    const type =
      request.mediaType === 'auto'
        ? request.season || request.episode ? 'tv' : 'movie'
        : request.mediaType
    return {
      type,
      title: request.title.trim(),
      normalizedTitle: normalizeMediaTitle(request.title),
      aliases: [...new Set(request.aliases || [])],
      year: request.year,
      confirmed: true
    }
  }
}

function validateRequest(request: SubtitleWorkflowRequest): void {
  if (!request.requestId || !request.title.trim()) {
    throw new Error('请输入影视作品名称。')
  }
  const type =
    request.mediaType === 'auto'
      ? request.season || request.episode ? 'tv' : 'movie'
      : request.mediaType
  if (type === 'tv' && request.origin === 'chat' && (!request.season || !request.episode)) {
    throw new Error('从对话搜索电视剧字幕时，请先填写季数和集数。')
  }
  if (request.season !== undefined && request.season < 1) {
    throw new Error('季数必须大于 0。')
  }
  if (request.episode !== undefined && request.episode < 1) {
    throw new Error('集数必须大于 0。')
  }
}
