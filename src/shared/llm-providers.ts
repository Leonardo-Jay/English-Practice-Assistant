import type {
  LLMConfig,
  LLMProfile,
  LLMProvider
} from './types'

export interface LLMProviderDefinition {
  id: LLMProvider
  label: string
  description: string
  defaultBaseUrl: string
  defaultModel: string
  baseUrlPlaceholder: string
  modelPlaceholder: string
  requiresApiId: boolean
}

export const MODELSCOPE_MODEL_FALLBACKS = [
  'deepseek-ai/DeepSeek-V4-Flash',
  'Qwen/Qwen3-Next-80B-A3B-Instruct',
  'Qwen/Qwen3-VL-8B-Instruct',
  'Qwen/Qwen3-8B',
  'Qwen/Qwen3-32B',
  'Qwen/Qwen3-14B',
  'Qwen/Qwen3-235B-A22B-Instruct-2507',
  'MiniMax/MiniMax-M1-80k'
] as const

export const LLM_PROVIDER_DEFINITIONS: LLMProviderDefinition[] = [
  {
    id: 'openai',
    label: 'OpenAI 兼容接口',
    description: '适用于 OpenAI、DeepSeek 以及其他兼容 Chat Completions 的服务。',
    defaultBaseUrl: '',
    defaultModel: '',
    baseUrlPlaceholder: 'https://api.example.com/v1/chat/completions',
    modelPlaceholder: '模型名称或部署名称',
    requiresApiId: false
  },
  {
    id: 'anthropic',
    label: 'Anthropic 兼容接口',
    description: '使用 Messages API，适用于 Anthropic 及其兼容服务。',
    defaultBaseUrl: 'https://api.anthropic.com/v1/messages',
    defaultModel: '',
    baseUrlPlaceholder: 'https://api.anthropic.com/v1/messages',
    modelPlaceholder: 'Claude 模型名称',
    requiresApiId: false
  },
  {
    id: 'apihz',
    label: '接口盒子（智谱 GLM）',
    description: '适配上传文档中的 id、key、words 表单接口。',
    defaultBaseUrl: 'https://cn.apihz.cn/api/ai/zpflash.php',
    defaultModel: 'GLM-4-Flash-250414',
    baseUrlPlaceholder: 'https://cn.apihz.cn/api/ai/zpflash.php',
    modelPlaceholder: '仅用于配置显示',
    requiresApiId: true
  },
  {
    id: 'qianfan',
    label: '百度千帆',
    description: '使用千帆 V2 Chat Completions 接口和 Bearer API Key。',
    defaultBaseUrl: 'https://qianfan.baidubce.com/v2/chat/completions',
    defaultModel: '',
    baseUrlPlaceholder: 'https://qianfan.baidubce.com/v2/chat/completions',
    modelPlaceholder: '千帆控制台中的模型 ID / API 名称',
    requiresApiId: false
  },
  {
    id: 'longcat',
    label: 'LongCat',
    description: '使用 LongCat 官方 OpenAI 兼容接口。',
    defaultBaseUrl: 'https://api.longcat.chat/openai/v1/chat/completions',
    defaultModel: 'LongCat-2.0-Preview',
    baseUrlPlaceholder: 'https://api.longcat.chat/openai/v1/chat/completions',
    modelPlaceholder: 'LongCat-2.0-Preview',
    requiresApiId: false
  },
  {
    id: 'modelscope',
    label: 'ModelScope 魔搭社区',
    description:
      '使用魔搭社区 OpenAI 兼容接口；当前模型今日额度用尽时，会按候选列表自动切换并重试。',
    defaultBaseUrl: 'https://api-inference.modelscope.cn/v1/chat/completions',
    defaultModel: MODELSCOPE_MODEL_FALLBACKS[0],
    baseUrlPlaceholder: 'https://api-inference.modelscope.cn/v1/chat/completions',
    modelPlaceholder: MODELSCOPE_MODEL_FALLBACKS[0],
    requiresApiId: false
  }
]

export function getLLMProviderDefinition(
  provider: LLMProvider
): LLMProviderDefinition {
  return (
    LLM_PROVIDER_DEFINITIONS.find((item) => item.id === provider) ||
    LLM_PROVIDER_DEFINITIONS[0]
  )
}

