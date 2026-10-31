import type Database from 'better-sqlite3'
import { createHash, randomUUID } from 'crypto'
import {
  mkdirSync,
  readFileSync,
  unlinkSync,
  existsSync,
  writeFileSync
} from 'fs'
import { basename, extname, join } from 'path'
import type {
  GroundedMediaContext,
  MediaIdentity,
  SubtitleCandidate,
  SubtitleFeatureConfig,
  SubtitleFeatureStatus,
  SubtitleJobProgress,
  SubtitleLibraryEntry,
  SubtitlePackage,
  SubtitleSourceHealth,
  SubtitleSourceId,
  SubtitleSourceOutcome,
  SubtitleWorkflowRequest,
  SubtitleWorkflowStartResult
} from '../../shared/types'
import {
  MediaRepository,
  SubtitleJobRepository,
  SubtitleKnowledgeRepository,
  SubtitleLibraryRepository
} from '../database/subtitle-repositories'
import type { LLMClient } from '../services/llm-client'
import { extractSubtitleArchive } from './archive-extractor'
import { stageLocalSubtitle } from './local-import'
import {
  SUBTITLE_CLEANER_VERSION,
  SUBTITLE_MERGE_PROMPT_VERSION,
  SUBTITLE_PARSER_VERSION,
  SUBTITLE_SCENE_PROMPT_VERSION
} from './constants'
import {
  buildDialogueScenes,
  decodeSubtitle,
  parseSubtitle,
  toDialogueDocument
} from './dialogue-processor'
import { downloadSubtitle } from './downloader'
import {
  buildSearchQueries,
  scoreSubtitleCandidate
} from './search-planner'
import { subtitleSourceProvider as communityProvider } from './sources/community-provider'
import type { SubtitleSourceProvider } from './sources/types'
import { SubtitleStorage } from './storage'

type ProgressListener = (progress: SubtitleJobProgress) => void
type Row = Record<string, unknown>
type WorkflowMeta = Pick<
  SubtitleWorkflowRequest,
  'requestId' | 'origin' | 'conversationId' | 'mentionId'
>
type RunningJob = {
  jobId: string
  promise: Promise<GroundedMediaContext | undefined>
}

const CANDIDATE_SELECTION_TIMEOUT_MS = 20 * 60_000

export class SubtitleService {
  private readonly media: MediaRepository
  private readonly jobs: SubtitleJobRepository
  private readonly knowledge: SubtitleKnowledgeRepository
  private readonly library: SubtitleLibraryRepository
  private readonly running = new Map<string, RunningJob>()
  private readonly controllers = new Map<string, AbortController>()
  private readonly pendingCandidates = new Map<string, {
    candidates: SubtitleCandidate[]
    resolve: (candidate: SubtitleCandidate) => void
    reject: (error: Error) => void
    cleanup: () => void
  }>()

  constructor(
    private readonly db: Database.Database,
    private readonly llm: LLMClient,
    private readonly storage: SubtitleStorage,
    private readonly getConfig: () => SubtitleFeatureConfig,
    private readonly onProgress: ProgressListener,
    private readonly sourceProvider: SubtitleSourceProvider = communityProvider
  ) {
    this.media = new MediaRepository(db)
    this.jobs = new SubtitleJobRepository(db)
    this.knowledge = new SubtitleKnowledgeRepository(db)
    this.library = new SubtitleLibraryRepository(db, this.media)
    this.jobs.markInterruptedRetryable()
    this.migrateLegacyPackageStorage()
  }

  async status(): Promise<SubtitleFeatureStatus> {
    const config = this.getConfig()
    const sources = await Promise.all(this.sourceProvider.createAdapters(config).map((adapter) =>
      adapter.healthCheck().catch((error): SubtitleSourceHealth => ({
        source: adapter.id,
        status: 'unhealthy',
        baseUrl: '',
        checkedAt: Date.now(),
        diagnostic: safeError(error)
      }))
    ))
    return {
      config,
      storage: this.storage.probe(),
      sources,
      sourceProvider: { available: this.sourceProvider.available }
    }
  }

  async prepare(
    conversationId: string,
    identity: MediaIdentity,
    season?: number,
    episode?: number,
    relevanceQuery?: string
  ): Promise<GroundedMediaContext | undefined> {
    const media = this.media.upsert(identity)
    const key = `${media.id}|${season || 0}|${episode || 0}`
    const existing = this.findReadyContext(media, season, episode, relevanceQuery)
    if (existing) return existing
    const current = this.running.get(key)
    if (current) return current.promise
    const workflow: WorkflowMeta = {
      requestId: randomUUID(),
      origin: 'chat',
      conversationId
    }
    const jobId = this.jobs.create(media.id!, season, episode, workflow)
    const reusablePackage = this.library.findReusablePackage(media.id!, season, episode)
    const task = (
      reusablePackage &&
      (media.type === 'movie' || episode !== undefined)
      ? this.runFromPackage(jobId, media, reusablePackage, season, episode, relevanceQuery, workflow)
      : this.run(jobId, media, season, episode, relevanceQuery, workflow))
      .finally(() => this.running.delete(key))
    this.running.set(key, { jobId, promise: task })
    return task
  }

