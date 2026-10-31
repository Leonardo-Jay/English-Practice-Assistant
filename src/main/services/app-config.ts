import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'fs'
import { dirname, join } from 'path'
import { app } from 'electron'
import type {
  LLMProfile,
  LLMProfileStore,
  LLMProvider,
  SubtitleFeatureConfig,
  VoiceCaptureSettings
} from '../../shared/types'
import { inferLLMProvider } from '../../shared/llm-providers'
import {
  createDefaultSubtitleFeatureConfig,
  normalizeSubtitleFeatureConfig
} from '../subtitles/feature-config'

interface AppConfig {
  sttModelDir?: string
  voiceCapture?: Partial<VoiceCaptureSettings>
  llmProfiles?: LLMProfileStore
  subtitles?: SubtitleFeatureConfig
  llmDiagnostics?: {
    enabled?: boolean
  }
}

export const DEFAULT_VOICE_CAPTURE_SETTINGS: VoiceCaptureSettings = {
  // Let a person decide whether they want to start talking after an assistant
  // reply, but finish a spoken turn reasonably quickly once speech began.
  initialSilenceMs: 20_000,
  silenceAfterSpeechMs: 5_000,
  speechRmsThreshold: 0.012
}

export class AppConfigService {
  private getConfigPath() {
    return join(app.getPath('userData'), 'config.json')
  }

  private readConfig(): AppConfig {
    const configPath = this.getConfigPath()

    if (!existsSync(configPath)) {
      return {}
    }

    try {
      return JSON.parse(readFileSync(configPath, 'utf-8')) as AppConfig
    } catch {
      return {}
    }
  }

  private writeConfig(config: AppConfig) {
    const configPath = this.getConfigPath()
    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8')
  }

  getSttModelDir() {
    return this.readConfig().sttModelDir
  }

  setSttModelDir(dir?: string) {
    const config = this.readConfig()

    if (dir) {
      config.sttModelDir = dir
    } else {
      delete config.sttModelDir
    }

    this.writeConfig(config)
  }

  getLLMProfiles(): LLMProfileStore | undefined {
    const config = this.readConfig()
    const configured = normalizeLLMProfileStore(config.llmProfiles)

    // A newly created installation may already have a single blank default
    // profile. It is only a UI placeholder, not a saved provider setup, and
    // must not stop recovery of real profiles from Chromium's old storage.
    if (hasUsableLLMProfile(configured)) return configured

    // Previous versions used Chromium localStorage only. Its LevelDB history
    // can contain several revisions; select the richest valid profile set and
    // immediately copy it to config.json so later portable launches do not
    // depend on a file:// storage origin.
    const recovered = this.recoverLLMProfilesFromLocalStorage()
    if (recovered && isRicherLLMProfileStore(recovered, configured)) {
      config.llmProfiles = recovered
      this.writeConfig(config)
      return recovered
    }

    return configured
  }

  setLLMProfiles(store: LLMProfileStore): LLMProfileStore {
    const normalized = normalizeLLMProfileStore(store)
    if (!normalized) {
      throw new Error('大模型配置格式无效，未保存。')
    }
    const config = this.readConfig()
    config.llmProfiles = normalized
    this.writeConfig(config)
    return normalized
  }

  getVoiceCaptureSettings(): VoiceCaptureSettings {
    return normalizeVoiceCaptureSettings(this.readConfig().voiceCapture)
  }

  setVoiceCaptureSettings(
    value: Partial<VoiceCaptureSettings>
  ): VoiceCaptureSettings {
    const config = this.readConfig()
    const normalized = normalizeVoiceCaptureSettings({
      ...config.voiceCapture,
      ...value
    })
    config.voiceCapture = normalized
    this.writeConfig(config)
    return normalized
  }

  getSubtitleConfig(): SubtitleFeatureConfig {
    return normalizeSubtitleFeatureConfig(
      this.readConfig().subtitles || createDefaultSubtitleFeatureConfig()
    )
  }

