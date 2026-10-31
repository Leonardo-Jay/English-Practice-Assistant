import { describe, expect, it } from 'vitest'
import { inferDownloadedPackType } from './subtitle-service'

const media = {
  type: 'tv' as const,
  title: '妙警贼探',
  normalizedTitle: '妙警贼探',
  aliases: ['White Collar'],
  confirmed: true
}

describe('downloaded subtitle package scope inference', () => {
  it('reclassifies a legacy unknown multi-season archive as a series package', () => {
    expect(inferDownloadedPackType(
      media,
      'unknown',
      [
        'White.Collar.S01E01.Pilot.ass',
        'White.Collar.S01E07.Free.Fall.ass',
        'White.Collar.S02E01.Withdrawal.ass'
      ],
      1,
      1
    )).toBe('series')
  })

  it('keeps multiple episodes from one season at season scope', () => {
    expect(inferDownloadedPackType(
      media,
      'unknown',
      [
        'White.Collar.S01E01.Pilot.ass',
        'White.Collar.S01E07.Free.Fall.ass',
        'White.Collar.S01E08.Hard.Sell.ass'
      ],
      1,
      1
    )).toBe('season')
  })
})