  startWorkflow(
    request: SubtitleWorkflowRequest,
    identity: MediaIdentity,
    localFilePath?: string
  ): {
    start: SubtitleWorkflowStartResult
    completion: Promise<GroundedMediaContext | undefined>
  } {
    const media = this.media.upsert(identity)
    const ready = this.findReadyContext(
      media,
      request.season,
      request.episode,
      request.title
    )
    if (ready && !localFilePath) {
      return {
        start: {
          requestId: request.requestId,
          status: 'ready',
          entry: this.library.findReadyEntry(
            media.id!,
            request.season,
            request.episode
          )
        },
        completion: Promise.resolve(ready)
      }
    }
    const reusablePackage = this.library.findReusablePackage(
      media.id!,
      request.season,
      request.episode
    )
    if (
      !localFilePath && reusablePackage &&
      media.type === 'tv' &&
      request.episode === undefined
    ) {
      return {
        start: {
          requestId: request.requestId,
          status: 'ready',
          entry: packageEntry(reusablePackage)
        },
        completion: Promise.resolve(undefined)
      }
    }
    const key = `${media.id}|${request.season || 0}|${request.episode || 0}`
    const current = this.running.get(key)
    if (current) {
      return {
        start: {
          requestId: request.requestId,
          jobId: current.jobId,
          status: 'started'
        },
        completion: current.promise
      }
    }
    if (!localFilePath && !reusablePackage && !this.sourceProvider.available) {
      throw new Error('当前版本未包含在线字幕来源，请导入本地字幕，或使用已经保存的字幕包。')
    }
    const jobId = this.jobs.create(
      media.id!,
      request.season,
      request.episode,
      request
    )
    const completion = (
      localFilePath
      ? this.runLocalImport(jobId, media, localFilePath, request)
      : reusablePackage &&
      (media.type === 'movie' || request.episode !== undefined)
      ? this.runFromPackage(
          jobId,
          media,
          reusablePackage,
          request.season,
          request.episode,
          request.title,
          request
        )
      : this.run(
          jobId,
          media,
          request.season,
          request.episode,
          request.title,
          request
        )).finally(() => this.running.delete(key))
    this.running.set(key, { jobId, promise: completion })
    return {
      start: { requestId: request.requestId, jobId, status: 'started' },
      completion
    }
  }

  getJob(jobId: string): SubtitleJobProgress | undefined {
    return this.jobs.getProgress(jobId)
  }

  cancel(jobId: string): void {
    this.controllers.get(jobId)?.abort()
    const pending = this.pendingCandidates.get(jobId)
    pending?.cleanup()
    pending?.reject(new Error('cancelled'))
    this.pendingCandidates.delete(jobId)
  }

  selectCandidate(
    jobId: string,
    candidateId: string
  ): void {
    const pending = this.pendingCandidates.get(jobId)
    const candidate = pending?.candidates.find((item) => item.id === candidateId)
    if (!pending || !candidate) {
      throw new Error('字幕候选已失效，请重新搜索。')
    }
    pending.cleanup()
    this.pendingCandidates.delete(jobId)
    pending.resolve(candidate)
  }

