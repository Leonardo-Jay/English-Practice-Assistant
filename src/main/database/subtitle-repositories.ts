import { randomUUID } from 'crypto'
import type Database from 'better-sqlite3'
import type {
  ConversationMediaContext,
  EpisodeKnowledge,
  MediaIdentity,
  MediaContextPhase,
  MediaMentionSuggestion,
  SubtitleCandidate,
  SubtitleDialogueScene,
  SubtitleErrorCode,
  SubtitleJobProgress,
  SubtitleLibraryEntry,
  SubtitleLibrarySummary,
  SubtitlePackage,
  SubtitleWorkflowOrigin
} from '../../shared/types'

type Row = Record<string, unknown>
const text = (value: unknown) => String(value ?? '')
const optionalText = (value: unknown) =>
  value === null || value === undefined || value === '' ? undefined : String(value)
const number = (value: unknown) => Number(value ?? 0)
const optionalNumber = (value: unknown) =>
  value === null || value === undefined ? undefined : Number(value)
const parse = <T>(value: unknown, fallback: T): T => {
  try {
    return JSON.parse(text(value)) as T
  } catch {
    return fallback
  }
}

export class MediaRepository {
  constructor(private readonly db: Database.Database) {}

  upsert(identity: MediaIdentity): MediaIdentity {
    const now = Date.now()
    const candidates = this.db.prepare(`
      SELECT me.*,
        EXISTS(
          SELECT 1 FROM subtitle_packages p
          WHERE p.media_id = me.id AND p.status = 'ready'
        ) AS has_local_package
      FROM media_entities me
      WHERE media_type = ?
        AND COALESCE(release_year, 0) = COALESCE(?, 0)
    `).all(identity.type, identity.year ?? null) as Row[]
    const lookup = normalizeMediaLookup(identity.normalizedTitle || identity.title)
    const exact = candidates.find((row) =>
      normalizeMediaLookup(text(row.normalized_title)) === lookup ||
      parse<string[]>(row.aliases_json, []).some((alias) =>
        normalizeMediaLookup(alias) === lookup
      )
    )
    const fuzzy = uniqueFuzzyLocalMedia(
      exact
        ? candidates.filter((row) => text(row.id) !== text(exact.id))
        : candidates,
      lookup
    )
    const existing =
      exact && Boolean(exact.has_local_package)
        ? exact
        : fuzzy || exact
    if (existing) {
      const stored = this.fromRow(existing)
      const aliases = [...new Set([
        ...stored.aliases,
        ...identity.aliases,
        identity.title !== stored.title ? identity.title : ''
      ].filter(Boolean))]
      this.db.prepare(`
        UPDATE media_entities
        SET aliases_json = ?, release_year = COALESCE(release_year, ?),
          confirmed = MAX(confirmed, ?), updated_at = ?
        WHERE id = ?
      `).run(
        JSON.stringify(aliases),
        identity.year ?? null,
        identity.confirmed ? 1 : 0,
        now,
        stored.id
      )
      return { ...stored, aliases, confirmed: stored.confirmed || identity.confirmed }
    }
    const id = identity.id || randomUUID()
    this.db.prepare(`
      INSERT INTO media_entities(
        id, media_type, title, normalized_title, aliases_json, release_year,
        confirmed, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        title = excluded.title,
        aliases_json = excluded.aliases_json,
        release_year = excluded.release_year,
        confirmed = excluded.confirmed,
        updated_at = excluded.updated_at
    `).run(
      id,
      identity.type,
      identity.title,
      identity.normalizedTitle,
      JSON.stringify(identity.aliases),
      identity.year ?? null,
      identity.confirmed ? 1 : 0,
      now,
      now
    )
    return { ...identity, id }
  }

  addAliases(id: string, aliases: string[]): MediaIdentity | undefined {
    const existing = this.get(id)
    if (!existing) return undefined
    const merged = [...new Set([
      ...existing.aliases,
      ...aliases.map((alias) => alias.trim()).filter(Boolean)
    ])]
    this.db.prepare(`
      UPDATE media_entities SET aliases_json = ?, updated_at = ? WHERE id = ?
    `).run(JSON.stringify(merged), Date.now(), id)
    return { ...existing, aliases: merged }
  }

