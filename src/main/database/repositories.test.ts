import { describe, expect, it } from 'vitest'
import {
  ENGLISH_NORMALIZATION_VERSION,
  buildCorrectionPrompt,
  normalizeEnglishTerm
} from './repositories'

describe('normalizeEnglishTerm', () => {
  it('normalizes case, spacing, punctuation and apostrophes without changing the source value', () => {
    const source = '  “Genuinely Useful”  '
    expect(normalizeEnglishTerm(source)).toBe('genuinely useful')
    expect(source).toBe('  “Genuinely Useful”  ')
  })

  it('keeps useful phrase boundaries and normalizes curly apostrophes', () => {
    expect(normalizeEnglishTerm("  Don’t   give up! ")).toBe("don't give up")
  })

  it('publishes a normalization version for future dictionary backfills', () => {
    expect(ENGLISH_NORMALIZATION_VERSION).toBe(1)
  })
})

describe('buildCorrectionPrompt', () => {
  it('keeps the complete assistant reply in a contextual correction card', () => {
    const ending = 'This final question must remain visible in the review card.'
    const assistantReply = `${'A detailed but relevant conversation context. '.repeat(8)}${ending}`
    const prompt = buildCorrectionPrompt(
      'complete-context',
      'I want to explain my answer again.',
      assistantReply
    )

    expect(assistantReply.length).toBeGreaterThan(180)
    expect(prompt).toContain(ending)
    expect(prompt).toContain(assistantReply)
    expect(prompt).not.toContain('This final question must remain…')
  })
})