  private async run(
    jobId: string,
    media: MediaIdentity,
    season?: number,
    episode?: number,
    relevanceQuery?: string,
    workflow?: WorkflowMeta
  ): Promise<GroundedMediaContext | undefined> {
    this.storage.assertWritable()
    const config = this.getConfig()
    if (!config.enabled) return undefined
    const controller = new AbortController()
    this.controllers.set(jobId, controller)
    console.info(
      `[subtitle-job] start job=${jobId.slice(0, 8)} ` +
        `title=${terminalValue(media.title)} type=${media.type} ` +
        `season=${season || '-'} episode=${episode || '-'}`
    )
    const emit = (
      phase: SubtitleJobProgress['phase'],
      message: string,
      extra: Partial<SubtitleJobProgress> = {}
    ) => {
      const progress: SubtitleJobProgress = {
        jobId,
        conversationId: workflow?.conversationId,
        requestId: workflow?.requestId,
        origin: workflow?.origin,
        phase,
        message,
        updatedAt: Date.now(),
        ...extra
      }
      this.jobs.update(progress, progress.candidates)
      this.onProgress(progress)
    }
    try {
      if (!this.sourceProvider.available) {
        emit('failed', '当前版本未包含在线字幕来源，请导入本地字幕。', {
          errorCode: 'source-extension-unavailable'
        })
        return undefined
      }
      const adapters = this.sourceProvider.createAdapters(config)
      const sessions = new Map(
        adapters.map((adapter) => [
          adapter.id,
          this.sourceProvider.createSession(config.requestTimeoutMs)
        ])
      )
      const candidates: SubtitleCandidate[] = []
      const sourceFailures: Array<{
        source: SubtitleSourceId
        outcome: SubtitleSourceOutcome
        diagnostic?: string
      }> = []
      emit('searching', '正在搜索匹配字幕…')
      const queries = buildSearchQueries(media, season, episode)
        .slice(0, config.queryBudgetPerSource)
      for (const adapter of adapters) {
        const sourceSession = sessions.get(adapter.id)!
        for (let queryIndex = 0; queryIndex < queries.length; queryIndex += 1) {
          const query = queries[queryIndex]
          if (queryIndex > 0) {
            await abortableDelay(700, controller.signal)
          }
          const result = await adapter.search(query, sourceSession, controller.signal)
          console.info(
            `[subtitle-search] job=${jobId.slice(0, 8)} ` +
              `source=${adapter.id} query=${terminalValue(query.text)} ` +
              `outcome=${result.outcome} candidates=${result.value?.length || 0}`
          )
          if (result.outcome === 'ok' && result.value?.length) {
            candidates.push(
              ...result.value.map((candidate) =>
                scoreSubtitleCandidate(candidate, media, season, episode)
              )
            )
            if (candidates.some((candidate) => candidate.score >= 95)) break
          }
          if (!['ok', 'no-results'].includes(result.outcome)) {
            sourceFailures.push({
              source: adapter.id,
              outcome: result.outcome,
              diagnostic: result.diagnostic
            })
          }
          if (
            [
              'rate-limited',
              'unavailable',
              'verification-required',
              'verification-failed',
              'layout-changed',
              'download-rejected'
            ].includes(result.outcome)
          ) {
            if (result.outcome === 'rate-limited') {
              await abortableDelay(1_500, controller.signal)
            }
            break
          }
        }
      }
      candidates.sort((left, right) => right.score - left.score)
      if (candidates.length) {
        console.info(
          `[subtitle-search] job=${jobId.slice(0, 8)} ranked=${candidates.length} ` +
            `top=${terminalValue(candidates[0].title)} score=${candidates[0].score}`
        )
      }
      if (!candidates.length) {
        const failure = chooseSourceFailure(sourceFailures)
        emit('failed', failure ? sourceFailureMessage(failure.outcome) : '没有找到可用字幕。', {
          errorCode: failure?.outcome || 'no-results',
          diagnostic: failure
            ? sourceFailures.map(formatSourceFailure).join('；')
            : '所有启用来源均完成搜索，但没有返回匹配候选。'
        })
        return undefined
      }
      let selected = candidates[0]
      if (
        candidates.length > 1 &&
        Math.abs(candidates[0].score - candidates[1].score) < 4
      ) {
        emit('awaiting-candidate-selection', '请确认要使用的字幕。', {
          candidates: candidates.slice(0, 8)
        })
        selected = await this.waitForCandidateSelection(
          jobId,
          candidates.slice(0, 8),
          controller.signal
        )
        console.info(
          `[subtitle-search] job=${jobId.slice(0, 8)} ` +
            `user-selected=${terminalValue(selected.title)}`
        )
      }
      const fallbackCandidates = candidates
        .filter((candidate) =>
          candidate.id !== selected.id &&
          candidate.score >= selected.score - 6
        )
        .slice(0, 2)
      let candidateAttempt = 0
      while (true) {
        try {
      const adapter = adapters.find((item) => item.id === selected.source)
      if (!adapter) throw new Error('字幕来源已停用。')
      const session = sessions.get(selected.source) ||
        this.sourceProvider.createSession(config.requestTimeoutMs)
      emit('searching', '正在获取字幕下载地址…', {
        source: selected.source
      })
      const resolution = await adapter.resolveDownload(selected, session, controller.signal)
      if (resolution.outcome !== 'ok' || !resolution.value) {
        throw new Error(resolution.diagnostic || resolution.outcome)
      }
      console.info(
        `[subtitle-download] job=${jobId.slice(0, 8)} ` +
          `resolved source=${selected.source} host=${new URL(resolution.value.url).host}`
      )
      const directory = this.storage.packageWorkDirectory(media, jobId)
      const sourceName = this.storage.safeFilename(
        resolution.value.filename ||
          basename(new URL(resolution.value.url).pathname) ||
          `${selected.source}-subtitle.zip`
      )
      const requestedRawPath = join(directory, 'raw', sourceName)
      emit('downloading', '正在下载字幕…', { source: selected.source })
      const download = await downloadSubtitle(
        resolution.value,
        requestedRawPath,
        (receivedBytes, totalBytes) => emit('downloading', '正在下载字幕…', {
          source: selected.source,
          receivedBytes,
          totalBytes,
          percent: totalBytes ? Math.round((receivedBytes / totalBytes) * 100) : undefined
        }),
        controller.signal
      )
      emit('extracting', '正在本地解压并选择字幕…', { source: selected.source })
      const rawPath = download.path
      emit(
        'extracting',
        download.kind === 'subtitle'
          ? '正在校验字幕文件…'
          : `下载完成，正在本地解压 ${download.kind.toUpperCase()} 字幕包…`,
        { source: selected.source }
      )
      const subtitleFiles =
        download.kind !== 'subtitle'
          ? await extractSubtitleArchive(
              rawPath,
              join(directory, 'extracted', `candidate-${candidateAttempt}`),
              download.kind
            )
          : [rawPath]
      const effectivePackType = inferDownloadedPackType(
        media,
        selected.packType,
        subtitleFiles,
        season,
        episode
      )
      const packageEpisode =
        media.type === 'tv' &&
        effectivePackType === 'episode'
          ? episode
          : undefined
      const packageSeason =
        effectivePackType === 'series' ? undefined : season
      const persisted = this.storage.persistPackageFiles({
        media,
        season: packageSeason,
        episode: packageEpisode,
        packType: effectivePackType,
        rawPath,
        subtitleFiles,
        sha256: download.sha256
      })
      this.media.addAliases(
        media.id!,
        aliasesFromSubtitleFiles(persisted.subtitleFiles)
      )
      const packageId = this.library.savePackage({
        mediaId: media.id!,
        season: packageSeason,
        episode: packageEpisode,
        packType: effectivePackType,
        source: selected.source,
        sourcePageUrl: selected.pageUrl,
        candidate: selected,
        rawRelativePath: this.storage.relativePath(persisted.rawPath),
        manifestRelativePaths: persisted.subtitleFiles.map((file) =>
          this.storage.relativePath(file)
        ),
        sha256: download.sha256,
        byteSize: download.byteSize
      })
      if (episode === undefined && media.type === 'tv') {
        emit('ready', '整季字幕包已保存，可按集生成剧情知识。', {
          source: selected.source
        })
        return undefined
      }
      return await this.processPackageFiles({
        jobId,
        media,
        packageId,
        rawPath: persisted.rawPath,
        subtitleFiles: persisted.subtitleFiles,
        season,
        episode,
        relevanceQuery,
        source: selected.source,
        sourcePageUrl: selected.pageUrl,
        language: selected.language,
        format: selected.format,
        controller,
        emit,
        config
      })
        } catch (error) {
          const nextCandidate = fallbackCandidates.shift()
          if (!nextCandidate || !isCandidateFallbackError(error)) throw error
          candidateAttempt += 1
          console.warn(
            `[subtitle-candidate] job=${jobId.slice(0, 8)} ` +
              `candidate=${terminalValue(selected.title)} failed=${terminalValue(safeError(error))} ` +
              `fallback=${terminalValue(nextCandidate.title)}`
          )
          emit(
            'searching',
            `当前候选不可用，正在自动尝试候选 ${candidateAttempt + 1}…`,
            {
              source: nextCandidate.source,
              diagnostic: safeError(error)
            }
          )
          selected = nextCandidate
        }
      }
    } catch (error) {
      const cancelled = controller.signal.aborted || safeError(error) === 'cancelled'
      emit(cancelled ? 'cancelled' : 'failed', cancelled ? '字幕任务已取消。' : '字幕准备失败。', {
        errorCode: cancelled ? 'cancelled' : classifyError(error),
        diagnostic: safeError(error)
      })
      console.error(
        `[subtitle-job] job=${jobId.slice(0, 8)} failed=${terminalValue(safeError(error))}`
      )
      return undefined
    } finally {
      this.controllers.delete(jobId)
      const pending = this.pendingCandidates.get(jobId)
      pending?.cleanup()
      this.pendingCandidates.delete(jobId)
      this.storage.cleanupPackageWork(media, jobId)
    }
  }