  get(id: string): MediaIdentity | undefined {
    const row = this.db.prepare('SELECT * FROM media_entities WHERE id = ?').get(id) as
      | Row
      | undefined
    if (!row) return undefined
    return this.fromRow(row)
  }

  private fromRow(row: Row): MediaIdentity {
    return {
      id: text(row.id),
      type: text(row.media_type) as MediaIdentity['type'],
      title: text(row.title),
      normalizedTitle: text(row.normalized_title),
      aliases: parse<string[]>(row.aliases_json, []),
      year: optionalNumber(row.release_year),
      confirmed: Boolean(row.confirmed)
    }
  }
}

function normalizeMediaLookup(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
}

function uniqueFuzzyLocalMedia(rows: Row[], lookup: string): Row | undefined {
  if (lookup.length < 6 || !/[a-z]/i.test(lookup)) return undefined
  const scored = rows
    .filter((row) => Boolean(row.has_local_package))
    .map((row) => {
      const names = [
        text(row.normalized_title),
        ...parse<string[]>(row.aliases_json, [])
      ].map(normalizeMediaLookup)
      const distance = Math.min(
        ...names.map((name) => levenshteinDistance(lookup, name))
      )
      return { row, distance }
    })
    .filter(({ distance }) => distance <= Math.max(1, Math.floor(lookup.length * 0.2)))
    .sort((left, right) => left.distance - right.distance)
  if (!scored.length) return undefined
  if (scored[1]?.distance === scored[0].distance) return undefined
  return scored[0].row
}

function levenshteinDistance(left: string, right: string): number {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index)
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0]
    previous[0] = leftIndex
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = previous[rightIndex]
      previous[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1)
      )
      diagonal = above
    }
  }
  return previous[right.length]
}

export class ConversationMediaRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly media: MediaRepository
  ) {}

  get(conversationId: string): ConversationMediaContext | undefined {
    const row = this.db.prepare(
      'SELECT * FROM conversation_media_contexts WHERE conversation_id = ?'
    ).get(conversationId) as Row | undefined
    if (!row) return undefined
    return {
      conversationId,
      media: row.media_id ? this.media.get(text(row.media_id)) : undefined,
      season: optionalNumber(row.season),
      episode: optionalNumber(row.episode),
      spoilerBoundary: optionalText(row.spoiler_boundary),
      phase: text(row.phase) as MediaContextPhase,
      activeJobId: optionalText(row.active_job_id),
      continueWithoutSubtitles: Boolean(row.continue_without_subtitles),
      errorCode: optionalText(row.error_code) as SubtitleErrorCode | undefined,
      errorMessage: optionalText(row.error_message),
      updatedAt: number(row.updated_at)
    }
  }

  save(context: ConversationMediaContext): void {
    this.db.prepare(`
      INSERT INTO conversation_media_contexts(
        conversation_id, media_id, season, episode, spoiler_boundary, phase,
        active_job_id, continue_without_subtitles, error_code, error_message, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id) DO UPDATE SET
        media_id = excluded.media_id,
        season = excluded.season,
        episode = excluded.episode,
        spoiler_boundary = excluded.spoiler_boundary,
        phase = excluded.phase,
        active_job_id = excluded.active_job_id,
        continue_without_subtitles = excluded.continue_without_subtitles,
        error_code = excluded.error_code,
        error_message = excluded.error_message,
        updated_at = excluded.updated_at
    `).run(
      context.conversationId,
      context.media?.id ?? null,
      context.season ?? null,
      context.episode ?? null,
      context.spoilerBoundary ?? null,
      context.phase,
      context.activeJobId ?? null,
      context.continueWithoutSubtitles ? 1 : 0,
      context.errorCode ?? null,
      context.errorMessage ?? null,
      context.updatedAt
    )
  }

  clear(conversationId: string): void {
    this.db.prepare(
      'DELETE FROM conversation_media_contexts WHERE conversation_id = ?'
    ).run(conversationId)
  }
}

export class SubtitleJobRepository {
  constructor(private readonly db: Database.Database) {}

