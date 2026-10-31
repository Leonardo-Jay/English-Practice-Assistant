import Database from 'better-sqlite3'
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
  unlinkSync
} from 'fs'
import { basename, dirname, join } from 'path'
import type { DatabaseStatus } from '../../shared/types'

const CURRENT_SCHEMA_VERSION = 8
const MAX_BACKUPS = 5

const SCHEMA_V1 = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  practice_mode TEXT NOT NULL DEFAULT 'free',
  topic TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  content_revision INTEGER NOT NULL DEFAULT 0,
  analysis_revision INTEGER NOT NULL DEFAULT 0,
  context_summary TEXT NOT NULL DEFAULT '',
  summary_through_sequence INTEGER NOT NULL DEFAULT 0,
  context_prompt_version INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_opened_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_conversations_status_updated
  ON conversations(status, updated_at DESC);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sequence INTEGER NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  input_mode TEXT NOT NULL DEFAULT 'text',
  reply_to_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  client_request_id TEXT,
  status TEXT NOT NULL DEFAULT 'complete',
  created_at INTEGER NOT NULL,
  UNIQUE(conversation_id, sequence),
  UNIQUE(conversation_id, client_request_id)
);

CREATE INDEX IF NOT EXISTS idx_messages_conversation_sequence
  ON messages(conversation_id, sequence);