export function inferLLMProvider(config: Pick<LLMConfig, 'baseUrl'>): LLMProvider {
  const value = config.baseUrl.trim().toLowerCase()
  if (value.includes('api-inference.modelscope.cn')) return 'modelscope'
  if (value.includes('longcat.chat')) return 'longcat'
  if (value.includes('qianfan.baidubce.com') || value.includes('baiduqianfan.ai')) {
    return 'qianfan'
  }
  if (/\.php(?:$|[?#])/.test(value) || value.includes('apihz.cn/api/ai/')) {
    return 'apihz'
  }
  if (value.includes('/anthropic') || /\/v\d+\/messages(?:$|[?#])/.test(value)) {
    return 'anthropic'
  }
  return 'openai'
}

export function normalizeLLMConfig(config: LLMConfig): LLMConfig {
  const provider = config.provider || inferLLMProvider(config)
  const definition = getLLMProviderDefinition(provider)
  return {
    ...config,
    provider,
    baseUrl: config.baseUrl.trim() || definition.defaultBaseUrl,
    apiKey: config.apiKey.trim(),
    apiId: config.apiId.trim(),
    model: config.model.trim() || definition.defaultModel
  }
}

export function validateLLMConfig(config: LLMConfig): string | undefined {
  const normalized = normalizeLLMConfig(config)
  const provider = normalized.provider || 'openai'
  const definition = getLLMProviderDefinition(provider)
  if (!normalized.baseUrl) return '请填写接口地址。'
  try {
    const url = new URL(normalized.baseUrl)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') {
      return '接口地址必须使用 HTTP 或 HTTPS。'
    }
  } catch {
    return '接口地址格式不正确。'
  }
  if (!normalized.apiKey) return '请填写 API 密钥。'
  if (definition.requiresApiId && !normalized.apiId) {
    return '接口盒子配置需要填写开发者 ID。'
  }
  if (provider !== 'apihz' && !normalized.model) {
    return '请填写模型名称。'
  }
  return undefined
}

export function isLLMConfigUsable(config: LLMConfig): boolean {
  return !validateLLMConfig(config)
}

export function resolveLLMEndpoint(config: LLMConfig): {
  endpoint: string
  protocol: 'openai' | 'anthropic' | 'apihz'
  provider: LLMProvider
} {
  const normalized = normalizeLLMConfig(config)
  const provider = normalized.provider || 'openai'
  const url = new URL(normalized.baseUrl)
  const path = url.pathname.replace(/\/+$/, '')

  if (provider === 'apihz') {
    return {
      endpoint: url.toString().replace(/\/+$/, ''),
      protocol: 'apihz',
      provider
    }
  }

  if (provider === 'anthropic') {
    if (!/\/v\d+\/messages$/i.test(path)) {
      url.pathname = /\/v\d+$/i.test(path)
        ? `${path}/messages`
        : `${path}/v1/messages`
    }
    return { endpoint: url.toString(), protocol: 'anthropic', provider }
  }

  if (!/\/chat\/completions$/i.test(path)) {
    if (provider === 'qianfan') {
      url.pathname = /\/v\d+$/i.test(path)
        ? `${path}/chat/completions`
        : `${path}/v2/chat/completions`
    } else if (provider === 'longcat') {
      url.pathname = /\/openai$/i.test(path)
        ? `${path}/v1/chat/completions`
        : `${path}/openai/v1/chat/completions`
    } else if (provider === 'modelscope') {
      url.pathname = /\/v\d+$/i.test(path)
        ? `${path}/chat/completions`
        : `${path}/v1/chat/completions`
    } else {
      url.pathname = /\/v\d+$/i.test(path)
        ? `${path}/chat/completions`
        : `${path}/v1/chat/completions`
    }
  }
  return { endpoint: url.toString(), protocol: 'openai', provider }
}

export function createLLMProfile(
  id: string,
  provider: LLMProvider = 'openai',
  name?: string
): LLMProfile {
  const definition = getLLMProviderDefinition(provider)
  return {
    id,
    name: name || definition.label,
    provider,
    baseUrl: definition.defaultBaseUrl,
    apiKey: '',
    apiId: '',
    model: definition.defaultModel
  }
}