  create(
    mediaId: string,
    season?: number,
    episode?: number,
    workflow?: {
      origin: SubtitleWorkflowOrigin
      conversationId?: string
      mentionId?: string
      packageId?: string
      requestId?: string
    }
  ): string {
    const id = randomUUID()
    const now = Date.now()
    this.db.prepare(`
      INSERT INTO subtitle_jobs(
        id, media_id, season, episode, phase, origin, conversation_id,
        mention_id, package_id, request_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      mediaId,
      season ?? null,
      episode ?? null,
      workflow?.origin || 'chat',
      workflow?.conversationId ?? null,
      workflow?.mentionId ?? null,
      workflow?.packageId ?? null,
      workflow?.requestId ?? null,
      now,
      now
    )
    return id
  }

  findReusable(mediaId: string, season?: number, episode?: number): string | undefined {
    const row = this.db.prepare(`
      SELECT id FROM subtitle_jobs
      WHERE media_id = ?
        AND COALESCE(season, 0) = COALESCE(?, 0)
        AND COALESCE(episode, 0) = COALESCE(?, 0)
        AND phase NOT IN ('failed', 'cancelled')
      ORDER BY updated_at DESC LIMIT 1
    `).get(mediaId, season ?? null, episode ?? null) as Row | undefined
    return row ? text(row.id) : undefined
  }

  update(progress: SubtitleJobProgress, candidates?: SubtitleCandidate[]): void {
    this.db.prepare(`
      UPDATE subtitle_jobs SET
        phase = ?, source = COALESCE(?, source),
        candidates_json = COALESCE(?, candidates_json),
        progress_received = ?, progress_total = ?,
        error_code = ?, error_detail = ?, updated_at = ?
      WHERE id = ?
    `).run(
      progress.phase,
      progress.source ?? null,
      candidates ? JSON.stringify(candidates) : null,
      progress.receivedBytes ?? null,
      progress.totalBytes ?? null,
      progress.errorCode ?? null,
      progress.diagnostic ?? null,
      progress.updatedAt,
      progress.jobId
    )
  }

  getProgress(jobId: string): SubtitleJobProgress | undefined {
    const row = this.db.prepare(
      'SELECT * FROM subtitle_jobs WHERE id = ?'
    ).get(jobId) as Row | undefined
    if (!row) return undefined
    const received = optionalNumber(row.progress_received)
    const total = optionalNumber(row.progress_total)
    return {
      jobId: text(row.id),
      conversationId: optionalText(row.conversation_id),
      requestId: optionalText(row.request_id),
      origin: (optionalText(row.origin) || 'chat') as SubtitleWorkflowOrigin,
      phase: text(row.phase) as SubtitleJobProgress['phase'],
      source: optionalText(row.source) as SubtitleJobProgress['source'],
      receivedBytes: received,
      totalBytes: total,
      percent:
        received !== undefined && total
          ? Math.round((received / total) * 100)
          : undefined,
      message: jobPhaseMessage(text(row.phase)),
      candidates: parse<SubtitleCandidate[]>(row.candidates_json, []),
      errorCode: optionalText(row.error_code) as SubtitleErrorCode | undefined,
      diagnostic: optionalText(row.error_detail),
      updatedAt: number(row.updated_at)
    }
  }

  markInterruptedRetryable(): void {
    this.db.prepare(`
      UPDATE subtitle_jobs SET
        phase = 'failed',
        error_code = 'processing-failed',
        error_detail = '应用在任务执行期间退出，可安全重试。',
        updated_at = ?
      WHERE phase IN ('searching', 'verifying', 'downloading', 'extracting', 'processing')
    `).run(Date.now())
  }
}

export class SubtitleKnowledgeRepository {
  constructor(private readonly db: Database.Database) {}

  listScenes(assetId: string): SubtitleDialogueScene[] {
    const rows = this.db.prepare(`
      SELECT * FROM subtitle_scenes
      WHERE asset_id = ?
      ORDER BY ordinal
    `).all(assetId) as Row[]
    return rows.map((row) => ({
      id: text(row.id),
      ordinal: number(row.ordinal),
      startMs: number(row.start_ms),
      endMs: number(row.end_ms),
      dialogue: text(row.dialogue),
      analysis: row.analysis_json
        ? parse(row.analysis_json, undefined)
        : undefined
    }))
  }

  replaceScenes(assetId: string, scenes: SubtitleDialogueScene[]): void {
    const transaction = this.db.transaction(() => {
      const existing = this.db.prepare(
        'SELECT id FROM subtitle_scenes WHERE asset_id = ?'
      ).all(assetId) as Row[]
      for (const row of existing) {
        this.db.prepare('DELETE FROM subtitle_scenes_fts WHERE scene_id = ?').run(text(row.id))
      }
      this.db.prepare('DELETE FROM subtitle_scenes WHERE asset_id = ?').run(assetId)
      const insert = this.db.prepare(`
        INSERT INTO subtitle_scenes(
          id, asset_id, ordinal, start_ms, end_ms, dialogue, analysis_json,
          status, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      const insertFts = this.db.prepare(
        'INSERT INTO subtitle_scenes_fts(scene_id, dialogue, analysis) VALUES (?, ?, ?)'
      )
      for (const scene of scenes) {
        const analysisJson = scene.analysis ? JSON.stringify(scene.analysis) : ''
        insert.run(
          scene.id,
          assetId,
          scene.ordinal,
          scene.startMs,
          scene.endMs,
          scene.dialogue,
          analysisJson || null,
          scene.analysis ? 'complete' : 'pending',
          Date.now()
        )
        insertFts.run(scene.id, scene.dialogue, analysisJson)
      }
    })
    transaction()
  }

