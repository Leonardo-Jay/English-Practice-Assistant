import { describe, expect, it } from 'vitest'
import {
  buildSearchQueries,
  normalizeMediaTitle,
  scoreSubtitleCandidate,
  validateMediaIntent
} from './search-planner'

const media = {
  type: 'tv' as const,
  title: 'The Vampire Diaries',
  normalizedTitle: 'the vampire diaries',
  aliases: ['吸血鬼日记'],
  confirmed: true
}

describe('subtitle search planner', () => {
  it('builds exact English and Chinese queries before broad title queries', () => {
    const queries = buildSearchQueries(media, 1, 3)
    expect(queries.map((item) => item.text)).toContain('The Vampire Diaries S01E03')
    expect(queries.map((item) => item.text)).toContain('吸血鬼日记 第1季 第3集')
    expect(queries.findIndex((item) => item.kind === 'exact-episode')).toBeLessThan(
      queries.findIndex((item) => item.kind === 'title')
    )
  })

  it('penalizes a popular wrong episode below an exact episode', () => {
    const exact = scoreSubtitleCandidate({
      id: 'exact',
      source: 'subhd',
      title: 'The Vampire Diaries S01E03',
      pageUrl: 'https://example.com/exact',
      language: 'english',
      packType: 'episode',
      season: 1,
      episode: 3,
      downloads: 5
    }, media, 1, 3)
    const wrong = scoreSubtitleCandidate({
      id: 'wrong',
      source: 'subhd',
      title: 'The Vampire Diaries S01E04',
      pageUrl: 'https://example.com/wrong',
      language: 'bilingual',
      packType: 'episode',
      season: 1,
      episode: 4,
      downloads: 100_000
    }, media, 1, 3)
    expect(exact.score).toBeGreaterThan(wrong.score)
  })

  it('normalizes punctuation and rejects malformed intent', () => {
    expect(normalizeMediaTitle('  The: Vampire—Diaries! ')).toBe(
      'the vampire diaries'
    )
    expect(validateMediaIntent({ action: 'download-everything' })).toBeUndefined()
  })
})
