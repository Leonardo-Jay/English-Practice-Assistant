import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetch: vi.fn()
}))

vi.mock('electron', () => ({
  net: {
    fetch: mocks.fetch
  }
}))

import { LLMClient } from './llm-client'
import type {
  CorrectionContext,
  LLMModelSwitchEvent,
  Message
} from '../../shared/types'

function response(content: string, extras: Record<string, unknown> = {}): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: { content },
          finish_reason: 'stop',
          ...extras
        }
      ]
    }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    }
  )
}

function client(): LLMClient {
  const instance = new LLMClient()
  instance.configure({
    provider: 'longcat',
    baseUrl: 'https://api.longcat.chat/openai/v1/chat/completions',
    apiKey: 'test-key',
    apiId: '',
    model: 'LongCat-2.0-Preview'
  })
  return instance
}

function modelScopeClient(
  onModelSwitched?: (event: LLMModelSwitchEvent) => void
): LLMClient {
  const instance = new LLMClient(onModelSwitched)
  instance.configure({
    id: 'modelscope-profile',
    name: 'ModelScope',
    provider: 'modelscope',
    baseUrl: 'https://api-inference.modelscope.cn/v1/chat/completions',
    apiKey: 'modelscope-token',
    apiId: '',
    model: 'deepseek-ai/DeepSeek-V4-Flash'
  })
  return instance
}

