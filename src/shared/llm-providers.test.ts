import { describe, expect, it } from 'vitest'
import {
  MODELSCOPE_MODEL_FALLBACKS,
  inferLLMProvider,
  resolveLLMEndpoint,
  validateLLMConfig
} from './llm-providers'
import type { LLMConfig } from './types'

const config = (
  provider: LLMConfig['provider'],
  baseUrl: string,
  overrides: Partial<LLMConfig> = {}
): LLMConfig => ({
  provider,
  baseUrl,
  apiKey: 'test-key',
  apiId: '',
  model: 'test-model',
  ...overrides
})

describe('LLM provider adapters', () => {
  it('keeps the uploaded APIHZ PHP endpoint and uses the form protocol', () => {
    expect(
      resolveLLMEndpoint(
        config('apihz', 'https://cn.apihz.cn/api/ai/zpflash.php', {
          apiId: '88888888',
          model: ''
        })
      )
    ).toEqual({
      endpoint: 'https://cn.apihz.cn/api/ai/zpflash.php',
      protocol: 'apihz',
      provider: 'apihz'
    })
  })

  it('builds the Baidu Qianfan V2 endpoint without inserting an extra v1', () => {
    expect(
      resolveLLMEndpoint(
        config('qianfan', 'https://qianfan.baidubce.com/v2')
      ).endpoint
    ).toBe('https://qianfan.baidubce.com/v2/chat/completions')
  })

  it('builds the official LongCat OpenAI-compatible endpoint', () => {
    expect(
      resolveLLMEndpoint(config('longcat', 'https://api.longcat.chat')).endpoint
    ).toBe('https://api.longcat.chat/openai/v1/chat/completions')
    expect(
      resolveLLMEndpoint(
        config('longcat', 'https://api.longcat.chat/openai')
      ).endpoint
    ).toBe('https://api.longcat.chat/openai/v1/chat/completions')
  })

  it('builds and infers the official ModelScope OpenAI-compatible endpoint', () => {
    expect(
      resolveLLMEndpoint(
        config('modelscope', 'https://api-inference.modelscope.cn/v1')
      ).endpoint
    ).toBe('https://api-inference.modelscope.cn/v1/chat/completions')
    expect(
      inferLLMProvider({
        baseUrl: 'https://api-inference.modelscope.cn/v1/chat/completions'
      })
    ).toBe('modelscope')
    expect(MODELSCOPE_MODEL_FALLBACKS[0]).toBe(
      'deepseek-ai/DeepSeek-V4-Flash'
    )
  })

  it('preserves complete OpenAI and Anthropic endpoints', () => {
    expect(
      resolveLLMEndpoint(
        config('openai', 'https://example.com/v1/chat/completions')
      ).endpoint
    ).toBe('https://example.com/v1/chat/completions')
    expect(
      resolveLLMEndpoint(
        config('anthropic', 'https://example.com/v1/messages')
      ).endpoint
    ).toBe('https://example.com/v1/messages')
  })

  it('infers providers while migrating legacy single-model settings', () => {
    expect(inferLLMProvider({ baseUrl: 'https://cn.apihz.cn/api/ai/zpflash.php' }))
      .toBe('apihz')
    expect(inferLLMProvider({ baseUrl: 'https://qianfan.baidubce.com/v2' }))
      .toBe('qianfan')
    expect(inferLLMProvider({ baseUrl: 'https://api.longcat.chat/openai' }))
      .toBe('longcat')
    expect(
      inferLLMProvider({
        baseUrl: 'https://api-inference.modelscope.cn/v1'
      })
    ).toBe('modelscope')
  })

  it('requires the APIHZ developer ID but not a model name', () => {
    expect(
      validateLLMConfig(
        config('apihz', 'https://cn.apihz.cn/api/ai/zpflash.php', {
          apiId: '',
          model: ''
        })
      )
    ).toBe('接口盒子配置需要填写开发者 ID。')
    expect(
      validateLLMConfig(
        config('apihz', 'https://cn.apihz.cn/api/ai/zpflash.php', {
          apiId: '88888888',
          model: ''
        })
      )
    ).toBeUndefined()
  })
})