  saveSceneAnalysis(
    assetId: string,
    scene: SubtitleDialogueScene
  ): void {
    if (!scene.analysis) return
    const analysisJson = JSON.stringify(scene.analysis)
    const transaction = this.db.transaction(() => {
      this.db.prepare(`
        UPDATE subtitle_scenes
        SET analysis_json = ?, status = 'complete', error_detail = NULL,
          updated_at = ?
        WHERE asset_id = ? AND ordinal = ?
      `).run(analysisJson, Date.now(), assetId, scene.ordinal)
      this.db.prepare(
        'DELETE FROM subtitle_scenes_fts WHERE scene_id = ?'
      ).run(scene.id)
      this.db.prepare(`
        INSERT INTO subtitle_scenes_fts(scene_id, dialogue, analysis)
        VALUES (?, ?, ?)
      `).run(scene.id, scene.dialogue, analysisJson)
    })
    transaction()
  }

  saveSceneFailure(
    assetId: string,
    scene: SubtitleDialogueScene,
    diagnostic: string
  ): void {
    this.db.prepare(`
      UPDATE subtitle_scenes
      SET status = 'failed', error_detail = ?, updated_at = ?
      WHERE asset_id = ? AND ordinal = ?
    `).run(diagnostic.slice(0, 500), Date.now(), assetId, scene.ordinal)
  }

  search(assetId: string, query: string, limit = 4): SubtitleDialogueScene[] {
    const normalized = query
      .replace(/[^\p{L}\p{N}\s'-]+/gu, ' ')
      .split(/\s+/)
      .filter((term) => term.length > 1)
      .slice(0, 8)
      .map((term) => `"${term.replace(/"/g, '""')}"`)
      .join(' OR ')
    if (!normalized) return []
    const rows = this.db.prepare(`
      SELECT s.* FROM subtitle_scenes_fts
      JOIN subtitle_scenes s ON s.id = subtitle_scenes_fts.scene_id
      WHERE subtitle_scenes_fts MATCH ? AND s.asset_id = ?
      ORDER BY bm25(subtitle_scenes_fts)
      LIMIT ?
    `).all(normalized, assetId, Math.max(1, Math.min(limit, 8))) as Row[]
    return rows.map((row) => ({
      id: text(row.id),
      ordinal: number(row.ordinal),
      startMs: number(row.start_ms),
      endMs: number(row.end_ms),
      dialogue: text(row.dialogue),
      analysis: row.analysis_json
        ? parse(row.analysis_json, undefined)
        : undefined
    }))
  }

  saveKnowledge(
    assetId: string,
    knowledge: EpisodeKnowledge,
    model: string,
    cleanerVersion: number,
    scenePromptVersion: number,
    mergePromptVersion: number
  ): void {
    this.db.prepare(`
      INSERT INTO episode_knowledge(
        id, asset_id, knowledge_json, model, cleaner_version,
        scene_prompt_version, merge_prompt_version, status, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'ready', ?)
      ON CONFLICT(asset_id, cleaner_version, scene_prompt_version, merge_prompt_version)
      DO UPDATE SET knowledge_json = excluded.knowledge_json,
        model = excluded.model, status = 'ready', error_detail = NULL,
        updated_at = excluded.updated_at
    `).run(
      randomUUID(),
      assetId,
      JSON.stringify(knowledge),
      model,
      cleanerVersion,
      scenePromptVersion,
      mergePromptVersion,
      Date.now()
    )
  }
}

export class MediaMentionRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly media: MediaRepository
  ) {}