  setSubtitleConfig(value: Partial<SubtitleFeatureConfig>): SubtitleFeatureConfig {
    const config = this.readConfig()
    config.subtitles = normalizeSubtitleFeatureConfig({
      ...config.subtitles,
      ...value,
      sources: {
        ...config.subtitles?.sources,
        ...value.sources
      } as SubtitleFeatureConfig['sources']
    })
    this.writeConfig(config)
    return config.subtitles
  }

  getLLMDiagnosticLoggingEnabled(): boolean {
    return this.readConfig().llmDiagnostics?.enabled !== false
  }

  setLLMDiagnosticLoggingEnabled(enabled: boolean): boolean {
    const config = this.readConfig()
    config.llmDiagnostics = { enabled }
    this.writeConfig(config)
    return enabled
  }

  private recoverLLMProfilesFromLocalStorage(): LLMProfileStore | undefined {
    const directories = [
      join(app.getPath('userData'), 'Local Storage', 'leveldb'),
      // Development builds created before userData was stabilized used this
      // Electron default path. It is read only as a migration source.
      join(app.getPath('appData'), 'Electron', 'Local Storage', 'leveldb')
    ]
    const candidates: Array<{ store: LLMProfileStore; modifiedAt: number }> = []
    for (const directory of directories) {
      if (!existsSync(directory)) continue
      for (const name of readdirSync(directory)) {
        if (!/\.(ldb|log)$/i.test(name)) continue
        const path = join(directory, name)
        try {
          const buffer = readFileSync(path)
          const modifiedAt = statSync(path).mtimeMs
          // Chromium's LevelDB stores localStorage values in either UTF-8 or
          // UTF-16LE. Scan both formats. UTF-16 records are not necessarily
          // aligned to the beginning of the .ldb file, so decoding starts at
          // each matched byte sequence rather than at byte zero.
          for (const value of extractStoredProfileJson(buffer)) {
            try {
              const parsed = JSON.parse(value) as unknown
              const store = normalizeLLMProfileStore(parsed)
              if (store && hasUsableLLMProfile(store)) {
                candidates.push({ store, modifiedAt })
              }
            } catch {
              // Ignore an incomplete historical LevelDB record and continue
              // scanning later records in the same file.
            }
          }
        } catch {
          // A concurrent Chromium compaction or one malformed historical
          // record must not prevent the app itself from starting.
        }
      }
    }
    return candidates
      .sort((left, right) =>
        usableProfileCount(right.store) - usableProfileCount(left.store) ||
        right.store.profiles.length - left.store.profiles.length ||
        right.modifiedAt - left.modifiedAt
      )[0]?.store
  }
}

function normalizeLLMProfileStore(value: unknown): LLMProfileStore | undefined {
  if (!value || typeof value !== 'object') return undefined
  const store = value as Partial<LLMProfileStore>
  if (!Array.isArray(store.profiles) || store.profiles.length === 0) return undefined

  const profiles = store.profiles
    .map((profile, index) => normalizeLLMProfile(profile, index))
    .filter((profile): profile is LLMProfile => profile !== undefined)
  if (profiles.length === 0) return undefined

  const activeId =
    typeof store.activeId === 'string' && profiles.some((profile) => profile.id === store.activeId)
      ? store.activeId
      : profiles[0].id
  return { version: 2, activeId, profiles }
}

function extractStoredProfileJson(buffer: Buffer): string[] {
  const values = new Set<string>()
  for (const value of extractJsonObjects(buffer.toString('utf8'), '{"version":2')) {
    values.add(value)
  }

  const marker = Buffer.from('{"version":2', 'utf16le')
  let byteOffset = 0
  while (byteOffset < buffer.length) {
    const start = buffer.indexOf(marker, byteOffset)
    if (start < 0) break
    const value = extractFirstJsonObject(buffer.subarray(start).toString('utf16le'))
    if (value) values.add(value)
    byteOffset = start + marker.length
  }
  return [...values]
}

function extractFirstJsonObject(text: string): string | undefined {
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (inString) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inString = false
      continue
    }
    if (character === '"') inString = true
    else if (character === '{') depth += 1
    else if (character === '}') {
      depth -= 1
      if (depth === 0) return text.slice(0, index + 1)
    }
  }
  return undefined
}

