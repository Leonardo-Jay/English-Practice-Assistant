import { describe, expect, it } from 'vitest'
import type {
  ConversationSummary,
  CorrectionContext,
  Message
} from '../../shared/types'
import type {
  ConversationRepository,
  MessageRepository
} from '../database/repositories'
import {
  CorrectionContextAssembler,
  segmentCorrectionSentences
} from './correction-context'

const conversation: ConversationSummary = {
  id: 'conversation-1',
  title: 'TV drama',
  practiceMode: 'free',
  topic: 'The Vampire Diaries',
  preview: '',
  messageCount: 4,
  contentRevision: 4,
  analysisRevision: 0,
  createdAt: 1,
  updatedAt: 1,
  lastOpenedAt: 1
}

function message(
  id: string,
  sequence: number,
  role: Message['role'],
  content: string,
  conversationId = conversation.id
): Message {
  return {
    id,
    conversationId,
    sequence,
    role,
    content,
    timestamp: sequence,
    status: 'complete'
  }
}

function assembler(options: {
  target?: Message
  previous?: Message[]
  summary?: string
  conversation?: ConversationSummary | null
} = {}): CorrectionContextAssembler {
  const target =
    options.target ||
    message(
      'target',
      5,
      'user',
      'My favorite character is Damon. The demon is very handsome.'
    )
  const conversations = {
    getSummary: () =>
      options.conversation === undefined
        ? conversation
        : options.conversation,
    getContextState: () => ({
      summary: options.summary || '',
      throughSequence: 0,
      promptVersion: 1
    })
  } as unknown as ConversationRepository
  const messages = {
    get: (id: string) => (id === target.id ? target : null),
    getBeforeSequence: () => options.previous || []
  } as unknown as MessageRepository
  return new CorrectionContextAssembler(conversations, messages)
}

describe('segmentCorrectionSentences', () => {
  it('creates stable indexes and offsets for multiple semantic sentences', () => {
    expect(
      segmentCorrectionSentences(
        'My favorite character is Damon. The demon is very handsome!\nHe is cool'
      )
    ).toEqual([
      {
        index: 0,
        text: 'My favorite character is Damon.',
        startOffset: 0,
        endOffset: 31
      },
      {
        index: 1,
        text: 'The demon is very handsome!',
        startOffset: 32,
        endOffset: 59
      },
      {
        index: 2,
        text: 'He is cool',
        startOffset: 60,
        endOffset: 70
      }
    ])
  })

  it('uses the whole utterance when there is no sentence punctuation', () => {
    const units = segmentCorrectionSentences('  I very like this movie  ')
    expect(units).toHaveLength(1)
    expect(units[0].text).toBe('I very like this movie')
  })
})

describe('CorrectionContextAssembler', () => {
  it('uses only bounded messages before the target and starts at a user turn', () => {
    const previous = [
      message('old-assistant', 1, 'assistant', 'Old reply'),
      message('recent-user', 2, 'user', 'I am watching The Vampire Diaries.'),
      message('recent-assistant', 3, 'assistant', 'Who is your favorite character?')
    ]
    const result = assembler({ previous }).build(conversation.id, 'target')
    expect(result.previousMessages).toEqual([
      { role: 'user', content: 'I am watching The Vampire Diaries.' },
      { role: 'assistant', content: 'Who is your favorite character?' }
    ])
    expect(result.sentences).toHaveLength(2)
    expect(result.targetText).toContain('Damon')
  })

  it('bounds a long summary while retaining both ends', () => {
    const summary = `profile:${'a'.repeat(1_000)}direction:${'b'.repeat(1_000)}`
    const result = assembler({ summary }).build(conversation.id, 'target')
    expect(result.contextSummary.length).toBeLessThanOrEqual(1_200)
    expect(result.contextSummary.startsWith('profile:')).toBe(true)
    expect(result.contextSummary.endsWith('b'.repeat(20))).toBe(true)
  })

  it('rejects a target from another conversation', () => {
    const target = message('target', 2, 'user', 'Hello', 'other-conversation')
    expect(() =>
      assembler({ target }).build(conversation.id, target.id)
    ).toThrow('不属于当前会话')
  })

  it('supports a first message without prior context', () => {
    const result: CorrectionContext = assembler({ previous: [] }).build(
      conversation.id,
      'target'
    )
    expect(result.previousMessages).toEqual([])
  })
})