  private async runLocalImport(
    jobId: string,
    media: MediaIdentity,
    filePath: string,
    request: SubtitleWorkflowRequest
  ): Promise<GroundedMediaContext | undefined> {
    const controller = new AbortController()
    this.controllers.set(jobId, controller)
    const emit = (
      phase: SubtitleJobProgress['phase'],
      message: string,
      extra: Partial<SubtitleJobProgress> = {}
    ) => {
      const progress: SubtitleJobProgress = {
        jobId, requestId: request.requestId, origin: request.origin,
        conversationId: request.conversationId, phase, message,
        source: 'local', updatedAt: Date.now(), ...extra
      }
      this.jobs.update(progress)
      this.onProgress(progress)
    }
    try {
      this.storage.assertWritable()
      emit('extracting', '正在导入并检查本地字幕…')
      const staged = await stageLocalSubtitle(
        this.storage, media, jobId, filePath, controller.signal
      )
      const packType = inferDownloadedPackType(
        media, 'unknown', staged.subtitleFiles, request.season, request.episode
      )
      const season = packType === 'series' ? undefined : request.season
      const episode = packType === 'episode' ? request.episode : undefined
      const persisted = this.storage.persistPackageFiles({
        media, season, episode, packType, rawPath: staged.rawPath,
        subtitleFiles: staged.subtitleFiles, sha256: staged.sha256
      })
      this.media.addAliases(media.id!, aliasesFromSubtitleFiles(persisted.subtitleFiles))
      const packageId = this.library.savePackage({
        mediaId: media.id!, season, episode, packType, source: 'local',
        rawRelativePath: this.storage.relativePath(persisted.rawPath),
        manifestRelativePaths: persisted.subtitleFiles.map((file) => this.storage.relativePath(file)),
        sha256: staged.sha256, byteSize: staged.byteSize
      })
      if (media.type === 'tv' && request.episode === undefined) {
        emit('ready', '本地字幕包已保存，可选择集数后生成剧情知识。')
        return undefined
      }
      return await this.processPackageFiles({
        jobId, media, packageId, rawPath: persisted.rawPath,
        subtitleFiles: persisted.subtitleFiles, season: request.season,
        episode: request.episode, relevanceQuery: request.title,
        source: 'local', sourcePageUrl: '', controller, emit, config: this.getConfig()
      })
    } catch (error) {
      const cancelled = controller.signal.aborted
      emit(cancelled ? 'cancelled' : 'failed', cancelled ? '字幕任务已取消。' : '本地字幕导入失败。', {
        errorCode: cancelled ? 'cancelled' : classifyError(error),
        diagnostic: safeError(error)
      })
      return undefined
    } finally {
      this.controllers.delete(jobId)
      this.storage.cleanupPackageWork(media, jobId)
    }
  }

  private async runFromPackage(
    jobId: string,
    media: MediaIdentity,
    subtitlePackage: SubtitlePackage,
    season: number | undefined,
    episode: number | undefined,
    relevanceQuery: string | undefined,
    workflow: WorkflowMeta
  ): Promise<GroundedMediaContext | undefined> {
    const controller = new AbortController()
    this.controllers.set(jobId, controller)
    const emit = (
      phase: SubtitleJobProgress['phase'],
      message: string,
      extra: Partial<SubtitleJobProgress> = {}
    ) => {
      const progress: SubtitleJobProgress = {
        jobId,
        conversationId: workflow.conversationId,
        requestId: workflow.requestId,
        origin: workflow.origin,
        phase,
        message,
        updatedAt: Date.now(),
        ...extra
      }
      this.jobs.update(progress, progress.candidates)
      this.onProgress(progress)
    }
    try {
      this.storage.assertWritable()
      emit('extracting', '正在从本地整季字幕包选择对应剧集…', {
        source: subtitlePackage.source
      })
      const subtitleFiles = subtitlePackage.manifestRelativePaths
        .map((path) => this.storage.absolutePath(path))
        .filter((path) => existsSync(path))
      if (!subtitleFiles.length) {
        throw new Error('processing-failed: 本地字幕包文件清单已失效')
      }
      return await this.processPackageFiles({
        jobId,
        media,
        packageId: subtitlePackage.id,
        rawPath: this.storage.absolutePath(subtitlePackage.rawRelativePath),
        subtitleFiles,
        season,
        episode,
        relevanceQuery,
        source: subtitlePackage.source,
        sourcePageUrl: '',
        controller,
        emit,
        config: this.getConfig()
      })
    } catch (error) {
      const cancelled = controller.signal.aborted || safeError(error) === 'cancelled'
      emit(
        cancelled ? 'cancelled' : 'failed',
        cancelled ? '字幕任务已取消。' : '本地字幕处理失败。',
        {
          errorCode: cancelled ? 'cancelled' : classifyError(error),
          diagnostic: safeError(error)
        }
      )
      return undefined
    } finally {
      this.controllers.delete(jobId)
    }
  }