  save(input: {
    id?: string
    conversationId: string
    messageId: string
    media: MediaIdentity
    season?: number
    episode?: number
    evidenceText: string
    confidence: number
  }): MediaMentionSuggestion {
    const identity = this.media.upsert(input.media)
    const existing = this.db.prepare(`
      SELECT id, status, created_at FROM media_mentions
      WHERE conversation_id = ? AND media_id = ?
        AND COALESCE(season, 0) = COALESCE(?, 0)
        AND COALESCE(episode, 0) = COALESCE(?, 0)
      ORDER BY updated_at DESC LIMIT 1
    `).get(
      input.conversationId,
      identity.id,
      input.season ?? null,
      input.episode ?? null
    ) as Row | undefined
    if (existing && text(existing.status) === 'dismissed') {
      return this.map(existing, identity, input)
    }
    const id = existing ? text(existing.id) : input.id || randomUUID()
    const now = Date.now()
    this.db.prepare(`
      INSERT INTO media_mentions(
        id, conversation_id, message_id, media_id, season, episode,
        evidence_text, confidence, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        message_id = excluded.message_id,
        evidence_text = excluded.evidence_text,
        confidence = excluded.confidence,
        updated_at = excluded.updated_at
    `).run(
      id,
      input.conversationId,
      input.messageId,
      identity.id,
      input.season ?? null,
      input.episode ?? null,
      input.evidenceText,
      input.confidence,
      now,
      now
    )
    return this.get(id)!
  }

  get(id: string): MediaMentionSuggestion | undefined {
    const row = this.db.prepare(`
      SELECT mm.* FROM media_mentions mm WHERE mm.id = ?
    `).get(id) as Row | undefined
    return row ? this.fromRow(row) : undefined
  }

  list(conversationId: string): MediaMentionSuggestion[] {
    const rows = this.db.prepare(`
      SELECT * FROM media_mentions
      WHERE conversation_id = ?
      ORDER BY updated_at DESC
    `).all(conversationId) as Row[]
    const deduplicated = new Map<string, MediaMentionSuggestion>()
    for (const row of rows) {
      const suggestion = this.fromRow(row)
      const key = [
        suggestion.media.id,
        suggestion.season || 0,
        suggestion.episode || 0
      ].join('|')
      if (!deduplicated.has(key)) deduplicated.set(key, suggestion)
    }
    return [...deduplicated.values()]
  }

  setStatus(id: string, status: MediaMentionSuggestion['status']): void {
    this.db.prepare(
      'UPDATE media_mentions SET status = ?, updated_at = ? WHERE id = ?'
    ).run(status, Date.now(), id)
  }

  private fromRow(row: Row): MediaMentionSuggestion {
    const storedIdentity = this.media.get(text(row.media_id))!
    const identity = this.media.upsert(storedIdentity)
    return {
      id: text(row.id),
      conversationId: text(row.conversation_id),
      messageId: text(row.message_id),
      media: identity,
      season: optionalNumber(row.season),
      episode: optionalNumber(row.episode),
      evidenceText: text(row.evidence_text),
      confidence: Number(row.confidence || 0),
      status: text(row.status) as MediaMentionSuggestion['status'],
      availability: this.availability(
        identity.id!,
        optionalNumber(row.season),
        optionalNumber(row.episode)
      ),
      createdAt: number(row.created_at),
      updatedAt: number(row.updated_at)
    }
  }

