import { randomUUID } from 'crypto'
import iconv from 'iconv-lite'
import type { SubtitleDialogueScene } from '../../shared/types'
import { DEFAULT_SUBTITLE_LIMITS } from './constants'

interface Cue {
  startMs: number
  endMs: number
  lines: string[]
}

export function decodeSubtitle(buffer: Buffer): string {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xfe) {
    return iconv.decode(buffer, 'utf16-le')
  }
  if (buffer.length >= 2 && buffer[0] === 0xfe && buffer[1] === 0xff) {
    return iconv.decode(buffer, 'utf16-be')
  }
  const utf8 = iconv.decode(buffer, 'utf8')
  if (!utf8.includes('\ufffd')) return utf8.replace(/^\ufeff/, '')
  for (const encoding of ['gb18030', 'big5']) {
    const decoded = iconv.decode(buffer, encoding)
    if (!decoded.includes('\ufffd')) return decoded
  }
  throw new Error('encoding-unknown')
}

export function parseSubtitle(text: string, extension: string): Cue[] {
  const normalized = text.replace(/\r\n?/g, '\n')
  if (/\.ass|\.ssa/i.test(extension) || /^\[Script Info\]/m.test(normalized)) {
    return parseAss(normalized)
  }
  return parseSrtOrVtt(normalized)
}

export function buildDialogueScenes(cues: Cue[]): SubtitleDialogueScene[] {
  const cleaned = cues
    .map((cue) => ({ ...cue, lines: cleanLines(cue.lines) }))
    .filter((cue) => cue.lines.length > 0)
  const scenes: SubtitleDialogueScene[] = []
  let group: Cue[] = []
  const flush = () => {
    if (!group.length) return
    const lines = group.flatMap((cue) => cue.lines)
    scenes.push({
      id: randomUUID(),
      ordinal: scenes.length,
      startMs: group[0].startMs,
      endMs: group[group.length - 1].endMs,
      dialogue: lines.join('\n')
    })
    const overlap = lines.slice(-DEFAULT_SUBTITLE_LIMITS.sceneOverlapLines)
    group = overlap.length
      ? [{
          startMs: group[group.length - 1].startMs,
          endMs: group[group.length - 1].endMs,
          lines: overlap
        }]
      : []
  }
  for (const cue of cleaned) {
    const previous = group[group.length - 1]
    const characters = group.reduce(
      (total, item) => total + item.lines.join('\n').length,
      0
    )
    const tooLong =
      Boolean(previous) &&
      (cue.startMs - group[0].startMs >
        DEFAULT_SUBTITLE_LIMITS.sceneMaxDurationMs ||
        characters + cue.lines.join('\n').length >
          DEFAULT_SUBTITLE_LIMITS.sceneMaxCharacters)
    const strongGap =
      Boolean(previous) &&
      cue.startMs - previous.endMs > DEFAULT_SUBTITLE_LIMITS.sceneStrongGapMs
    if (tooLong || strongGap) flush()
    group.push(cue)
  }
  flush()
  return scenes.filter((scene) => scene.dialogue.trim())
}

export function toDialogueDocument(scenes: SubtitleDialogueScene[]): string {
  return scenes
    .map((scene) => `<scene id="${scene.ordinal + 1}">\n${scene.dialogue}\n</scene>`)
    .join('\n\n')
}

function parseSrtOrVtt(text: string): Cue[] {
  const pattern =
    /(?:^|\n)(?:\d+\n)?(\d{1,2}:\d{2}:\d{2}[,.]\d{3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{3})[^\n]*\n([\s\S]*?)(?=\n{2,}(?:\d+\n)?\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s*-->|$)/g
  const cues: Cue[] = []
  for (const match of text.matchAll(pattern)) {
    cues.push({
      startMs: timestamp(match[1]),
      endMs: timestamp(match[2]),
      lines: match[3].split('\n')
    })
  }
  return cues
}

function parseAss(text: string): Cue[] {
  const cues: Cue[] = []
  for (const line of text.split('\n')) {
    if (!line.startsWith('Dialogue:')) continue
    const parts = line.slice(9).split(',')
    if (parts.length < 10) continue
    const start = parts[1]
    const end = parts[2]
    const dialogue = parts.slice(9).join(',').replace(/\\N/g, '\n')
    cues.push({
      startMs: assTimestamp(start),
      endMs: assTimestamp(end),
      lines: dialogue.split('\n')
    })
  }
  return cues
}

function cleanLines(lines: string[]): string[] {
  const result: string[] = []
  for (const raw of lines) {
    const line = raw
      .replace(/\{[^}]*\}/g, '')
      .replace(/<[^>]+>/g, '')
      .replace(/^[♪♫]+|[♪♫]+$/g, '')
      .normalize('NFKC')
      .replace(/\s+/g, ' ')
      .trim()
    if (!line || isNonDialogue(line)) continue
    if (result[result.length - 1]?.toLocaleLowerCase() === line.toLocaleLowerCase()) {
      continue
    }
    const previous = result[result.length - 1]
    if (previous && likelyBilingualDuplicate(previous, line)) {
      if (hasEnglish(line) && !hasEnglish(previous)) result[result.length - 1] = line
      continue
    }
    result.push(line)
  }
  return result
}

function isNonDialogue(line: string): boolean {
  return (
    /^[[(（【].{1,80}[\])）】]$/.test(line) ||
    /^(music|applause|laughs?|door closes?|phone rings?|sighs?)$/i.test(line)
  )
}

function likelyBilingualDuplicate(left: string, right: string): boolean {
  if (hasEnglish(left) === hasEnglish(right)) return false
  const short = Math.min(left.length, right.length)
  const long = Math.max(left.length, right.length)
  return short > 1 && long / short < 3.5
}

const hasEnglish = (value: string) => /[A-Za-z]{2}/.test(value)

function timestamp(value: string): number {
  const [hours, minutes, rest] = value.replace(',', '.').split(':')
  return (
    Number(hours) * 3_600_000 +
    Number(minutes) * 60_000 +
    Number.parseFloat(rest) * 1_000
  )
}

function assTimestamp(value: string): number {
  const [hours, minutes, rest] = value.split(':')
  return (
    Number(hours) * 3_600_000 +
    Number(minutes) * 60_000 +
    Number.parseFloat(rest) * 1_000
  )
}
