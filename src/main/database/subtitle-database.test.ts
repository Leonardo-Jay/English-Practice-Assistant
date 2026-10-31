import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { DatabaseService } from './database-service'
import {
  ConversationMediaRepository,
  MediaRepository
} from './subtitle-repositories'
import { ConversationRepository } from './repositories'

const temporary: string[] = []

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

// This repository keeps better-sqlite3 rebuilt for Electron (ABI 130). The
// ordinary Vitest Node process uses a different ABI, so migration behavior is
// exercised by the Electron SQLite smoke when those ABIs differ.
describe.skipIf(process.versions.modules !== '130')('subtitle database migration', () => {
  it('adds media tables and keeps conversation media state isolated', () => {
    const directory = mkdtempSync(join(tmpdir(), 'english-subtitle-db-'))
    temporary.push(directory)
    const service = new DatabaseService(directory)
    try {
      service.initialize()
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${service.getStatus().diagnostic || ''}`
      )
    }
    const db = service.connection
    const conversations = new ConversationRepository(db)
    conversations.create('one', 'Conversation one')
    conversations.create('two', 'Conversation two')
    const media = new MediaRepository(db)
    const entity = media.upsert({
      type: 'tv',
      title: 'Sense8',
      normalizedTitle: 'sense8',
      aliases: [],
      confirmed: true
    })
    const contexts = new ConversationMediaRepository(db, media)
    contexts.save({
      conversationId: 'one',
      media: entity,
      season: 1,
      episode: 1,
      spoilerBoundary: 'S01E01',
      phase: 'ready',
      updatedAt: Date.now()
    })
    expect(contexts.get('one')?.media?.title).toBe('Sense8')
    expect(contexts.get('two')).toBeUndefined()
    expect(db.pragma('user_version', { simple: true })).toBe(8)
    service.close()
  })
})
