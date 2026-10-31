const ZERO_WIDTH_CHARACTERS = /[\u200B-\u200D\u2060\uFEFF]/g
const UNUSUAL_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g
const EMOJI_CHARACTERS = /[\p{Extended_Pictographic}\uFE0E\uFE0F]/gu

export function normalizeAssistantReplyText(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/\r\n?/g, '\n')
    .replace(
      /<(?:think|thinking|reasoning|analysis)\b[^>]*>[\s\S]*?<\/(?:think|thinking|reasoning|analysis)\s*>/gi,
      ''
    )
    .replace(/<(?:think|thinking|reasoning|analysis)\b[^>]*>[\s\S]*$/gi, '')
    .replace(/<\/(?:think|thinking|reasoning|analysis)\s*>/gi, '')
    .replace(ZERO_WIDTH_CHARACTERS, '')
    .replace(UNUSUAL_SPACES, ' ')
    .replace(/[\u2018\u2019\u02BC\uFF07]/g, "'")
    .replace(/[\u201C\u201D\uFF02]/g, '"')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u2026/g, '...')
    .replace(/!\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/^\s*>\s?/gm, '')
    .replace(/^\s*[-+•]\s+/gm, '')
    .replace(/[*_`~]/g, '')
    .replace(EMOJI_CHARACTERS, '')
    .replace(/\s*'\s*/g, "'")
    .replace(/[^\S\n]+/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}