function normalizeLLMProfile(value: unknown, index: number): LLMProfile | undefined {
  if (!value || typeof value !== 'object') return undefined
  const row = value as Record<string, unknown>
  if (
    typeof row.baseUrl !== 'string' ||
    typeof row.apiKey !== 'string' ||
    typeof row.model !== 'string'
  ) {
    return undefined
  }

  const baseUrl = row.baseUrl.trim()
  const apiKey = row.apiKey.trim()
  const apiId = typeof row.apiId === 'string' ? row.apiId.trim() : ''
  const model = row.model.trim()
  const provider = isLLMProvider(row.provider)
    ? row.provider
    : inferLLMProvider({ baseUrl })
  const id = typeof row.id === 'string' && row.id.trim() ? row.id.trim() : `migrated-${index}-${stableId(baseUrl, model)}`
  const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim() : model || `模型配置 ${index + 1}`
  return { id, name, provider, baseUrl, apiKey, apiId, model }
}

function isLLMProvider(value: unknown): value is LLMProvider {
  return value === 'openai' || value === 'anthropic' || value === 'apihz' ||
    value === 'qianfan' || value === 'longcat' || value === 'modelscope'
}

function stableId(baseUrl: string, model: string): string {
  let hash = 0
  for (const character of `${baseUrl}\u0000${model}`) {
    hash = (hash * 31 + character.charCodeAt(0)) | 0
  }
  return (hash >>> 0).toString(36)
}

function usableProfileCount(store?: LLMProfileStore): number {
  return store?.profiles.filter((profile) => Boolean(profile.apiKey.trim())).length || 0
}

function hasUsableLLMProfile(store?: LLMProfileStore): store is LLMProfileStore {
  return usableProfileCount(store) > 0
}

function isRicherLLMProfileStore(
  candidate: LLMProfileStore,
  existing?: LLMProfileStore
): boolean {
  return usableProfileCount(candidate) > usableProfileCount(existing) ||
    (usableProfileCount(candidate) === usableProfileCount(existing) &&
      candidate.profiles.length > (existing?.profiles.length || 0))
}

function extractJsonObjects(text: string, marker: string): string[] {
  const values: string[] = []
  let offset = 0
  while (offset < text.length) {
    const start = text.indexOf(marker, offset)
    if (start < 0) break
    let depth = 0
    let inString = false
    let escaped = false
    for (let index = start; index < text.length; index += 1) {
      const character = text[index]
      if (inString) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '"') inString = false
        continue
      }
      if (character === '"') inString = true
      else if (character === '{') depth += 1
      else if (character === '}') {
        depth -= 1
        if (depth === 0) {
          values.push(text.slice(start, index + 1))
          offset = index + 1
          break
        }
      }
    }
    if (offset <= start) offset = start + marker.length
  }
  return values
}

function normalizeVoiceCaptureSettings(
  value?: Partial<VoiceCaptureSettings>
): VoiceCaptureSettings {
  const initialSilenceMs = boundedNumber(
    value?.initialSilenceMs,
    DEFAULT_VOICE_CAPTURE_SETTINGS.initialSilenceMs,
    5_000,
    60_000,
    1_000
  )
  const silenceAfterSpeechMs = boundedNumber(
    value?.silenceAfterSpeechMs,
    DEFAULT_VOICE_CAPTURE_SETTINGS.silenceAfterSpeechMs,
    1_000,
    20_000,
    500
  )
  const speechRmsThreshold = boundedNumber(
    value?.speechRmsThreshold,
    DEFAULT_VOICE_CAPTURE_SETTINGS.speechRmsThreshold,
    0.003,
    0.05,
    0.001
  )
  return { initialSilenceMs, silenceAfterSpeechMs, speechRmsThreshold }
}

function boundedNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  step: number
): number {
  const numeric = Number(value)
  const safe = Number.isFinite(numeric) ? numeric : fallback
  return Math.round(Math.max(min, Math.min(max, safe)) / step) * step
}
