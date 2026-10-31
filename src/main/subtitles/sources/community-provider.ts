import type { SubtitleSourceProvider } from './types'

export const subtitleSourceProvider: SubtitleSourceProvider = {
  available: false,
  createAdapters: () => [],
  createSession: () => {
    throw new Error('当前版本未包含在线字幕来源，请导入本地字幕或使用已有知识库。')
  }
}
