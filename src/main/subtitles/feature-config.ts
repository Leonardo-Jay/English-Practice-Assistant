import type { SubtitleFeatureConfig } from '../../shared/types'
import { SUBTITLE_FEATURE_DEFAULTS } from './constants'

export function createDefaultSubtitleFeatureConfig(): SubtitleFeatureConfig {
  return {
    enabled: SUBTITLE_FEATURE_DEFAULTS.enabled,
    captchaMaxAttempts: SUBTITLE_FEATURE_DEFAULTS.captchaMaxAttempts,
    queryBudgetPerSource: SUBTITLE_FEATURE_DEFAULTS.queryBudgetPerSource,
    sceneConcurrency: SUBTITLE_FEATURE_DEFAULTS.sceneConcurrency,
    requestTimeoutMs: SUBTITLE_FEATURE_DEFAULTS.requestTimeoutMs,
    sources: {
      subhd: {
        enabled: SUBTITLE_FEATURE_DEFAULTS.sources.subhd.enabled,
        baseUrls: [...SUBTITLE_FEATURE_DEFAULTS.sources.subhd.baseUrls]
      },
      zimuwang: {
        enabled: SUBTITLE_FEATURE_DEFAULTS.sources.zimuwang.enabled,
        baseUrls: [...SUBTITLE_FEATURE_DEFAULTS.sources.zimuwang.baseUrls]
      }
    }
  }
}

export function normalizeSubtitleFeatureConfig(
  input?: Partial<SubtitleFeatureConfig>
): SubtitleFeatureConfig {
  const defaults = createDefaultSubtitleFeatureConfig()
  const positive = (value: unknown, fallback: number, max: number) => {
    const parsed = Number(value)
    return Number.isFinite(parsed)
      ? Math.max(1, Math.min(Math.round(parsed), max))
      : fallback
  }
  return {
    ...defaults,
    enabled: input?.enabled ?? defaults.enabled,
    captchaProfileId:
      typeof input?.captchaProfileId === 'string' && input.captchaProfileId.trim()
        ? input.captchaProfileId.trim()
        : undefined,
    captchaProfile: input?.captchaProfile,
    captchaMaxAttempts: positive(input?.captchaMaxAttempts, 3, 5),
    queryBudgetPerSource: positive(input?.queryBudgetPerSource, 8, 20),
    sceneConcurrency: positive(input?.sceneConcurrency, 2, 4),
    requestTimeoutMs: positive(input?.requestTimeoutMs, 20_000, 120_000),
    sources: {
      subhd: {
        enabled: input?.sources?.subhd?.enabled ?? defaults.sources.subhd.enabled,
        baseUrls: sanitizeUrls(
          input?.sources?.subhd?.baseUrls,
          defaults.sources.subhd.baseUrls
        )
      },
      zimuwang: {
        enabled:
          input?.sources?.zimuwang?.enabled ?? defaults.sources.zimuwang.enabled,
        baseUrls: sanitizeUrls(
          input?.sources?.zimuwang?.baseUrls,
          defaults.sources.zimuwang.baseUrls
        )
      }
    }
  }
}

function sanitizeUrls(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return [...fallback]
  const urls = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().replace(/\/+$/, ''))
    .filter((item) => /^https:\/\//i.test(item))
  return [...new Set(urls)].slice(0, 12)
}
