export const SUBTITLE_SCHEMA_VERSION = 1
export const SUBTITLE_PARSER_VERSION = 1
export const SUBTITLE_CLEANER_VERSION = 1
export const SUBTITLE_SCENE_PROMPT_VERSION = 1
export const SUBTITLE_MERGE_PROMPT_VERSION = 1
export const SUBTITLE_GROUNDED_CONTEXT_VERSION = 1

export const DEFAULT_SUBTITLE_LIMITS = {
  maxDownloadBytes: 80 * 1024 * 1024,
  maxArchiveEntries: 500,
  maxExtractedBytes: 240 * 1024 * 1024,
  maxExtractedFileBytes: 40 * 1024 * 1024,
  maxArchiveDepth: 2,
  sceneStrongGapMs: 12_000,
  sceneMaxDurationMs: 4 * 60_000,
  sceneMaxCharacters: 6_000,
  sceneOverlapLines: 3,
  mediaContextCharacters: 8_000
} as const

export const SUPPORTED_SUBTITLE_EXTENSIONS = new Set([
  '.srt',
  '.ass',
  '.ssa',
  '.vtt'
])

export const SUBTITLE_FEATURE_DEFAULTS = {
  enabled: true,
  captchaMaxAttempts: 3,
  queryBudgetPerSource: 8,
  sceneConcurrency: 2,
  requestTimeoutMs: 20_000,
  sources: {
    subhd: {
      enabled: true,
      baseUrls: [] as string[]
    },
    zimuwang: {
      enabled: false,
      baseUrls: [] as string[]
    }
  }
} as const