CREATE TABLE IF NOT EXISTS message_analyses (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  status TEXT NOT NULL,
  prompt_version INTEGER NOT NULL DEFAULT 1,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  error_detail TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE(message_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_analyses_conversation
  ON message_analyses(conversation_id, status);

CREATE TABLE IF NOT EXISTS corrections (
  id TEXT PRIMARY KEY,
  user_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  type TEXT NOT NULL,
  original TEXT NOT NULL,
  corrected TEXT NOT NULL,
  explanation_zh TEXT NOT NULL,
  learning_value INTEGER,
  UNIQUE(user_message_id, ordinal)
);

CREATE TABLE IF NOT EXISTS vocabulary_occurrences (
  id TEXT PRIMARY KEY,
  assistant_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  term TEXT NOT NULL,
  normalized_term TEXT NOT NULL,
  part_of_speech_zh TEXT NOT NULL,
  chinese_meaning TEXT NOT NULL,
  source_sentence TEXT NOT NULL,
  start_offset INTEGER,
  end_offset INTEGER,
  dictionary_entry_key TEXT,
  dictionary_edition TEXT,
  UNIQUE(assistant_message_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_vocabulary_normalized
  ON vocabulary_occurrences(normalized_term);

CREATE TABLE IF NOT EXISTS conversation_reviews (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  source_content_revision INTEGER NOT NULL,
  source_analysis_revision INTEGER NOT NULL,
  prompt_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  summary_zh TEXT NOT NULL DEFAULT '',
  topics_json TEXT NOT NULL DEFAULT '[]',
  strengths_json TEXT NOT NULL DEFAULT '[]',
  priorities_json TEXT NOT NULL DEFAULT '[]',
  error_detail TEXT,
  generated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_reviews_conversation_generated
  ON conversation_reviews(conversation_id, generated_at DESC);

CREATE TABLE IF NOT EXISTS review_expressions (
  id TEXT PRIMARY KEY,
  review_id TEXT NOT NULL REFERENCES conversation_reviews(id) ON DELETE CASCADE,
  source_user_message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  original TEXT NOT NULL,
  improved TEXT NOT NULL,
  explanation_zh TEXT NOT NULL,
  UNIQUE(review_id, ordinal)
);

CREATE TABLE IF NOT EXISTS review_correction_selections (
  review_id TEXT NOT NULL REFERENCES conversation_reviews(id) ON DELETE CASCADE,
  correction_id TEXT NOT NULL REFERENCES corrections(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  reason_zh TEXT NOT NULL,
  PRIMARY KEY(review_id, correction_id)
);

CREATE TABLE IF NOT EXISTS app_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

const SCHEMA_V2 = `
ALTER TABLE corrections
  ADD COLUMN scope TEXT NOT NULL DEFAULT 'span'
  CHECK(scope IN ('span', 'sentence'));
ALTER TABLE corrections
  ADD COLUMN sentence_index INTEGER;
`

const SCHEMA_V3 = `
ALTER TABLE review_correction_selections
  ADD COLUMN corrected_meaning_zh TEXT NOT NULL DEFAULT '';
`

const SCHEMA_V4 = `
CREATE TABLE IF NOT EXISTS media_entities (
  id TEXT PRIMARY KEY,
  media_type TEXT NOT NULL CHECK(media_type IN ('movie', 'tv')),
  title TEXT NOT NULL,
  normalized_title TEXT NOT NULL,
  aliases_json TEXT NOT NULL DEFAULT '[]',
  release_year INTEGER,
  confirmed INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_media_entities_normalized
  ON media_entities(media_type, normalized_title, release_year);

CREATE TABLE IF NOT EXISTS conversation_media_contexts (
  conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
  media_id TEXT REFERENCES media_entities(id) ON DELETE SET NULL,
  season INTEGER,
  episode INTEGER,
  spoiler_boundary TEXT,
  phase TEXT NOT NULL DEFAULT 'idle',
  active_job_id TEXT,
  continue_without_subtitles INTEGER NOT NULL DEFAULT 0,
  error_code TEXT,
  error_message TEXT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS subtitle_jobs (
  id TEXT PRIMARY KEY,
  media_id TEXT NOT NULL REFERENCES media_entities(id) ON DELETE CASCADE,
  season INTEGER,
  episode INTEGER,
  phase TEXT NOT NULL,
  source TEXT,
  query_index INTEGER NOT NULL DEFAULT 0,
  selected_candidate_json TEXT,
  candidates_json TEXT NOT NULL DEFAULT '[]',
  progress_received INTEGER,
  progress_total INTEGER,
  error_code TEXT,
  error_detail TEXT,
  retry_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_subtitle_jobs_identity
  ON subtitle_jobs(media_id, season, episode, updated_at DESC);

CREATE TABLE IF NOT EXISTS subtitle_assets (
  id TEXT PRIMARY KEY,
  media_id TEXT NOT NULL REFERENCES media_entities(id) ON DELETE CASCADE,
  job_id TEXT REFERENCES subtitle_jobs(id) ON DELETE SET NULL,
  season INTEGER,
  episode INTEGER,
  source TEXT NOT NULL,
  source_page_url TEXT,
  relative_raw_path TEXT NOT NULL,
  relative_dialogue_path TEXT,
  relative_knowledge_path TEXT,
  sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  language TEXT,
  format TEXT,
  parser_version INTEGER NOT NULL,
  cleaner_version INTEGER NOT NULL,
  knowledge_prompt_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subtitle_assets_hash_scope
  ON subtitle_assets(media_id, season, episode, sha256);

CREATE TABLE IF NOT EXISTS subtitle_scenes (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES subtitle_assets(id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  start_ms INTEGER NOT NULL,
  end_ms INTEGER NOT NULL,
  dialogue TEXT NOT NULL,
  analysis_json TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  error_detail TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE(asset_id, ordinal)
);

CREATE VIRTUAL TABLE IF NOT EXISTS subtitle_scenes_fts USING fts5(
  scene_id UNINDEXED,
  dialogue,
  analysis
);

CREATE TABLE IF NOT EXISTS episode_knowledge (
  id TEXT PRIMARY KEY,
  asset_id TEXT NOT NULL REFERENCES subtitle_assets(id) ON DELETE CASCADE,
  knowledge_json TEXT NOT NULL,
  model TEXT,
  cleaner_version INTEGER NOT NULL,
  scene_prompt_version INTEGER NOT NULL,
  merge_prompt_version INTEGER NOT NULL,
  status TEXT NOT NULL,
  error_detail TEXT,
  updated_at INTEGER NOT NULL,
  UNIQUE(asset_id, cleaner_version, scene_prompt_version, merge_prompt_version)
);
`

const SCHEMA_V5 = `
CREATE TABLE IF NOT EXISTS media_mentions (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  media_id TEXT NOT NULL REFERENCES media_entities(id) ON DELETE CASCADE,
  season INTEGER,
  episode INTEGER,
  evidence_text TEXT NOT NULL,
  confidence REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending', 'dismissed', 'accepted')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(conversation_id, message_id)
);
CREATE INDEX IF NOT EXISTS idx_media_mentions_conversation_status
  ON media_mentions(conversation_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS subtitle_packages (
  id TEXT PRIMARY KEY,
  media_id TEXT NOT NULL REFERENCES media_entities(id) ON DELETE CASCADE,
  season INTEGER,
  episode INTEGER,
  pack_type TEXT NOT NULL DEFAULT 'unknown',
  source TEXT NOT NULL,
  source_page_url TEXT,
  candidate_json TEXT,
  relative_raw_path TEXT NOT NULL,
  manifest_json TEXT NOT NULL DEFAULT '[]',
  sha256 TEXT NOT NULL,
  byte_size INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'ready',
  error_detail TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_subtitle_packages_hash
  ON subtitle_packages(media_id, COALESCE(season, 0), COALESCE(episode, 0), sha256);
CREATE INDEX IF NOT EXISTS idx_subtitle_packages_scope
  ON subtitle_packages(media_id, season, episode, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS conversation_media_links (
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  asset_id TEXT NOT NULL REFERENCES subtitle_assets(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY(conversation_id, asset_id)
);
CREATE INDEX IF NOT EXISTS idx_conversation_media_links_enabled
  ON conversation_media_links(conversation_id, enabled, updated_at DESC);

ALTER TABLE subtitle_assets
  ADD COLUMN package_id TEXT REFERENCES subtitle_packages(id) ON DELETE SET NULL;
ALTER TABLE subtitle_jobs
  ADD COLUMN origin TEXT NOT NULL DEFAULT 'chat';
ALTER TABLE subtitle_jobs
  ADD COLUMN conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL;
ALTER TABLE subtitle_jobs
  ADD COLUMN mention_id TEXT REFERENCES media_mentions(id) ON DELETE SET NULL;
ALTER TABLE subtitle_jobs
  ADD COLUMN package_id TEXT REFERENCES subtitle_packages(id) ON DELETE SET NULL;
ALTER TABLE subtitle_jobs
  ADD COLUMN request_id TEXT;

INSERT OR IGNORE INTO subtitle_packages(
  id, media_id, season, episode, pack_type, source, source_page_url,
  relative_raw_path, manifest_json, sha256, byte_size, status, created_at, updated_at
)
SELECT
  'legacy-' || id, media_id, season, episode,
  CASE WHEN episode IS NULL AND season IS NOT NULL THEN 'season'
       WHEN episode IS NOT NULL THEN 'episode'
       ELSE 'movie' END,
  source, source_page_url, relative_raw_path, json_array(relative_raw_path),
  sha256, byte_size, status, created_at, updated_at
FROM subtitle_assets
WHERE status = 'ready';

UPDATE subtitle_assets
SET package_id = 'legacy-' || id
WHERE status = 'ready' AND package_id IS NULL;

INSERT OR IGNORE INTO conversation_media_links(
  conversation_id, asset_id, enabled, created_at, updated_at
)
SELECT c.conversation_id, a.id, 1, c.updated_at, c.updated_at
FROM conversation_media_contexts c
JOIN subtitle_assets a
  ON a.media_id = c.media_id
 AND COALESCE(a.season, 0) = COALESCE(c.season, 0)
 AND COALESCE(a.episode, 0) = COALESCE(c.episode, 0)
WHERE c.phase = 'ready' AND a.status = 'ready';
`

const SCHEMA_V6 = `
CREATE TABLE IF NOT EXISTS review_items (
  id TEXT PRIMARY KEY,
  source_key TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK(kind IN ('vocabulary', 'correction', 'expression')),
  conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
  source_message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
  prompt TEXT NOT NULL,
  answer TEXT NOT NULL,
  explanation_zh TEXT NOT NULL DEFAULT '',
  meaning_zh TEXT,
  source_sentence TEXT,
  due_at INTEGER NOT NULL,
  interval_days INTEGER NOT NULL DEFAULT 0,
  repetitions INTEGER NOT NULL DEFAULT 0,
  lapses INTEGER NOT NULL DEFAULT 0,
  last_grade TEXT CHECK(last_grade IN ('again', 'hard', 'good', 'easy')),
  status TEXT NOT NULL DEFAULT 'learning' CHECK(status IN ('learning', 'mastered')),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_items_due
  ON review_items(status, due_at, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_review_items_kind
  ON review_items(kind, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS review_attempts (
  id TEXT PRIMARY KEY,
  review_item_id TEXT NOT NULL REFERENCES review_items(id) ON DELETE CASCADE,
  grade TEXT NOT NULL CHECK(grade IN ('again', 'hard', 'good', 'easy')),
  reviewed_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_review_attempts_item_time
  ON review_attempts(review_item_id, reviewed_at DESC);
CREATE INDEX IF NOT EXISTS idx_review_attempts_time
  ON review_attempts(reviewed_at DESC);
`

const SCHEMA_V7 = `
CREATE TABLE IF NOT EXISTS review_item_exclusions (
  source_key TEXT PRIMARY KEY,
  excluded_at INTEGER NOT NULL
);
`

const SCHEMA_V8 = `
ALTER TABLE review_attempts ADD COLUMN response_text TEXT;
ALTER TABLE review_attempts ADD COLUMN response_mode TEXT;
ALTER TABLE review_attempts ADD COLUMN evaluation_json TEXT;
`

export class DatabaseService {
  private database: Database.Database | null = null
  private readonly databasePath: string
  private readonly backupDirectory: string
  private lastError?: string

  constructor(userDataPath: string) {
    this.databasePath = join(userDataPath, 'data', 'learning.db')
    this.backupDirectory = join(userDataPath, 'data', 'backups')
  }

  initialize(): void {
    if (this.database) return
    mkdirSync(dirname(this.databasePath), { recursive: true })
    mkdirSync(this.backupDirectory, { recursive: true })

    const existed = existsSync(this.databasePath) && statSync(this.databasePath).size > 0
    let db: Database.Database | null = null
    try {
      db = this.open()
      const quickCheck = db.pragma('quick_check', { simple: true }) as string
      if (quickCheck !== 'ok') {
        throw new Error(`数据库完整性检查失败：${quickCheck}`)
      }

      const version = Number(db.pragma('user_version', { simple: true }) || 0)
      if (version < CURRENT_SCHEMA_VERSION) {
        if (existed) {
          db.pragma('wal_checkpoint(TRUNCATE)')
          db.close()
          db = null
          this.createBackup(version)
          db = this.open()
        }
        this.migrate(db, version)
      }

      this.database = db
      this.lastError = undefined
    } catch (error) {
      if (db?.open) db.close()
      this.database = null
      this.lastError = error instanceof Error ? error.stack || error.message : String(error)
      throw new Error('学习数据库初始化失败，原始数据已保留。请重试或打开数据目录检查。')
    }
  }

  get connection(): Database.Database {
    if (!this.database) {
      throw new Error('学习数据库尚未初始化。')
    }
    return this.database
  }

  get path(): string {
    return this.databasePath
  }

  get dataDirectory(): string {
    return dirname(this.databasePath)
  }

  getStatus(): DatabaseStatus {
    return {
      ready: Boolean(this.database),
      path: this.databasePath,
      error: this.database ? undefined : '学习数据库尚未就绪。',
      diagnostic: this.lastError
    }
  }

  close(): void {
    if (!this.database) return
    try {
      this.database.pragma('wal_checkpoint(TRUNCATE)')
    } finally {
      this.database.close()
      this.database = null
    }
  }

  private open(): Database.Database {
    const db = new Database(this.databasePath)
    db.pragma('journal_mode = WAL')
    db.pragma('foreign_keys = ON')
    db.pragma('synchronous = NORMAL')
    db.pragma('busy_timeout = 5000')
    return db
  }

  private migrate(db: Database.Database, fromVersion: number): void {
    const migrate = db.transaction(() => {
      if (fromVersion < 1) {
        db.exec(SCHEMA_V1)
        db.prepare(
          'INSERT OR REPLACE INTO schema_migrations(version, applied_at) VALUES (?, ?)'
        ).run(1, Date.now())
      }
      if (fromVersion < 2) {
        db.exec(SCHEMA_V2)
        db.prepare(
          'INSERT OR REPLACE INTO schema_migrations(version, applied_at) VALUES (?, ?)'
        ).run(2, Date.now())
      }
      if (fromVersion < 3) {
        db.exec(SCHEMA_V3)
        db.prepare(
          'INSERT OR REPLACE INTO schema_migrations(version, applied_at) VALUES (?, ?)'
        ).run(3, Date.now())
      }
      if (fromVersion < 4) {
        db.exec(SCHEMA_V4)
        db.prepare(
          'INSERT OR REPLACE INTO schema_migrations(version, applied_at) VALUES (?, ?)'
        ).run(4, Date.now())
      }
      if (fromVersion < 5) {
        db.exec(SCHEMA_V5)
        db.prepare(
          'INSERT OR REPLACE INTO schema_migrations(version, applied_at) VALUES (?, ?)'
        ).run(5, Date.now())
      }
      if (fromVersion < 6) {
        db.exec(SCHEMA_V6)
        db.prepare(
          'INSERT OR REPLACE INTO schema_migrations(version, applied_at) VALUES (?, ?)' 
        ).run(6, Date.now())
      }
      if (fromVersion < 7) {
        db.exec(SCHEMA_V7)
        db.prepare(
          'INSERT OR REPLACE INTO schema_migrations(version, applied_at) VALUES (?, ?)'
        ).run(7, Date.now())
      }
      if (fromVersion < 8) {
        db.exec(SCHEMA_V8)
        db.prepare(
          'INSERT OR REPLACE INTO schema_migrations(version, applied_at) VALUES (?, ?)'
        ).run(8, Date.now())
      }
      db.pragma(`user_version = ${CURRENT_SCHEMA_VERSION}`)
    })
    migrate()
  }

  private createBackup(fromVersion: number): void {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
    const backupPath = join(
      this.backupDirectory,
      `${basename(this.databasePath)}.v${fromVersion}.${timestamp}.bak`
    )
    copyFileSync(this.databasePath, backupPath)

    const backups = readdirSync(this.backupDirectory)
      .filter((name) => name.startsWith(`${basename(this.databasePath)}.`))
      .map((name) => {
        const path = join(this.backupDirectory, name)
        return { path, modifiedAt: statSync(path).mtimeMs }
      })
      .sort((left, right) => right.modifiedAt - left.modifiedAt)

    for (const backup of backups.slice(MAX_BACKUPS)) {
      unlinkSync(backup.path)
    }
  }
}
