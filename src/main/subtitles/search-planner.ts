import { createHash } from 'crypto'
import type {
  MediaIdentity,
  SubtitleCandidate,
  SubtitleSearchQuery
} from '../../shared/types'

export function normalizeMediaTitle(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[\p{P}\p{S}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function validateMediaIntent(input: unknown) {
  if (!input || typeof input !== 'object') return undefined
  const row = input as Record<string, unknown>
  const action = ['none', 'clarify', 'prepare'].includes(String(row.action))
    ? (String(row.action) as 'none' | 'clarify' | 'prepare')
    : undefined
  if (!action) return undefined
  const mediaType = ['movie', 'tv'].includes(String(row.mediaType))
    ? (String(row.mediaType) as 'movie' | 'tv')
    : undefined
  const integer = (value: unknown) => {
    const parsed = Number(value)
    return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined
  }
  return {
    action,
    mediaType,
    title: typeof row.title === 'string' ? row.title.trim().slice(0, 160) : undefined,
    aliases: Array.isArray(row.aliases)
      ? [...new Set(row.aliases.filter((v): v is string => typeof v === 'string').map((v) => v.trim()).filter(Boolean))].slice(0, 8)
      : [],
    year: integer(row.year),
    season: integer(row.season),
    episode: integer(row.episode),
    plotIntent: row.plotIntent === true,
    confirmed: row.confirmed === true,
    confidence: Math.max(0, Math.min(1, Number(row.confidence) || 0))
  }
}

export function buildSearchQueries(
  media: MediaIdentity,
  season?: number,
  episode?: number
): SubtitleSearchQuery[] {
  const aliases = [...new Set([media.title, ...media.aliases].map((value) => value.trim()).filter(Boolean))]
  const queries: SubtitleSearchQuery[] = []
  for (const alias of aliases) {
    const chinese = /[\u3400-\u9fff]/.test(alias)
    if (media.type === 'tv' && season && episode) {
      queries.push(
        { text: `${alias} S${pad(season)}E${pad(episode)}`, kind: 'exact-episode', alias, priority: chinese ? 3 : 1 },
        { text: `${alias} ${season}x${pad(episode)}`, kind: 'exact-episode', alias, priority: chinese ? 4 : 2 }
      )
      if (chinese) {
        queries.push({
          text: `${alias} 第${season}季 第${episode}集`,
          kind: 'exact-episode',
          alias,
          priority: 1
        })
      }
      queries.push(
        { text: `${alias} S${pad(season)}`, kind: 'season-pack', alias, priority: chinese ? 7 : 5 },
        { text: `${alias} 第${season}季`, kind: 'season-pack', alias, priority: chinese ? 5 : 7 }
      )
    } else if (media.type === 'movie' && media.year) {
      queries.push({ text: `${alias} ${media.year}`, kind: 'title', alias, priority: 1 })
    }
    queries.push({ text: alias, kind: 'title', alias, priority: 10 })
  }
  const seen = new Set<string>()
  return queries
    .sort((a, b) => a.priority - b.priority)
    .filter((item) => {
      const key = normalizeMediaTitle(item.text)
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
}

export function scoreSubtitleCandidate(
  candidate: Omit<SubtitleCandidate, 'score' | 'scoreReasons'>,
  media: MediaIdentity,
  season?: number,
  episode?: number
): SubtitleCandidate {
  let score = 0
  const reasons: string[] = []
  const title = normalizeMediaTitle(candidate.title)
  const aliases = [media.title, ...media.aliases].map(normalizeMediaTitle)
  const titleMatch = Math.max(...aliases.map((alias) => tokenSimilarity(alias, title)))
  score += titleMatch * 60
  reasons.push(`标题匹配 ${Math.round(titleMatch * 100)}%`)
  if (media.year && candidate.year) {
    if (media.year === candidate.year) {
      score += 8
      reasons.push('年份一致')
    } else {
      score -= 25
      reasons.push('年份不一致')
    }
  }
  if (media.type === 'tv' && season && episode) {
    if (candidate.season && candidate.season !== season) {
      score -= 80
      reasons.push('季数不一致')
    } else if (candidate.season === season) {
      score += 12
      reasons.push('季数一致')
    }
    if (candidate.episode && candidate.episode !== episode) {
      score -= 100
      reasons.push('集数不一致')
    } else if (candidate.episode === episode) {
      score += 35
      reasons.push('集数精确')
    } else if (candidate.packType === 'season') {
      score += 8
      reasons.push('季度合集')
    }
  }
  const languageWeight = { bilingual: 8, english: 6, chinese: 3, unknown: 0 }
  score += languageWeight[candidate.language || 'unknown']
  if (candidate.downloads) score += Math.min(8, Math.log10(candidate.downloads + 1) * 2)
  return { ...candidate, score: Math.round(score * 100) / 100, scoreReasons: reasons }
}

export function candidateId(source: string, pageUrl: string): string {
  return createHash('sha1').update(`${source}|${pageUrl}`).digest('hex')
}

function tokenSimilarity(left: string, right: string): number {
  if (!left || !right) return 0
  if (left === right) return 1
  if (right.includes(left) || left.includes(right)) return 0.9
  const a = new Set(left.split(' '))
  const b = new Set(right.split(' '))
  const intersection = [...a].filter((value) => b.has(value)).length
  return intersection / Math.max(a.size, b.size, 1)
}

const pad = (value: number) => String(value).padStart(2, '0')