  private async processPackageFiles(input: {
    jobId: string
    media: MediaIdentity
    packageId: string
    rawPath: string
    subtitleFiles: string[]
    season?: number
    episode?: number
    relevanceQuery?: string
    source: SubtitleSourceId
    sourcePageUrl: string
    language?: string
    format?: string
    controller: AbortController
    emit: (
      phase: SubtitleJobProgress['phase'],
      message: string,
      extra?: Partial<SubtitleJobProgress>
    ) => void
    config: SubtitleFeatureConfig
  }): Promise<GroundedMediaContext> {
    const subtitlePath = selectEpisodeFile(
      input.subtitleFiles,
      input.season,
      input.episode
    )
    if (!subtitlePath) throw new Error('episode-not-found-in-pack')
    input.emit('processing', '正在清理对白并整理剧情知识…', {
      source: input.source
    })
    const text = decodeSubtitle(readFileSync(subtitlePath))
    const formatHint =
      extname(subtitlePath) ||
      `.${(input.format || 'srt').toLocaleLowerCase()}`
    const scenes = buildDialogueScenes(parseSubtitle(text, formatHint))
    if (!scenes.length) {
      throw new Error('processing-failed: 字幕中没有可用对白')
    }
    console.info(
      `[subtitle-process] job=${input.jobId.slice(0, 8)} ` +
        `file=${terminalValue(basename(subtitlePath))} scenes=${scenes.length}`
    )
    const directory = this.storage.mediaDirectory(
      input.media,
      input.season,
      input.episode
    )
    const dialoguePath = join(directory, 'dialogue', 'dialogue.txt')
    writeFileSync(dialoguePath, toDialogueDocument(scenes), 'utf8')
    const assetId = this.saveAsset({
      mediaId: input.media.id!,
      jobId: input.jobId,
      packageId: input.packageId,
      season: input.season,
      episode: input.episode,
      source: input.source,
      sourcePageUrl: input.sourcePageUrl,
      rawPath: input.rawPath,
      dialoguePath,
      sha256: fileScopeHash(
        this.library.getPackage(input.packageId)?.sha256 || '',
        input.season,
        input.episode
      ),
      byteSize: this.library.getPackage(input.packageId)?.byteSize || 0,
      language: input.language,
      format: extname(subtitlePath).slice(1).toUpperCase()
    })
    const persistedByOrdinal = new Map(
      this.knowledge
        .listScenes(assetId)
        .map((scene) => [scene.ordinal, scene])
    )
    for (const scene of scenes) {
      const persisted = persistedByOrdinal.get(scene.ordinal)
      if (persisted?.dialogue === scene.dialogue && persisted.analysis) {
        scene.id = persisted.id
        scene.analysis = persisted.analysis
      }
    }
    this.knowledge.replaceScenes(assetId, scenes)
    const pendingScenes = scenes.filter((scene) => !scene.analysis)
    let completedScenes = scenes.length - pendingScenes.length
    if (completedScenes > 0) {
      console.info(
        `[subtitle-process] job=${input.jobId.slice(0, 8)} ` +
          `reused-scenes=${completedScenes}/${scenes.length}`
      )
      input.emit(
        'processing',
        `已复用 ${completedScenes} 个场景，正在继续分析…`,
        {
          source: input.source,
          percent: Math.round((completedScenes / scenes.length) * 100)
        }
      )
    }
    await mapConcurrent(
      pendingScenes,
      input.config.sceneConcurrency,
      async (scene) => {
        if (input.controller.signal.aborted) throw new Error('cancelled')
        try {
          scene.analysis = await this.llm.analyzeSubtitleScene(scene)
          // The LLM request itself cannot safely be interrupted across all
          // providers, but a cancelled job must never persist its late result
          // or start another scene after that request returns.
          if (input.controller.signal.aborted) throw new Error('cancelled')
          this.knowledge.saveSceneAnalysis(assetId, scene)
        } catch (error) {
          const diagnostic = safeError(error)
          this.knowledge.saveSceneFailure(assetId, scene, diagnostic)
          throw new Error(
            `scene-analysis-failed: 场景 ${scene.ordinal + 1} 分析失败；${diagnostic}`
          )
        }
        completedScenes += 1
        console.info(
          `[subtitle-process] job=${input.jobId.slice(0, 8)} ` +
            `scene=${completedScenes}/${scenes.length}`
        )
        input.emit(
          'processing',
          `正在分析字幕场景（${completedScenes}/${scenes.length}）…`,
          {
            source: input.source,
            percent: Math.round((completedScenes / scenes.length) * 100)
          }
        )
      }
    )
    input.emit('processing', '场景分析完成，正在生成整集剧情摘要…', {
      source: input.source,
      percent: 100
    })
    if (input.controller.signal.aborted) throw new Error('cancelled')
    const overview = await this.llm.mergeEpisodeKnowledge(
      input.media,
      scenes,
      input.season,
      input.episode
    )
    if (input.controller.signal.aborted) throw new Error('cancelled')
    const knowledgePath = join(directory, 'knowledge', 'episode.json')
    writeFileSync(knowledgePath, JSON.stringify(overview, null, 2), 'utf8')
    this.db.prepare(`
      UPDATE subtitle_assets
      SET relative_knowledge_path = ?, status = 'ready', updated_at = ?
      WHERE id = ?
    `).run(this.storage.relativePath(knowledgePath), Date.now(), assetId)
    this.knowledge.saveKnowledge(
      assetId,
      overview,
      this.getConfig().captchaProfile?.model || '',
      SUBTITLE_CLEANER_VERSION,
      SUBTITLE_SCENE_PROMPT_VERSION,
      SUBTITLE_MERGE_PROMPT_VERSION
    )
    input.emit('ready', '字幕剧情知识已就绪。', { source: input.source })
    const relevantScenes = this.knowledge.search(
      assetId,
      input.relevanceQuery || input.media.title,
      4
    )
    return {
      identity: input.media,
      season: input.season,
      episode: input.episode,
      spoilerBoundary: overview.spoilerBoundary,
      overview,
      scenes: (relevantScenes.length ? relevantScenes : scenes.slice(0, 4))
        .map((scene) => ({
          ordinal: scene.ordinal,
          dialogue: scene.dialogue.slice(0, 900),
          analysis: scene.analysis
        }))
    }
  }

