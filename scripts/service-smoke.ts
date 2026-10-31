import { app } from 'electron'
import Database from 'better-sqlite3'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from 'fs'
import { join, resolve } from 'path'
import type {
  Correction,
  CorrectionContext,
  Message,
  ReviewAgentResult,
  VocabularyInsight
} from '../src/shared/types'
import { DatabaseService } from '../src/main/database/database-service'
import { ReviewPracticeRepository, ReviewRepository } from '../src/main/database/repositories'
import {
  MediaRepository,
  SubtitleLibraryRepository
} from '../src/main/database/subtitle-repositories'
import { ConversationService } from '../src/main/services/conversation-service'
import { ReviewService } from '../src/main/services/review-service'
import { SubtitleService } from '../src/main/subtitles/subtitle-service'
import { SubtitleStorage } from '../src/main/subtitles/storage'
import { createDefaultSubtitleFeatureConfig } from '../src/main/subtitles/feature-config'
import AdmZip from 'adm-zip'
import type { LLMClient } from '../src/main/services/llm-client'

class MockLlm {
  lastContext: Message[] = []
  lastCorrectionContext?: CorrectionContext
  summaryCalls = 0
  reviewCalls = 0
  summarizeShouldFail = false
  reviewShouldFail = false
  correctionBarrier?: Promise<void>
  reviewBarrier?: Promise<void>
  reviewResult: ReviewAgentResult = {
    summary: '测试会话总结',
    topics: ['电影'],
    strengths: ['能够主动表达观点'],
    priorities: ['继续练习自然表达'],
    expressions: [],
    selectedCorrections: []
  }

  async chatReply(messages: Message[]): Promise<string> {
    this.lastContext = messages
    return `Mock reply ${messages.length}`
  }

  async summarizeContext(_previous: string, messages: Message[]): Promise<string> {
    this.summaryCalls += 1
    if (this.summarizeShouldFail) throw new Error('mock summary failure')
    return `summary:${messages.length}`
  }

  async analyzeCorrections(
    _input: string,
    context?: CorrectionContext
  ): Promise<Correction[]> {
    this.lastCorrectionContext = context
    await this.correctionBarrier
    return [{
      original: 'I very like it',
      corrected: 'I like it very much',
      type: 'expression',
      scope: 'sentence',
      sentenceIndex: 0,
      explanation: 'very 不能直接修饰 like。'
    }]
  }

  async analyzeVocabulary(_input: string): Promise<VocabularyInsight[]> {
    return [{
      term: 'Mock reply',
      partOfSpeech: '短语',
      chineseMeaning: '模拟回复'
    }]
  }

  async generateLearningReview(): Promise<ReviewAgentResult> {
    this.reviewCalls += 1
    await this.reviewBarrier
    if (this.reviewShouldFail) throw new Error('mock review failure')
    return this.reviewResult
  }

