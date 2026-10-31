import { describe, expect, it } from 'vitest'
import { normalizeAssistantReplyText } from './assistant-text'

describe('normalizeAssistantReplyText', () => {
  it('normalizes smart and full-width punctuation plus unusual spacing', () => {
    expect(
      normalizeAssistantReplyText(
        'That\u2019s\u3000actually pretty rare\uFF01 It can \u201Cwork\u201D.'
      )
    ).toBe('That\'s actually pretty rare! It can "work".')
  })

  it('removes markdown decoration and emoji without changing the words', () => {
    expect(
      normalizeAssistantReplyText(
        '**Damon** is *interesting* \u{1F60A}. [Try again](https://example.com).'
      )
    ).toBe('Damon is interesting. Try again.')
  })

  it('removes zero-width characters and markdown list markers', () => {
    expect(
      normalizeAssistantReplyText(
        '- They can\u200Bnot stay together.\n- They still care about each other.'
      )
    ).toBe(
      'They cannot stay together.\nThey still care about each other.'
    )
  })

  it('removes leaked model reasoning blocks and keeps only the final reply', () => {
    expect(
      normalizeAssistantReplyText(
        '<think>The user likes this show. I should answer briefly.</think>\n\nThat\'s the spirit! Sense8 has a special kind of magic.'
      )
    ).toBe("That's the spirit! Sense8 has a special kind of magic.")
    expect(
      normalizeAssistantReplyText(
        '<analysis>Internal reasoning must stay hidden.</analysis>Final answer.'
      )
    ).toBe('Final answer.')
  })

  it('returns empty text for an unclosed reasoning-only response', () => {
    expect(
      normalizeAssistantReplyText(
        '<think>I am still reasoning and never produced a final answer.'
      )
    ).toBe('')
  })
})
