import {
  createLLMProfile,
  getLLMProviderDefinition,
  inferLLMProvider,
  normalizeLLMConfig
} from '../../../shared/llm-providers'
import type {
  LLMConfig,
  LLMProfile,
  LLMProfileStore,
  LLMProvider
} from '../../../shared/types'

export const LEGACY_LLM_STORAGE_KEY = 'english-practice-llm-config'
export const LLM_PROFILES_STORAGE_KEY = 'english-practice-llm-profiles'

function makeId(): string {
  return globalThis.crypto?.randomUUID?.() ||
    `llm-${Date.now()}-${Math.random().toString(16).slice(2)}`
}

function coerceProfile(value: unknown): LLMProfile | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Partial<LLMProfile>
  if (
    typeof row.baseUrl !== 'string' ||
    typeof row.apiKey !== 'string' ||
    typeof row.apiId !== 'string' ||
    typeof row.model !== 'string'
  ) {
    return null
  }
  const normalized = normalizeLLMConfig(row as LLMConfig)
  const provider = normalized.provider || inferLLMProvider(normalized)
  return {
    ...normalized,
    id: typeof row.id === 'string' && row.id ? row.id : makeId(),
    name:
      typeof row.name === 'string' && row.name.trim()
        ? row.name.trim()
        : normalized.model || getLLMProviderDefinition(provider).label,
    provider
  }
}

export function loadLLMProfileStore(): LLMProfileStore {
  try {
    const raw = localStorage.getItem(LLM_PROFILES_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<LLMProfileStore>
      const profiles = Array.isArray(parsed.profiles)
        ? parsed.profiles
            .map(coerceProfile)
            .filter((item): item is LLMProfile => item !== null)
        : []
      if (profiles.length > 0) {
        const activeId = profiles.some((item) => item.id === parsed.activeId)
          ? parsed.activeId!
          : profiles[0].id
        return { version: 2, activeId, profiles }
      }
    }
  } catch {
    // Fall through to legacy migration.
  }

  try {
    const legacy = localStorage.getItem(LEGACY_LLM_STORAGE_KEY)
    if (legacy) {
      const profile = coerceProfile(JSON.parse(legacy))
      if (profile) {
        profile.name =
          profile.model || getLLMProviderDefinition(profile.provider).label
        const migrated = { version: 2 as const, activeId: profile.id, profiles: [profile] }
        saveLLMProfileStore(migrated)
        return migrated
      }
    }
  } catch {
    // Invalid legacy settings are replaced by an empty profile.
  }

  const profile = createLLMProfile(makeId())
  return { version: 2, activeId: profile.id, profiles: [profile] }
}

export function saveLLMProfileStore(store: LLMProfileStore): void {
  localStorage.setItem(LLM_PROFILES_STORAGE_KEY, JSON.stringify(store))
  const active = store.profiles.find((item) => item.id === store.activeId)
  if (active) {
    // Keep the old key synchronized for downgrade compatibility.
    localStorage.setItem(LEGACY_LLM_STORAGE_KEY, JSON.stringify(active))
  }
}

export function getActiveLLMProfile(
  store: LLMProfileStore
): LLMProfile | undefined {
  return (
    store.profiles.find((item) => item.id === store.activeId) ||
    store.profiles[0]
  )
}

export function updateLLMProfileModel(
  profileId: string | undefined,
  model: string
): LLMProfile | undefined {
  const store = loadLLMProfileStore()
  const targetId =
    profileId && store.profiles.some((item) => item.id === profileId)
      ? profileId
      : store.activeId
  const nextStore: LLMProfileStore = {
    ...store,
    profiles: store.profiles.map((profile) =>
      profile.id === targetId ? { ...profile, model } : profile
    )
  }
  saveLLMProfileStore(nextStore)
  return nextStore.profiles.find((profile) => profile.id === targetId)
}

export function newLLMProfile(
  provider: LLMProvider = 'openai',
  name?: string
): LLMProfile {
  return createLLMProfile(makeId(), provider, name)
}