  async evaluateReviewAnswer() {
    return {
      level: 'strong' as const,
      score: 94,
      feedback: '表达清楚自然。',
      strengths: ['完整表达了原意'],
      improvements: [],
      suggestedGrade: 'good' as const
    }
  }
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

app.whenReady().then(async () => {
  const tempBase = resolve(app.getPath('temp'))
  const root = resolve(join(tempBase, `english-practice-service-smoke-${process.pid}`))
  if (!root.startsWith(`${tempBase}\\`) && !root.startsWith(`${tempBase}/`)) {
    throw new Error(`Unsafe smoke-test path: ${root}`)
  }

  const llm = new MockLlm()
  let database = new DatabaseService(root)
  try {
    const legacyRoot = join(root, 'legacy')
    const legacyData = join(legacyRoot, 'data')
    mkdirSync(legacyData, { recursive: true })
    const legacyPath = join(legacyData, 'learning.db')
    const legacy = new Database(legacyPath)
    legacy.exec('CREATE TABLE legacy_marker(value TEXT NOT NULL)')
    legacy.prepare('INSERT INTO legacy_marker(value) VALUES (?)').run('keep-me')
    legacy.close()
    const migrated = new DatabaseService(legacyRoot)
    migrated.initialize()
    assert(
      migrated.connection.prepare('SELECT value FROM legacy_marker').pluck().get() ===
        'keep-me',
      'Migration did not preserve legacy data.'
    )
    assert(
      readdirSync(join(legacyData, 'backups')).some((name) => name.endsWith('.bak')),
      'Migration backup was not created.'
    )
    assert(
      Number(migrated.connection.pragma('user_version', { simple: true })) === 8,
      'Database was not migrated to schema v8.'
    )
    const correctionColumns = migrated.connection
      .prepare("PRAGMA table_info('corrections')")
      .all() as Array<{ name: string }>
    assert(
      correctionColumns.some((column) => column.name === 'scope') &&
        correctionColumns.some((column) => column.name === 'sentence_index'),
      'Contextual correction columns are missing after migration.'
    )
    const reviewSelectionColumns = migrated.connection
      .prepare("PRAGMA table_info('review_correction_selections')")
      .all() as Array<{ name: string }>
    assert(
      reviewSelectionColumns.some(
        (column) => column.name === 'corrected_meaning_zh'
      ),
      'Review correction translation column is missing after migration.'
    )
    for (const table of [
      'media_mentions',
      'subtitle_packages',
      'conversation_media_links'
    ]) {
      assert(
        Boolean(
          migrated.connection.prepare(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
          ).get(table)
        ),
        `Subtitle knowledge-library table is missing: ${table}`
      )
    }
    let foreignKeyRejected = false
    try {
      migrated.connection.prepare(`
        INSERT INTO messages(
          id, conversation_id, sequence, role, content, input_mode, status, created_at
        ) VALUES ('orphan', 'missing', 1, 'user', 'x', 'text', 'complete', 1)
      `).run()
    } catch {
      foreignKeyRejected = true
    }
    assert(foreignKeyRejected, 'Foreign-key protection is not active.')
    migrated.close()

    const v1Root = join(root, 'schema-v1')
    const v1Data = join(v1Root, 'data')
    mkdirSync(v1Data, { recursive: true })
    const v1Path = join(v1Data, 'learning.db')
    const v1 = new Database(v1Path)
    v1.exec(`
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        applied_at INTEGER NOT NULL
      );
      CREATE TABLE conversations (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL
      );
      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE
      );
      CREATE TABLE corrections (
        id TEXT PRIMARY KEY,
        user_message_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        type TEXT NOT NULL,
        original TEXT NOT NULL,
        corrected TEXT NOT NULL,
        explanation_zh TEXT NOT NULL,
        learning_value INTEGER
      );
      CREATE TABLE review_correction_selections (
        review_id TEXT NOT NULL,
        correction_id TEXT NOT NULL,
        ordinal INTEGER NOT NULL,
        reason_zh TEXT NOT NULL,
        PRIMARY KEY(review_id, correction_id)
      );
      INSERT INTO corrections(
        id, user_message_id, ordinal, type, original, corrected,
        explanation_zh, learning_value
      ) VALUES (
        'legacy-correction', 'legacy-user', 0, 'grammar',
        'he go', 'he goes', '旧纠错', NULL
      );
      PRAGMA user_version = 1;
    `)
    v1.close()
    const upgradedV1 = new DatabaseService(v1Root)
    try {
      upgradedV1.initialize()
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n` +
        `${upgradedV1.getStatus().diagnostic || ''}`
      )
    }
    const legacyCorrection = upgradedV1.connection
      .prepare(
        "SELECT scope, sentence_index FROM corrections WHERE id = 'legacy-correction'"
      )
      .get() as { scope: string; sentence_index: number | null }
    assert(
      legacyCorrection.scope === 'span' &&
        legacyCorrection.sentence_index === null,
      'Schema v1 correction did not receive compatible defaults.'
    )
    let invalidScopeRejected = false
    try {
      upgradedV1.connection
        .prepare(
          "UPDATE corrections SET scope = 'invalid' WHERE id = 'legacy-correction'"
        )
        .run()
    } catch {
      invalidScopeRejected = true
    }
    assert(invalidScopeRejected, 'Invalid correction scope was not rejected.')
    upgradedV1.close()

    const corruptRoot = join(root, 'corrupt')
    const corruptData = join(corruptRoot, 'data')
    mkdirSync(corruptData, { recursive: true })
    const corruptPath = join(corruptData, 'learning.db')
    const corruptBytes = Buffer.from('not-a-sqlite-database')
    writeFileSync(corruptPath, corruptBytes)
    let corruptRejected = false
    try {
      new DatabaseService(corruptRoot).initialize()
    } catch {
      corruptRejected = true
    }
    assert(corruptRejected, 'Corrupt database was not rejected.')
    assert(
      readFileSync(corruptPath).equals(corruptBytes),
      'Corrupt database was overwritten instead of preserved.'
    )

    database.initialize()
    const mediaRepository = new MediaRepository(database.connection)
    const localMedia = mediaRepository.upsert({
      type: 'tv',
      title: '妙警贼探',
      normalizedTitle: '妙警贼探',
      aliases: [],
      confirmed: true
    })
    const subtitleLibrary = new SubtitleLibraryRepository(
      database.connection,
      mediaRepository
    )
    subtitleLibrary.savePackage({
      mediaId: localMedia.id!,
      packType: 'series',
      source: 'subhd',
      rawRelativePath: '妙警贼探/series/raw/package.rar',
      manifestRelativePaths: ['妙警贼探/series/files/White.Collar.S01E07.ass'],
      sha256: 'series-smoke-hash',
      byteSize: 100
    })
    mediaRepository.addAliases(localMedia.id!, ['White Collar'])
    const typoResolved = mediaRepository.upsert({
      type: 'tv',
      title: 'white color',
      normalizedTitle: 'white color',
      aliases: ['white color'],
      confirmed: true
    })
    assert(
      typoResolved.id === localMedia.id,
      'A speech-recognition title near-miss did not resolve to local media.'
    )
    assert(
      subtitleLibrary.findReusablePackage(localMedia.id!, 1, 7)?.packType ===
        'series',
      'A whole-series package was not reusable for a requested episode.'
    )
    let service = new ConversationService(
      database.connection,
      llm as unknown as LLMClient,
      () => undefined
    )
    const first = await service.send({
      clientRequestId: 'request-1',
      content: 'I very like it',
      inputMode: 'voice'
    })
    await service.analyzeCorrections(
      first.conversationId,
      first.userMessageId,
      'I very like it'
    )
    await service.analyzeVocabulary(
      first.conversationId,
      first.assistantMessageId,
      first.reply
    )
    const firstDetail = service.get(first.conversationId)
    assert(firstDetail?.messages.length === 2, 'First turn was not persisted.')
    assert(firstDetail.messages[0].corrections?.length === 1, 'Correction was not attached.')
    assert(
      firstDetail.messages[0].corrections?.[0]?.scope === 'sentence' &&
        firstDetail.messages[0].corrections?.[0]?.sentenceIndex === 0,
      'Contextual correction fields were not persisted.'
    )
    assert(
      llm.lastCorrectionContext?.targetText === 'I very like it' &&
        llm.lastCorrectionContext.previousMessages.length === 0,
      'First-message correction context was not assembled.'
    )
    assert(firstDetail.messages[1].vocabulary?.length === 1, 'Vocabulary was not attached.')
    assert(firstDetail.contentRevision === 2, 'Content revision did not track the first turn.')
    assert(firstDetail.analysisRevision === 2, 'Analysis revision did not track both analyses.')

    const duplicate = await service.send({
      conversationId: first.conversationId,
      clientRequestId: 'request-1',
      content: 'I very like it',
      inputMode: 'voice'
    })
    assert(
      duplicate.assistantMessageId === first.assistantMessageId,
      'Idempotent request created a duplicate reply.'
    )
    assert(
      service.get(first.conversationId)?.messages.length === 2,
      'Idempotent request changed the message count.'
    )

    const second = await service.send({
      clientRequestId: 'second-conversation-request',
      content: 'This conversation must stay isolated',
      inputMode: 'text'
    })
    assert(
      !llm.lastContext.some((message) => message.id === first.userMessageId),
      'A new conversation received messages from another conversation.'
    )
    const page = service.list(0, 1)
    assert(page.items.length === 1 && page.nextCursor === 1, 'Conversation pagination failed.')

    let releaseCorrection!: () => void
    llm.correctionBarrier = new Promise<void>((resolve) => {
      releaseCorrection = resolve
    })
    const delayedCorrection = service.analyzeCorrections(
      first.conversationId,
      first.userMessageId,
      'I very like it'
    )
    service.setActive(second.conversationId)
    releaseCorrection()
    await delayedCorrection
    llm.correctionBarrier = undefined
    assert(
      service.get(first.conversationId)?.messages[0].corrections?.length === 1,
      'Delayed correction was not attached to its source conversation.'
    )
    assert(
      !service.get(second.conversationId)?.messages[0].corrections?.length,
      'Delayed correction leaked into the active conversation.'
    )
    assert(
      llm.lastCorrectionContext?.conversationId === first.conversationId,
      'Correction context followed the active conversation instead of its source.'
    )

    service.analyses.start(
      first.conversationId,
      first.userMessageId,
      'correction',
      1
    )

    database.close()
    database = new DatabaseService(root)
    database.initialize()
    service = new ConversationService(
      database.connection,
      llm as unknown as LLMClient,
      () => undefined
    )
    const restored = service.getActive()
    assert(restored?.id === second.conversationId, 'Active conversation was not restored.')
    assert(
      service.get(first.conversationId)?.messages[0].correctionStatus === 'failed',
      'Interrupted analysis was not made retryable after restart.'
    )
    service.setActive(first.conversationId)

    const resumed = await service.send({
      conversationId: first.conversationId,
      clientRequestId: 'request-2',
      content: 'The movie was funny',
      inputMode: 'text'
    })
    assert(
      llm.lastContext.some((message) => message.id === first.assistantMessageId),
      'Restored transcript was not injected into chat context.'
    )
    await service.analyzeVocabulary(
      first.conversationId,
      resumed.assistantMessageId,
      resumed.reply
    )
    const repeatedVocabulary = service
      .get(first.conversationId)!
      .messages.flatMap((message) => message.vocabulary || [])
      .filter((item) => item.normalizedTerm === 'mock reply')
    assert(
      repeatedVocabulary.length === 2,
      'Repeated vocabulary occurrences lost their source records.'
    )

    for (let index = 0; index < 13; index += 1) {
      await service.send({
        conversationId: first.conversationId,
        clientRequestId: `compression-${index}`,
        content: `Compression turn ${index}`,
        inputMode: 'text'
      })
    }
    let compressed = service.get(first.conversationId)!
    assert(compressed.summaryThroughSequence > 0, 'Context compression did not persist a cursor.')
    assert(llm.summaryCalls > 0, 'Context summarizer was not invoked.')
    const preservedMessageCount = compressed.messages.length

    llm.summarizeShouldFail = true
    for (let index = 0; index < 13; index += 1) {
      await service.send({
        conversationId: first.conversationId,
        clientRequestId: `fallback-${index}`,
        content: `Fallback turn ${index}`,
        inputMode: 'text'
      })
    }
    compressed = service.get(first.conversationId)!
    assert(
      compressed.contextSummary.startsWith('[local fallback]'),
      'Local fallback summary was not persisted.'
    )
    assert(
      compressed.messages.length > preservedMessageCount,
      'Context compression deleted original transcript messages.'
    )
    llm.summarizeShouldFail = false

    database.connection.prepare(
      'UPDATE conversations SET context_prompt_version = 0 WHERE id = ?'
    ).run(first.conversationId)
    await service.send({
      conversationId: first.conversationId,
      clientRequestId: 'prompt-version-upgrade',
      content: 'Rebuild old context memory',
      inputMode: 'text'
    })
    assert(
      service.get(first.conversationId)?.contextPromptVersion === 1,
      'Old context prompt version was not rebuilt lazily.'
    )

    const reviewSource = service.get(first.conversationId)!
    const sourceUser = reviewSource.messages.find((message) => message.role === 'user')!
    const correctionId = sourceUser.corrections?.[0]?.id!
    llm.reviewResult = {
      ...llm.reviewResult,
      expressions: [{
        sourceUserMessageId: sourceUser.id,
        original: sourceUser.content,
        improved: 'I like it very much.',
        explanation: '表达更自然。'
      }, {
        sourceUserMessageId: sourceUser.id,
        original: sourceUser.content,
        improved: 'I like it very much.',
        explanation: '重复项应被过滤。'
      }],
      selectedCorrections: [{
        correctionId,
        reason: '这是常见的程度副词位置问题。',
        correctedMeaning: '我非常喜欢它。'
      }, {
        correctionId,
        reason: '重复选择应被过滤。',
        correctedMeaning: '我非常喜欢它。'
      }]
    }
    const practice = new ReviewPracticeRepository(database.connection)
    const reviewService = new ReviewService(
      service.conversations,
      new ReviewRepository(database.connection, service.conversations),
      practice,
      llm as unknown as LLMClient,
      () => undefined
    )
    const generated = await reviewService.generate(first.conversationId)
    assert(generated.review.status === 'ready', 'Review was not generated.')
    assert(generated.review.expressions.length === 1, 'Review expression reference was lost.')
    assert(
      generated.review.selectedCorrections.length === 1,
      'Review correction reference was lost.'
    )
    assert(
      generated.review.selectedCorrections[0].correctedMeaning ===
        '我非常喜欢它。',
      'Review correction translation was not persisted.'
    )
    const dashboard = reviewService.dashboard(20)
    assert(dashboard.totalCount >= 2, 'Review items were not created from learning data.')
    const correctionCard = dashboard.items.find((item) => item.kind === 'correction')
    assert(Boolean(correctionCard), 'A correction review card was not generated.')
    assert(
      correctionCard!.sourceSentence === sourceUser.content &&
        correctionCard!.prompt.includes(sourceUser.content),
      'Correction card lost the complete original user sentence or its context.'
    )
    assert(
      !correctionCard!.prompt.startsWith('请把这句话改得更自然'),
      'Correction card still uses the repetitive legacy prompt.'
    )
    const evaluation = await reviewService.evaluateAnswer(
      correctionCard!.id,
      correctionCard!.answer
    )
    assert(evaluation.level === 'strong', 'A submitted review answer was not evaluated.')
    const scheduled = reviewService.gradeItem(correctionCard!.id, 'good', {
      response: correctionCard!.answer,
      inputMode: 'voice',
      evaluation
    })
    assert(scheduled.intervalDays >= 1, 'A successful review was not scheduled ahead.')
    assert(reviewService.dashboard(20).reviewedToday >= 1, 'Review attempt was not recorded.')
    const storedAttempt = database.connection.prepare(`
      SELECT response_text, response_mode, evaluation_json
      FROM review_attempts ORDER BY reviewed_at DESC LIMIT 1
    `).get() as Record<string, unknown>
    assert(
      storedAttempt.response_text === correctionCard!.answer &&
        storedAttempt.response_mode === 'voice' &&
        String(storedAttempt.evaluation_json).includes('strong'),
      'The learner answer and evaluation evidence were not persisted.'
    )
    const reviewCallsAfterFirst = llm.reviewCalls
    const cached = await reviewService.generate(first.conversationId)
    assert(cached.review.id === generated.review.id, 'Unchanged review cache was not reused.')
    assert(llm.reviewCalls === reviewCallsAfterFirst, 'Cached review triggered another LLM call.')

    await service.send({
      conversationId: first.conversationId,
      clientRequestId: 'long-review-input',
      content: 'long speech '.repeat(2_000),
      inputMode: 'text'
    })
    llm.reviewResult = {
      summary: '长会话复习',
      topics: [],
      strengths: [],
      priorities: [],
      expressions: [],
      selectedCorrections: []
    }
    const beforeLongReviewCalls = llm.reviewCalls
    const longReview = await reviewService.generate(first.conversationId)
    assert(longReview.review.status === 'ready', 'Long review did not complete.')
    assert(
      llm.reviewCalls - beforeLongReviewCalls >= 2,
      'Long review did not use chunk and merge requests.'
    )

    await service.send({
      conversationId: first.conversationId,
      clientRequestId: 'concurrent-review-source',
      content: 'Create a concurrent review revision',
      inputMode: 'text'
    })
    let releaseReview!: () => void
    llm.reviewBarrier = new Promise<void>((resolve) => {
      releaseReview = resolve
    })
    const concurrentA = reviewService.generate(first.conversationId)
    const concurrentB = reviewService.generate(first.conversationId)
    assert(concurrentA === concurrentB, 'Concurrent review generation was not coalesced.')
    releaseReview()
    await Promise.all([concurrentA, concurrentB])
    llm.reviewBarrier = undefined

    await service.send({
      conversationId: first.conversationId,
      clientRequestId: 'failed-review-source',
      content: 'Create a failed review revision',
      inputMode: 'text'
    })
    llm.reviewShouldFail = true
    const failedReview = await reviewService.generate(first.conversationId)
    assert(failedReview.review.status === 'failed', 'Review failure was not persisted.')
    llm.reviewShouldFail = false

    const nextId = service.delete(second.conversationId)
    assert(nextId === first.conversationId, 'Soft delete did not choose the next conversation.')
    assert(
      !service.list(0, 100).items.some((item) => item.id === second.conversationId),
      'Soft-deleted conversation remained in normal lists.'
    )

    const subtitleStorage = new SubtitleStorage(join(root, 'community-subtitles'))
    const subtitleLlm = {
      async analyzeSubtitleScene() {
        return { summary: 'The friends find a key.', characters: ['Alex'], relationshipChanges: [], plotFacts: ['A key is found.'], keyDialogue: [], uncertainties: [] }
      },
      async mergeEpisodeKnowledge(identity: { title: string; type: 'tv' }, _scenes: unknown, season: number, episode: number) {
        return { title: identity.title, mediaType: identity.type, season, episode, spoilerBoundary: `S${season}E${episode}`, plotSummary: 'The friends find a key.', characters: ['Alex'], relationships: [], orderedEvents: ['A key is found.'], keyDialogue: [], uncertainties: [] }
      }
    }
    const subtitles = new SubtitleService(
      database.connection, subtitleLlm as unknown as LLMClient, subtitleStorage,
      createDefaultSubtitleFeatureConfig, () => undefined
    )
    const subtitleStatus = await subtitles.status()
    assert(!subtitleStatus.sourceProvider.available && subtitleStatus.sources.length === 0,
      'Community subtitles unexpectedly initialized online adapters.')
    const identity = { type: 'tv' as const, title: 'Community Import', normalizedTitle: 'community import', aliases: [], confirmed: true }
    const request = { requestId: 'import-local-season', origin: 'settings' as const, mediaType: 'tv' as const, title: identity.title, season: 1 }
    let onlineRejected = false
    try { subtitles.startWorkflow(request, identity) } catch { onlineRejected = true }
    assert(onlineRejected, 'Community build accepted an online subtitle search without a provider.')
    const archive = join(root, 'Community.S01.zip')
    const zip = new AdmZip()
    const srt = '1\n00:00:01,000 --> 00:00:04,000\nAlex found the missing key.\n'
    zip.addFile('Community.S01E01.srt', Buffer.from(srt))
    zip.addFile('Community.S01E02.srt', Buffer.from(srt))
    zip.writeZip(archive)
    const imported = subtitles.startWorkflow(request, identity, archive)
    await imported.completion
    const importedPackage = database.connection.prepare(
      'SELECT pack_type, episode FROM subtitle_packages WHERE media_id = (SELECT id FROM media_entities WHERE title = ?)'
    ).get(identity.title) as { pack_type: string; episode: number | null }
    assert(importedPackage.pack_type === 'season' && importedPackage.episode === null,
      'Local season archive was not persisted at season scope.')
    const episodeRequest = { ...request, requestId: 'process-local-second-episode', episode: 2 }
    const localKnowledge = await subtitles.startWorkflow(episodeRequest, identity).completion
    assert(localKnowledge?.episode === 2, 'Community build could not summarize an episode from an imported season.')
    const reused = subtitles.startWorkflow({ ...episodeRequest, requestId: 'reuse-local-episode' }, identity)
    assert(reused.start.status === 'ready', 'Ready local knowledge was not reused without an online provider.')
    await reused.completion

    console.log('SERVICE_SMOKE_OK')
    database.close()
    if (existsSync(root)) rmSync(root, { recursive: true, force: true })
    app.exit(0)
  } catch (error) {
    console.error('SERVICE_SMOKE_FAILED', error)
    database.close()
    app.exit(1)
  }
})