  private availability(
    mediaId: string,
    season?: number,
    episode?: number
  ): MediaMentionSuggestion['availability'] {
    if (episode !== undefined) {
      const ready = this.db.prepare(`
        SELECT 1 FROM subtitle_assets a
        JOIN episode_knowledge k ON k.asset_id = a.id AND k.status = 'ready'
        WHERE a.media_id = ?
          AND COALESCE(a.season, 0) = COALESCE(?, 0)
          AND COALESCE(a.episode, 0) = COALESCE(?, 0)
          AND a.status = 'ready' LIMIT 1
      `).get(mediaId, season ?? null, episode)
      if (ready) return 'ready'
    }
    const subtitlePackage = this.db.prepare(`
      SELECT 1 FROM subtitle_packages
      WHERE media_id = ? AND status = 'ready'
        AND (
          pack_type = 'series'
          OR (
            COALESCE(season, 0) = COALESCE(?, 0)
            AND (
              episode IS NULL OR COALESCE(episode, 0) = COALESCE(?, 0)
            )
          )
        )
      LIMIT 1
    `).get(mediaId, season ?? null, episode ?? null)
    return subtitlePackage ? 'package' : 'missing'
  }

  private map(
    existing: Row,
    media: MediaIdentity,
    input: {
      conversationId: string
      messageId: string
      season?: number
      episode?: number
      evidenceText: string
      confidence: number
    }
  ): MediaMentionSuggestion {
    return {
      id: text(existing.id),
      conversationId: input.conversationId,
      messageId: input.messageId,
      media,
      season: input.season,
      episode: input.episode,
      evidenceText: input.evidenceText,
      confidence: input.confidence,
      status: text(existing.status) as MediaMentionSuggestion['status'],
      availability: this.availability(media.id!, input.season, input.episode),
      createdAt: number(existing.created_at),
      updatedAt: number(existing.created_at)
    }
  }
}

export class SubtitleLibraryRepository {
  constructor(
    private readonly db: Database.Database,
    private readonly media: MediaRepository
  ) {}

  savePackage(input: {
    mediaId: string
    season?: number
    episode?: number
    packType?: SubtitleCandidate['packType']
    source: SubtitleCandidate['source']
    sourcePageUrl?: string
    candidate?: SubtitleCandidate
    rawRelativePath: string
    manifestRelativePaths: string[]
    sha256: string
    byteSize: number
  }): string {
    const existing = this.db.prepare(`
      SELECT id FROM subtitle_packages
      WHERE media_id = ? AND COALESCE(season, 0) = COALESCE(?, 0)
        AND COALESCE(episode, 0) = COALESCE(?, 0) AND sha256 = ?
    `).get(
      input.mediaId,
      input.season ?? null,
      input.episode ?? null,
      input.sha256
    ) as Row | undefined
    const id = existing ? text(existing.id) : randomUUID()
    const now = Date.now()
    this.db.prepare(`
      INSERT INTO subtitle_packages(
        id, media_id, season, episode, pack_type, source, source_page_url,
        candidate_json, relative_raw_path, manifest_json, sha256, byte_size,
        status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ready', ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        season = excluded.season,
        episode = excluded.episode,
        pack_type = excluded.pack_type,
        source = excluded.source,
        source_page_url = excluded.source_page_url,
        candidate_json = excluded.candidate_json,
        relative_raw_path = excluded.relative_raw_path,
        manifest_json = excluded.manifest_json,
        sha256 = excluded.sha256,
        byte_size = excluded.byte_size,
        status = 'ready', error_detail = NULL, updated_at = excluded.updated_at
    `).run(
      id,
      input.mediaId,
      input.season ?? null,
      input.episode ?? null,
      input.packType || 'unknown',
      input.source,
      input.sourcePageUrl ?? null,
      input.candidate ? JSON.stringify(input.candidate) : null,
      input.rawRelativePath,
      JSON.stringify(input.manifestRelativePaths),
      input.sha256,
      input.byteSize,
      now,
      now
    )
    return id
  }

  getPackage(id: string): SubtitlePackage | undefined {
    const row = this.db.prepare(
      'SELECT * FROM subtitle_packages WHERE id = ?'
    ).get(id) as Row | undefined
    return row ? this.packageFromRow(row) : undefined
  }