describe('LLM analysis reliability', () => {
  beforeEach(() => {
    mocks.fetch.mockReset()
  })

  it('supplies recent user turns so a title and episode scope can be combined', async () => {
    mocks.fetch.mockResolvedValueOnce(
      response(JSON.stringify({
        mediaType: 'tv',
        title: 'White Collar',
        aliases: [],
        season: 1,
        episode: 8,
        evidenceText: 'White Collar',
        confidence: 0.98
      }))
    )

    const result = await client().detectMediaMention(
      'Can we talk about this TV drama, Season 1 Episode 8?',
      [
        { role: 'user', content: 'I mean, it is White Collar.' },
        { role: 'assistant', content: 'Sure.' }
      ]
    )

    expect(result).toMatchObject({
      title: 'White Collar',
      season: 1,
      episode: 8,
      evidenceText: 'White Collar'
    })
    const body = JSON.parse(
      String(mocks.fetch.mock.calls[0][1]?.body)
    ) as { messages: Array<{ role: string; content: string }> }
    const payload = JSON.parse(body.messages[body.messages.length - 1].content)
    expect(payload.recentUserMessages).toEqual([
      'I mean, it is White Collar.'
    ])
  })

  it('retries an empty reasoning response with thinking disabled and more output tokens', async () => {
    mocks.fetch
      .mockResolvedValueOnce(
        response('', {
          message: {
            content: '',
            reasoning_content: 'internal reasoning that exhausted the first budget'
          },
          finish_reason: 'length'
        })
      )
      .mockResolvedValueOnce(
        response(
          JSON.stringify({
            corrections: [
              {
                original: 'The demon is',
                corrected: 'Damon is',
                type: 'vocabulary',
                explanation: '这里把人名 Damon 识别成了 demon。'
              }
            ]
          })
        )
      )

    const result = await client().analyzeCorrections(
      'The demon is a very cruel and handsome vampire.'
    )

    expect(result).toHaveLength(1)
    expect(result[0].corrected).toBe('Damon is')
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    const firstBody = JSON.parse(
      String(mocks.fetch.mock.calls[0][1]?.body)
    ) as Record<string, unknown>
    const retryBody = JSON.parse(
      String(mocks.fetch.mock.calls[1][1]?.body)
    ) as Record<string, unknown>
    expect(firstBody.thinking).toEqual({ type: 'disabled' })
    expect(retryBody.max_tokens).toBe(2_200)
  })

  it('regenerates a truncated subtitle-scene JSON response with a larger budget', async () => {
    mocks.fetch
      .mockResolvedValueOnce(
        response(
          '{"summary":"Damon warns Stefan","characters":["Damon","Stefan"],"relationshipChanges":[],"plotFacts":["Damon says'
        )
      )
      .mockResolvedValueOnce(
        response(JSON.stringify({
          summary: 'Damon 警告 Stefan 不要干涉。',
          characters: ['Damon', 'Stefan'],
          relationshipChanges: [],
          plotFacts: ['Damon 向 Stefan 发出警告。'],
          keyDialogue: ['Stay out of it.'],
          uncertainties: []
        }))
      )

    const result = await client().analyzeSubtitleScene({
      id: 'scene-1',
      ordinal: 0,
      startMs: 0,
      endMs: 60_000,
      dialogue: 'Damon: Stay out of it.\nStefan: I cannot.'
    })

    expect(result.summary).toContain('Damon')
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    const retryBody = JSON.parse(
      String(mocks.fetch.mock.calls[1][1]?.body)
    ) as {
      max_tokens: number
      messages: Array<{ role: string; content: string }>
    }
    expect(retryBody.max_tokens).toBe(1_800)
    expect(retryBody.messages[0].content).toContain('RETRY NOTICE')
  })

  it('regenerates a truncated episode-merge JSON response', async () => {
    mocks.fetch
      .mockResolvedValueOnce(
        response(
          '{"plotSummary":"Elena arrives at school","characters":["Elena"],"relationships":[],"orderedEvents":["Elena'
        )
      )
      .mockResolvedValueOnce(
        response(JSON.stringify({
          plotSummary: 'Elena 来到学校，并遇到了 Stefan。',
          characters: ['Elena', 'Stefan'],
          relationships: ['Elena 与 Stefan 初次相遇。'],
          orderedEvents: ['Elena 到达学校。', 'Elena 遇见 Stefan。'],
          keyDialogue: [],
          uncertainties: []
        }))
      )

    const result = await client().mergeEpisodeKnowledge(
      {
        type: 'tv',
        title: 'The Vampire Diaries',
        normalizedTitle: 'the vampire diaries',
        aliases: [],
        confirmed: true
      },
      [{
        id: 'scene-1',
        ordinal: 0,
        startMs: 0,
        endMs: 60_000,
        dialogue: 'Hello.',
        analysis: {
          summary: 'Elena 与 Stefan 初次见面。',
          characters: ['Elena', 'Stefan'],
          relationshipChanges: [],
          plotFacts: ['两人在学校见面。'],
          keyDialogue: [],
          uncertainties: []
        }
      }],
      1,
      1
    )

    expect(result.plotSummary).toContain('Stefan')
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    const retryBody = JSON.parse(
      String(mocks.fetch.mock.calls[1][1]?.body)
    ) as { max_tokens: number }
    expect(retryBody.max_tokens).toBe(3_200)
  })

  it('requests a short plain-text chat reply and normalizes formatting artifacts', async () => {
    mocks.fetch.mockResolvedValueOnce(
      response('**That\u2019s** actually helpful \u{1F60A}.')
    )

    const result = await client().chatReply([{
      id: 'user-1',
      role: 'user',
      content: 'Here is another clue.',
      timestamp: Date.now()
    }])

    expect(result).toBe("That's actually helpful.")
    const body = JSON.parse(
      String(mocks.fetch.mock.calls[0][1]?.body)
    ) as {
      messages: Array<{ role: string; content: string }>
    }
    const systemPrompt = body.messages[0].content
    expect(systemPrompt).toContain('no more than 60 English words')
    expect(systemPrompt).toContain('Never use JSON, Markdown')
    expect(systemPrompt).toContain('straight apostrophes')
  })

  it('hides leaked reasoning and disables thinking for ModelScope Qwen3 chat', async () => {
    mocks.fetch.mockResolvedValueOnce(
      response(
        '<think>I should reveal no internal reasoning.</think>\n\nSense8 has a special kind of magic.'
      )
    )
    const instance = new LLMClient()
    instance.configure({
      id: 'modelscope-profile',
      name: 'ModelScope',
      provider: 'modelscope',
      baseUrl: 'https://api-inference.modelscope.cn/v1/chat/completions',
      apiKey: 'modelscope-token',
      apiId: '',
      model: 'Qwen/Qwen3-8B'
    })

    await expect(
      instance.chatReply([{
        id: 'user-1',
        role: 'user',
        content: 'I love Sense8.',
        timestamp: Date.now()
      }])
    ).resolves.toBe('Sense8 has a special kind of magic.')

    const body = JSON.parse(
      String(mocks.fetch.mock.calls[0][1]?.body)
    ) as { enable_thinking?: boolean }
    expect(body.enable_thinking).toBe(false)
  })

  it('serializes correction and vocabulary requests', async () => {
    let activeRequests = 0
    let maximumActiveRequests = 0
    mocks.fetch.mockImplementation(async (_url, init) => {
      activeRequests += 1
      maximumActiveRequests = Math.max(maximumActiveRequests, activeRequests)
      await new Promise((resolve) => setTimeout(resolve, 15))
      activeRequests -= 1
      const body = JSON.parse(String(init?.body)) as {
        messages?: Array<{ content?: string }>
      }
      const systemPrompt = body.messages?.[0]?.content || ''
      return response(
        systemPrompt.includes('correction engine')
          ? '{"corrections":[]}'
          : '{"vocabulary":[]}'
      )
    })

    const instance = client()
    await Promise.all([
      instance.analyzeCorrections('Damon is a vampire.'),
      instance.analyzeVocabulary('Damon is charming but dangerous.')
    ])

    expect(maximumActiveRequests).toBe(1)
  })

  it('keeps distinct span and sentence issues while rejecting formatting and invalid indexes', async () => {
    mocks.fetch.mockResolvedValueOnce(
      response(JSON.stringify({
        corrections: [
          {
            sentenceIndex: 0,
            scope: 'span',
            original: 'I very like',
            corrected: 'I like',
            type: 'grammar',
            explanation: '程度副词不能直接这样修饰 like。'
          },
          {
            sentenceIndex: 0,
            scope: 'sentence',
            original: 'I very like this show.',
            corrected: 'I like this show very much.',
            type: 'expression',
            explanation: '整句使用 like...very much 更符合自然口语表达。'
          },
          {
            sentenceIndex: 1,
            scope: 'span',
            original: 'He is cool.',
            corrected: 'he is cool',
            type: 'grammar',
            explanation: '这里只改变了大小写和标点。'
          },
          {
            sentenceIndex: 99,
            scope: 'span',
            original: 'Damon',
            corrected: 'Damon Salvatore',
            type: 'vocabulary',
            explanation: '索引无效，不应保留。'
          }
        ]
      }))
    )
    const context: CorrectionContext = {
      conversationId: 'conversation',
      userMessageId: 'user-message',
      practiceMode: 'free',
      contextSummary: '',
      previousMessages: [],
      targetText: 'I very like this show. He is cool.',
      sentences: [
        {
          index: 0,
          text: 'I very like this show.',
          startOffset: 0,
          endOffset: 22
        },
        {
          index: 1,
          text: 'He is cool.',
          startOffset: 23,
          endOffset: 34
        }
      ]
    }
    const result = await client().analyzeCorrections(
      context.targetText,
      context
    )
    expect(result).toHaveLength(2)
    expect(result.map((item) => item.scope)).toEqual(['span', 'sentence'])
    expect(result.every((item) => item.sentenceIndex === 0)).toBe(true)
  })

  it('switches to the next ModelScope model and replays the request after a daily quota 429', async () => {
    const switched = vi.fn()
    mocks.fetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message:
                "You have exceeded today's quota for model deepseek-ai/DeepSeek-V4-Flash, please try again tomorrow, or consider using other models"
            }
          }),
          {
            status: 429,
            headers: { 'Content-Type': 'application/json' }
          }
        )
      )
      .mockResolvedValueOnce(response('The next model is available.'))

    const messages: Message[] = [{
      id: 'user-1',
      role: 'user',
      content: 'Hello.',
      timestamp: Date.now()
    }]
    const result = await modelScopeClient(switched).chatReply(messages)

    expect(result).toBe('The next model is available.')
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    const models = mocks.fetch.mock.calls.map((call) => {
      const body = JSON.parse(String(call[1]?.body)) as { model: string }
      return body.model
    })
    expect(models).toEqual([
      'deepseek-ai/DeepSeek-V4-Flash',
      'Qwen/Qwen3-Next-80B-A3B-Instruct'
    ])
    expect(switched).toHaveBeenCalledWith({
      profileId: 'modelscope-profile',
      previousModel: 'deepseek-ai/DeepSeek-V4-Flash',
      model: 'Qwen/Qwen3-Next-80B-A3B-Instruct',
      reason: 'daily-quota-exhausted'
    })
  })

  it('switches models for the ModelScope model-specific rate-limit response', async () => {
    const switched = vi.fn()
    mocks.fetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message:
                'We have to rate limit you for model Qwen/Qwen3-Next-80B-A3B-Instruct. If you need higher limits, please consider other (commercial) API providers.',
              request_id: 'rate-limit-request'
            }
          }),
          {
            status: 429,
            headers: { 'Content-Type': 'application/json' }
          }
        )
      )
      .mockResolvedValueOnce(response('{"vocabulary":[]}'))

    const instance = new LLMClient(switched)
    instance.configure({
      id: 'modelscope-profile',
      name: 'ModelScope',
      provider: 'modelscope',
      baseUrl: 'https://api-inference.modelscope.cn/v1/chat/completions',
      apiKey: 'modelscope-token',
      apiId: '',
      model: 'Qwen/Qwen3-Next-80B-A3B-Instruct'
    })

    await expect(
      instance.analyzeVocabulary(
        'Choosing loyalty over desire can make a character interesting.'
      )
    ).resolves.toEqual([])

    const models = mocks.fetch.mock.calls.map((call) => {
      const body = JSON.parse(String(call[1]?.body)) as { model: string }
      return body.model
    })
    expect(models).toEqual([
      'Qwen/Qwen3-Next-80B-A3B-Instruct',
      'Qwen/Qwen3-VL-8B-Instruct'
    ])
    expect(switched).toHaveBeenCalledWith({
      profileId: 'modelscope-profile',
      previousModel: 'Qwen/Qwen3-Next-80B-A3B-Instruct',
      model: 'Qwen/Qwen3-VL-8B-Instruct',
      reason: 'model-rate-limited'
    })
  })

  it('skips a ModelScope candidate with no provider and commits only the successful fallback', async () => {
    const switched = vi.fn()
    mocks.fetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message:
                'We have to rate limit you for model Qwen/Qwen3-8B.'
            }
          }),
          {
            status: 429,
            headers: { 'Content-Type': 'application/json' }
          }
        )
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message:
                'Model id : Qwen/Qwen3-32B , has no provider supported'
            }
          }),
          {
            status: 400,
            headers: { 'Content-Type': 'application/json' }
          }
        )
      )
      .mockResolvedValueOnce(response('The available model answered.'))

    const instance = new LLMClient(switched)
    instance.configure({
      id: 'modelscope-profile',
      name: 'ModelScope',
      provider: 'modelscope',
      baseUrl: 'https://api-inference.modelscope.cn/v1/chat/completions',
      apiKey: 'modelscope-token',
      apiId: '',
      model: 'Qwen/Qwen3-8B'
    })

    await expect(
      instance.chatReply([{
        id: 'user-1',
        role: 'user',
        content: 'Continue.',
        timestamp: Date.now()
      }])
    ).resolves.toBe('The available model answered.')

    const models = mocks.fetch.mock.calls.map((call) => {
      const body = JSON.parse(String(call[1]?.body)) as { model: string }
      return body.model
    })
    expect(models).toEqual([
      'Qwen/Qwen3-8B',
      'Qwen/Qwen3-32B',
      'Qwen/Qwen3-14B'
    ])
    expect(switched).toHaveBeenCalledTimes(1)
    expect(switched).toHaveBeenCalledWith({
      profileId: 'modelscope-profile',
      previousModel: 'Qwen/Qwen3-8B',
      model: 'Qwen/Qwen3-14B',
      reason: 'model-rate-limited'
    })
  })

  it('disables thinking for ModelScope analysis and rotates after two empty choice responses', async () => {
    const switched = vi.fn()
    mocks.fetch
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'empty-1', choices: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ id: 'empty-2', choices: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      )
      .mockResolvedValueOnce(response('{"vocabulary":[]}'))

    await expect(
      modelScopeClient(switched).analyzeVocabulary(
        'Choosing loyalty over desire can make a character interesting.'
      )
    ).resolves.toEqual([])

    const bodies = mocks.fetch.mock.calls.map((call) =>
      JSON.parse(String(call[1]?.body)) as {
        model: string
        enable_thinking?: boolean
      }
    )
    expect(bodies.map((body) => body.model)).toEqual([
      'deepseek-ai/DeepSeek-V4-Flash',
      'deepseek-ai/DeepSeek-V4-Flash',
      'Qwen/Qwen3-Next-80B-A3B-Instruct'
    ])
    expect(bodies.every((body) => body.enable_thinking === false)).toBe(true)
    expect(switched).toHaveBeenCalledWith({
      profileId: 'modelscope-profile',
      previousModel: 'deepseek-ai/DeepSeek-V4-Flash',
      model: 'Qwen/Qwen3-Next-80B-A3B-Instruct',
      reason: 'empty-response'
    })
  })

  it('recognizes a ModelScope rate-limit error wrapped in an HTTP 200 response', async () => {
    const switched = vi.fn()
    mocks.fetch
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message:
                'We have to rate limit you for model deepseek-ai/DeepSeek-V4-Flash.',
              request_id: 'business-error-request'
            }
          }),
          {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          }
        )
      )
      .mockResolvedValueOnce(response('The fallback worked.'))

    await expect(
      modelScopeClient(switched).chatReply([{
        id: 'user-1',
        role: 'user',
        content: 'Hello.',
        timestamp: Date.now()
      }])
    ).resolves.toBe('The fallback worked.')

    expect(switched).toHaveBeenCalledWith({
      profileId: 'modelscope-profile',
      previousModel: 'deepseek-ai/DeepSeek-V4-Flash',
      model: 'Qwen/Qwen3-Next-80B-A3B-Instruct',
      reason: 'model-rate-limited'
    })
  })

  it('does not rotate ModelScope models for an ordinary rate-limit 429', async () => {
    mocks.fetch
      .mockResolvedValueOnce(
        new Response('Too many requests. Retry shortly.', { status: 429 })
      )
      .mockResolvedValueOnce(
        new Response('Too many requests. Retry shortly.', { status: 429 })
      )
    const switched = vi.fn()

    await expect(
      modelScopeClient(switched).chatReply([{
        id: 'user-1',
        role: 'user',
        content: 'Hello.',
        timestamp: Date.now()
      }])
    ).rejects.toThrow('ModelScope 魔搭社区请求失败（429）')

    expect(switched).not.toHaveBeenCalled()
    const models = mocks.fetch.mock.calls.map((call) => {
      const body = JSON.parse(String(call[1]?.body)) as { model: string }
      return body.model
    })
    expect(models).toEqual([
      'deepseek-ai/DeepSeek-V4-Flash',
      'deepseek-ai/DeepSeek-V4-Flash'
    ])
  })
})