  private waitForCandidateSelection(
    jobId: string,
    candidates: SubtitleCandidate[],
    signal: AbortSignal
  ): Promise<SubtitleCandidate> {
    return new Promise((resolve, reject) => {
      let settled = false
      const timeout = setTimeout(() => {
        settleReject(new Error('candidate-selection-timeout'))
      }, CANDIDATE_SELECTION_TIMEOUT_MS)
      const onAbort = () => settleReject(new Error('cancelled'))
      const cleanup = () => {
        clearTimeout(timeout)
        signal.removeEventListener('abort', onAbort)
      }
      const settleResolve = (candidate: SubtitleCandidate) => {
        if (settled) return
        settled = true
        cleanup()
        resolve(candidate)
      }
      const settleReject = (error: Error) => {
        if (settled) return
        settled = true
        cleanup()
        reject(error)
      }
      this.pendingCandidates.set(jobId, {
        candidates,
        resolve: settleResolve,
        reject: settleReject,
        cleanup
      })
      if (signal.aborted) {
        settleReject(new Error('cancelled'))
      } else {
        signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  private saveAsset(input: {
    mediaId: string
    jobId: string
    packageId: string
    season?: number
    episode?: number
    source: string
    sourcePageUrl: string
    rawPath: string
    dialoguePath: string
    sha256: string
    byteSize: number
    language?: string
    format?: string
  }): string {
    const existing = this.db.prepare(`
      SELECT id, relative_raw_path FROM subtitle_assets
      WHERE media_id = ? AND COALESCE(season, 0) = COALESCE(?, 0)
        AND COALESCE(episode, 0) = COALESCE(?, 0) AND sha256 = ?
    `).get(input.mediaId, input.season ?? null, input.episode ?? null, input.sha256) as Row | undefined
    if (existing) {
      const existingRaw = this.storage.absolutePath(String(existing.relative_raw_path))
      if (
        this.storage.relativePath(input.rawPath) !==
          String(existing.relative_raw_path) &&
        existsSync(input.rawPath) &&
        input.rawPath !== existingRaw
      ) {
        unlinkSync(input.rawPath)
      }
      return String(existing.id)
    }
    const id = randomUUID()
    const now = Date.now()
    this.db.prepare(`
      INSERT INTO subtitle_assets(
        id, media_id, job_id, package_id, season, episode, source, source_page_url,
        relative_raw_path, relative_dialogue_path, sha256, byte_size,
        language, format, parser_version, cleaner_version,
        knowledge_prompt_version, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'processing', ?, ?)
    `).run(
      id,
      input.mediaId,
      input.jobId,
      input.packageId,
      input.season ?? null,
      input.episode ?? null,
      input.source,
      input.sourcePageUrl,
      this.storage.relativePath(input.rawPath),
      this.storage.relativePath(input.dialoguePath),
      input.sha256,
      input.byteSize,
      input.language ?? null,
      input.format ?? null,
      SUBTITLE_PARSER_VERSION,
      SUBTITLE_CLEANER_VERSION,
      SUBTITLE_MERGE_PROMPT_VERSION,
      now,
      now
    )
    return id
  }

  private findReadyContext(
    media: MediaIdentity,
    season?: number,
    episode?: number,
    relevanceQuery?: string
  ): GroundedMediaContext | undefined {
    const row = this.db.prepare(`
      SELECT a.id AS asset_id, k.knowledge_json
      FROM subtitle_assets a
      JOIN episode_knowledge k ON k.asset_id = a.id AND k.status = 'ready'
      WHERE a.media_id = ?
        AND COALESCE(a.season, 0) = COALESCE(?, 0)
        AND COALESCE(a.episode, 0) = COALESCE(?, 0)
        AND a.status = 'ready'
      ORDER BY k.updated_at DESC LIMIT 1
    `).get(media.id, season ?? null, episode ?? null) as Row | undefined
    if (!row) return undefined
    try {
      const overview = JSON.parse(String(row.knowledge_json))
      const scenes = this.knowledge.search(
        String(row.asset_id),
        relevanceQuery || media.title,
        4
      )
      return {
        identity: media,
        season,
        episode,
        spoilerBoundary: overview.spoilerBoundary,
        overview,
        scenes
      }
    } catch {
      return undefined
    }
  }

  private migrateLegacyPackageStorage(): void {
    const rows = this.db.prepare(`
      SELECT id, media_id, season, episode, pack_type, relative_raw_path,
        manifest_json, sha256
      FROM subtitle_packages
      WHERE status = 'ready'
    `).all() as Row[]
    for (const row of rows) {
      try {
        const media = this.media.get(String(row.media_id))
        if (!media) continue
        const storedSeason = Number(row.season) || undefined
        const storedEpisode = Number(row.episode) || undefined
        const rawRelativePath = String(row.relative_raw_path || '')
        const manifestRelativePaths = JSON.parse(
          String(row.manifest_json || '[]')
        ) as string[]
        const rawPath = this.storage.absolutePath(rawRelativePath)
        const subtitleFiles = manifestRelativePaths
          .map((path) => this.storage.absolutePath(path))
          .filter((path) => existsSync(path))
        if (!existsSync(rawPath) || !subtitleFiles.length) continue
        const packType = inferDownloadedPackType(
          media,
          String(row.pack_type) as SubtitleCandidate['packType'],
          subtitleFiles,
          storedSeason,
          storedEpisode
        )
        if (packType !== 'season' && packType !== 'series') continue
        const season = packType === 'series' ? undefined : storedSeason
        const expectedScope =
          packType === 'series'
            ? 'series'
            : `S${String(season || 0).padStart(2, '0')}`
        const normalizedRaw = `/${rawRelativePath.replace(/\\/g, '/')}`
        const manifestsAreCanonical = manifestRelativePaths.length > 0 &&
          manifestRelativePaths.every((path) =>
            `/${path.replace(/\\/g, '/')}`.includes(`/${expectedScope}/files/`)
          )
        if (
          normalizedRaw.includes(`/${expectedScope}/raw/`) &&
          manifestsAreCanonical &&
          row.episode == null &&
          (packType !== 'series' || row.season == null) &&
          String(row.pack_type) === packType
        ) {
          this.media.addAliases(media.id!, aliasesFromSubtitleFiles(subtitleFiles))
          continue
        }
        const persisted = this.storage.persistPackageFiles({
          media,
          season,
          packType,
          rawPath,
          subtitleFiles,
          sha256: String(row.sha256 || '')
        })
        const nextRaw = this.storage.relativePath(persisted.rawPath)
        const nextManifest = persisted.subtitleFiles.map((path) =>
          this.storage.relativePath(path)
        )
        this.db.transaction(() => {
          this.db.prepare(`
            UPDATE subtitle_packages
            SET season = ?, episode = NULL, pack_type = ?,
              relative_raw_path = ?, manifest_json = ?, updated_at = ?
            WHERE id = ?
          `).run(
            season ?? null,
            packType,
            nextRaw,
            JSON.stringify(nextManifest),
            Date.now(),
            row.id
          )
          this.db.prepare(`
            UPDATE subtitle_assets
            SET relative_raw_path = ?, updated_at = ?
            WHERE package_id = ?
          `).run(nextRaw, Date.now(), row.id)
          this.media.addAliases(
            media.id!,
            aliasesFromSubtitleFiles(persisted.subtitleFiles)
          )
        })()
        console.info(
          `[subtitle-storage] migrated package=${String(row.id).slice(0, 8)} ` +
            `scope=${expectedScope} files=${nextManifest.length}`
        )
      } catch (error) {
        console.warn(
          `[subtitle-storage] legacy package migration skipped: ${safeError(error)}`
        )
      }
    }
  }
}

function selectEpisodeFile(
  files: string[],
  season?: number,
  episode?: number
): string | undefined {
  if (files.length === 1) return files[0]
  if (!episode) return files[0]
  const patterns = [
    new RegExp(`S0*${season || 1}E0*${episode}(?!\\d)`, 'i'),
    new RegExp(`(?:^|\\D)${season || 1}x0*${episode}(?!\\d)`, 'i'),
    new RegExp(`EP?0*${episode}(?!\\d)`, 'i'),
    new RegExp(`第\\s*0*${episode}\\s*集`)
  ]
  return files.find((file) => patterns.some((pattern) => pattern.test(basename(file))))
}

export function inferDownloadedPackType(
  media: MediaIdentity,
  declared: SubtitleCandidate['packType'],
  files: string[],
  requestedSeason?: number,
  requestedEpisode?: number
): NonNullable<SubtitleCandidate['packType']> {
  if (media.type === 'movie') return 'movie'
  if (declared === 'season' || declared === 'series') return declared

  const scopes = files.map((file) => episodeScopeFromFilename(basename(file)))
  const seasons = new Set(
    scopes.map((scope) => scope.season).filter((value): value is number => Boolean(value))
  )
  const episodes = new Set(
    scopes.map((scope) => scope.episode).filter((value): value is number => Boolean(value))
  )
  if (seasons.size > 1) return 'series'
  if (episodes.size > 1 || files.length >= 8) return 'season'
  if (declared === 'episode' || requestedEpisode) return 'episode'
  return requestedSeason ? 'season' : 'unknown'
}

function episodeScopeFromFilename(value: string): {
  season?: number
  episode?: number
} {
  const exact =
    value.match(/\bS(\d{1,2})E(\d{1,3})\b/i) ||
    value.match(/\b(\d{1,2})x(\d{1,3})\b/i)
  if (exact) {
    return { season: Number(exact[1]), episode: Number(exact[2]) }
  }
  const chinese = value.match(/第\s*(\d+)\s*季.*第\s*(\d+)\s*集/)
  if (chinese) {
    return { season: Number(chinese[1]), episode: Number(chinese[2]) }
  }
  const episode = value.match(/(?:^|\D)EP?0*(\d{1,3})(?!\d)/i)
  return episode ? { episode: Number(episode[1]) } : {}
}

function aliasesFromSubtitleFiles(files: string[]): string[] {
  const counts = new Map<string, number>()
  for (const file of files) {
    const value = basename(file).replace(/^\d{3}-/, '')
    const match = value.match(/^(.+?)[._\s-]+S\d{1,2}E\d{1,3}\b/i)
    if (!match) continue
    const alias = match[1]
      .replace(/[._]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
    if (alias.length < 3) continue
    counts.set(alias, (counts.get(alias) || 0) + 1)
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1])
    .slice(0, 4)
    .map(([alias]) => alias)
}

async function mapConcurrent<T>(
  values: T[],
  concurrency: number,
  worker: (value: T) => Promise<void>
): Promise<void> {
  let index = 0
  const run = async () => {
    while (index < values.length) {
      const current = values[index++]
      await worker(current)
    }
  }
  const results = await Promise.allSettled(
    Array.from({ length: Math.max(1, Math.min(concurrency, values.length)) }, run)
  )
  const failed = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  )
  if (failed) throw failed.reason
}

function classifyError(error: unknown) {
  const message = safeError(error)
  if (message.includes('storage-not-writable')) return 'storage-not-writable' as const
  if (message.includes('candidate-selection-timeout')) {
    return 'candidate-selection-timeout' as const
  }
  if (message.includes('download-truncated')) return 'download-truncated' as const
  if (
    message.includes('download-rejected') ||
    message.includes('ERR_BLOCKED_BY_CLIENT')
  ) return 'download-rejected' as const
  if (message.includes('episode-not-found')) return 'episode-not-found-in-pack' as const
  if (message.includes('corrupt-archive')) return 'corrupt-archive' as const
  if (message.includes('encrypted-archive')) return 'encrypted-archive' as const
  if (message.includes('archive-tool-missing')) return 'archive-tool-missing' as const
  if (
    message.includes('scene-analysis-failed') &&
    (
      message.includes('ModelScope') ||
      message.includes('has no provider supported') ||
      message.includes('候选模型当前均不可用')
    )
  ) return 'analysis-model-unavailable' as const
  if (
    message.includes('structured-output-invalid') ||
    message.includes('scene-analysis-failed')
  ) return 'invalid-knowledge-json' as const
  if (message.includes('unsupported-archive')) return 'unsupported-archive' as const
  if (message.includes('unsafe-archive')) return 'unsafe-archive' as const
  if (message.includes('encoding-unknown')) return 'encoding-unknown' as const
  return 'processing-failed' as const
}

function isCandidateFallbackError(error: unknown): boolean {
  const message = safeError(error)
  return [
    'download-rejected',
    'download-truncated',
    'corrupt-archive',
    'encrypted-archive',
    'unsupported-archive'
  ].some((code) => message.includes(code))
}

function chooseSourceFailure(
  failures: Array<{
    source: SubtitleSourceId
    outcome: SubtitleSourceOutcome
    diagnostic?: string
  }>
) {
  const priorities: SubtitleSourceOutcome[] = [
    'verification-required',
    'verification-failed',
    'rate-limited',
    'unavailable',
    'layout-changed',
    'download-rejected'
  ]
  return [...failures].sort(
    (left, right) =>
      priorities.indexOf(left.outcome) - priorities.indexOf(right.outcome)
  )[0]
}

function sourceFailureMessage(outcome: SubtitleSourceOutcome): string {
  const messages: Partial<Record<SubtitleSourceOutcome, string>> = {
    'verification-required': '字幕来源需要完成验证码配置。',
    'verification-failed': '字幕来源验证码验证失败。',
    'rate-limited': '字幕来源请求过于频繁，请稍后重试。',
    unavailable: '字幕来源暂时无法连接。',
    'layout-changed': '字幕网站页面结构已经变化。',
    'download-rejected': '字幕来源拒绝了下载请求。'
  }
  return messages[outcome] || '字幕来源暂时不可用。'
}

function formatSourceFailure(failure: {
  source: SubtitleSourceId
  outcome: SubtitleSourceOutcome
  diagnostic?: string
}): string {
  const source = failure.source === 'subhd' ? 'SubHD' : '字幕网'
  return `${source}: ${failure.diagnostic || sourceFailureMessage(failure.outcome)}`
}

const safeError = (error: unknown) =>
  error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500)

const fileScopeHash = (
  packageHash: string,
  season?: number,
  episode?: number
) => createHash('sha256')
  .update(`${packageHash}|${season || 0}|${episode || 0}`)
  .digest('hex')

const packageEntry = (subtitlePackage: SubtitlePackage): SubtitleLibraryEntry => ({
  scopeId: `package:${subtitlePackage.id}`,
  media: subtitlePackage.media,
  packageId: subtitlePackage.id,
  season: subtitlePackage.season,
  episode: subtitlePackage.episode,
  packType: subtitlePackage.packType,
  source: subtitlePackage.source,
  status: 'package',
  byteSize: subtitlePackage.byteSize,
  updatedAt: subtitlePackage.updatedAt,
  linkedConversationIds: []
})

const terminalValue = (value: string) =>
  JSON.stringify(value).replace(/[^\x20-\x7e]/g, (character) =>
    `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
  )

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('cancelled'))
      return
    }
    const timer = setTimeout(resolve, ms)
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer)
        reject(new Error('cancelled'))
      },
      { once: true }
    )
  })
}