  findReusablePackage(
    mediaId: string,
    season?: number,
    episode?: number
  ): SubtitlePackage | undefined {
    const row = this.db.prepare(`
      SELECT * FROM subtitle_packages
      WHERE media_id = ? AND status = 'ready'
        AND (
          pack_type = 'series'
          OR (
            COALESCE(season, 0) = COALESCE(?, 0)
            AND (
              COALESCE(episode, 0) = COALESCE(?, 0)
              OR (episode IS NULL AND pack_type = 'season')
            )
          )
        )
      ORDER BY
        CASE
          WHEN COALESCE(season, 0) = COALESCE(?, 0)
            AND COALESCE(episode, 0) = COALESCE(?, 0) THEN 0
          WHEN pack_type = 'season'
            AND COALESCE(season, 0) = COALESCE(?, 0) THEN 1
          WHEN pack_type = 'series' THEN 2
          ELSE 3
        END,
        updated_at DESC
      LIMIT 1
    `).get(
      mediaId,
      season ?? null,
      episode ?? null,
      season ?? null,
      episode ?? null,
      season ?? null
    ) as Row | undefined
    return row ? this.packageFromRow(row) : undefined
  }

  findReadyEntry(
    mediaId: string,
    season?: number,
    episode?: number
  ): SubtitleLibraryEntry | undefined {
    const row = this.db.prepare(`
      SELECT a.id AS asset_id, a.package_id, a.media_id, a.season, a.episode,
        a.source, a.byte_size, a.status, a.updated_at, p.pack_type
      FROM subtitle_assets a
      JOIN episode_knowledge k ON k.asset_id = a.id AND k.status = 'ready'
      LEFT JOIN subtitle_packages p ON p.id = a.package_id
      WHERE a.media_id = ?
        AND COALESCE(a.season, 0) = COALESCE(?, 0)
        AND COALESCE(a.episode, 0) = COALESCE(?, 0)
        AND a.status = 'ready'
      ORDER BY a.updated_at DESC LIMIT 1
    `).get(mediaId, season ?? null, episode ?? null) as Row | undefined
    return row ? this.entryFromAssetRow(row) : undefined
  }

  list(): SubtitleLibrarySummary {
    const assetRows = this.db.prepare(`
      SELECT a.id AS asset_id, a.package_id, a.media_id, a.season, a.episode,
        a.source, a.byte_size, a.status, a.updated_at, p.pack_type,
        GROUP_CONCAT(l.conversation_id) AS linked_conversations
      FROM subtitle_assets a
      LEFT JOIN subtitle_packages p ON p.id = a.package_id
      LEFT JOIN conversation_media_links l ON l.asset_id = a.id AND l.enabled = 1
      GROUP BY a.id
      ORDER BY a.updated_at DESC
    `).all() as Row[]
    const packageRows = this.db.prepare(`
      SELECT p.* FROM subtitle_packages p
      WHERE p.status = 'ready' AND (
        p.pack_type IN ('season', 'series')
        OR NOT EXISTS(
          SELECT 1 FROM subtitle_assets a WHERE a.package_id = p.id
        )
      )
      ORDER BY p.updated_at DESC
    `).all() as Row[]
    const entries = [
      ...assetRows.map((row) => this.entryFromAssetRow(row)),
      ...packageRows.map((row): SubtitleLibraryEntry => ({
        scopeId: `package:${text(row.id)}`,
        media: this.media.get(text(row.media_id))!,
        packageId: text(row.id),
        season: optionalNumber(row.season),
        episode: optionalNumber(row.episode),
        packType: text(row.pack_type) as SubtitleCandidate['packType'],
        source: text(row.source) as SubtitleCandidate['source'],
        status: 'package',
        byteSize: number(row.byte_size),
        updatedAt: number(row.updated_at),
        linkedConversationIds: []
      }))
    ]
    const works = new Set(entries.map((entry) => entry.media.id)).size
    return {
      works,
      packages: number(
        (this.db.prepare(
          "SELECT COUNT(*) AS count FROM subtitle_packages WHERE status = 'ready'"
        ).get() as Row).count
      ),
      processedScopes: assetRows.filter((row) => text(row.status) === 'ready').length,
      cacheBytes: number(
        (this.db.prepare(
          "SELECT COALESCE(SUM(byte_size), 0) AS bytes FROM subtitle_packages WHERE status = 'ready'"
        ).get() as Row).bytes
      ),
      entries
    }
  }

  link(conversationId: string, assetId: string): void {
    const now = Date.now()
    this.db.prepare(`
      INSERT INTO conversation_media_links(
        conversation_id, asset_id, enabled, created_at, updated_at
      ) VALUES (?, ?, 1, ?, ?)
      ON CONFLICT(conversation_id, asset_id) DO UPDATE SET
        enabled = 1, updated_at = excluded.updated_at
    `).run(conversationId, assetId, now, now)
  }

  unlink(conversationId: string, assetId: string): void {
    this.db.prepare(`
      UPDATE conversation_media_links
      SET enabled = 0, updated_at = ?
      WHERE conversation_id = ? AND asset_id = ?
    `).run(Date.now(), conversationId, assetId)
  }

  linkedAssets(conversationId: string): Array<{
    entry: SubtitleLibraryEntry
    knowledge: EpisodeKnowledge
  }> {
    const rows = this.db.prepare(`
      SELECT a.id AS asset_id, a.package_id, a.media_id, a.season, a.episode,
        a.source, a.byte_size, a.status, a.updated_at, p.pack_type,
        k.knowledge_json
      FROM conversation_media_links l
      JOIN subtitle_assets a ON a.id = l.asset_id AND a.status = 'ready'
      JOIN episode_knowledge k ON k.asset_id = a.id AND k.status = 'ready'
      LEFT JOIN subtitle_packages p ON p.id = a.package_id
      WHERE l.conversation_id = ? AND l.enabled = 1
      ORDER BY l.updated_at DESC
    `).all(conversationId) as Row[]
    return rows.map((row) => ({
      entry: this.entryFromAssetRow(row),
      knowledge: parse<EpisodeKnowledge>(row.knowledge_json, {} as EpisodeKnowledge)
    }))
  }

  deleteScope(scopeId: string): void {
    if (scopeId.startsWith('package:')) {
      this.db.prepare('DELETE FROM subtitle_packages WHERE id = ?')
        .run(scopeId.slice('package:'.length))
      return
    }
    this.db.prepare('DELETE FROM subtitle_assets WHERE id = ?').run(scopeId)
  }

  private packageFromRow(row: Row): SubtitlePackage {
    return {
      id: text(row.id),
      media: this.media.get(text(row.media_id))!,
      season: optionalNumber(row.season),
      episode: optionalNumber(row.episode),
      packType: text(row.pack_type) as SubtitleCandidate['packType'],
      source: text(row.source) as SubtitleCandidate['source'],
      rawRelativePath: text(row.relative_raw_path),
      manifestRelativePaths: parse<string[]>(row.manifest_json, []),
      sha256: text(row.sha256),
      byteSize: number(row.byte_size),
      status: text(row.status) === 'ready' ? 'ready' : 'failed',
      createdAt: number(row.created_at),
      updatedAt: number(row.updated_at)
    }
  }

  private entryFromAssetRow(row: Row): SubtitleLibraryEntry {
    return {
      scopeId: text(row.asset_id),
      assetId: text(row.asset_id),
      packageId: optionalText(row.package_id),
      media: this.media.get(text(row.media_id))!,
      season: optionalNumber(row.season),
      episode: optionalNumber(row.episode),
      packType: optionalText(row.pack_type) as SubtitleCandidate['packType'],
      source: optionalText(row.source) as SubtitleCandidate['source'],
      status: text(row.status) === 'ready' ? 'ready' : 'processing',
      byteSize: number(row.byte_size),
      updatedAt: number(row.updated_at),
      linkedConversationIds: optionalText(row.linked_conversations)
        ?.split(',')
        .filter(Boolean) || []
    }
  }
}

function jobPhaseMessage(phase: string): string {
  const messages: Record<string, string> = {
    confirmed: '准备开始搜索',
    searching: '正在搜索匹配字幕',
    'awaiting-candidate-selection': '等待选择字幕',
    verifying: '正在验证字幕来源',
    downloading: '正在下载字幕',
    extracting: '正在本地解压',
    processing: '正在生成剧情知识',
    ready: '字幕剧情知识已就绪',
    failed: '字幕任务失败',
    cancelled: '字幕任务已取消'
  }
  return messages[phase] || phase
}
