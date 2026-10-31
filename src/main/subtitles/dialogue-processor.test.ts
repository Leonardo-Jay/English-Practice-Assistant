import { describe, expect, it } from 'vitest'
import {
  buildDialogueScenes,
  decodeSubtitle,
  parseSubtitle,
  toDialogueDocument
} from './dialogue-processor'

describe('dialogue-first subtitle processing', () => {
  it('removes timing, style, duplicate lines, and non-dialogue cues', () => {
    const source = `1
00:00:01,000 --> 00:00:03,000
<i>Hello, Elena.</i>

2
00:00:03,100 --> 00:00:05,000
[door closes]

3
00:00:05,200 --> 00:00:07,000
I came back for you.
I came back for you.
`
    const scenes = buildDialogueScenes(parseSubtitle(source, '.srt'))
    expect(scenes).toHaveLength(1)
    expect(scenes[0].dialogue).toBe('Hello, Elena.\nI came back for you.')
    expect(toDialogueDocument(scenes)).not.toContain('00:00:')
    expect(toDialogueDocument(scenes)).not.toContain('door closes')
  })

  it('strips ASS directives and keeps no invented speaker', () => {
    const source = `[Script Info]
[Events]
Dialogue: 0,0:00:01.00,0:00:03.00,Default,,0,0,0,,{\\pos(20,20)}I know.\\NBut I want to.
`
    const scenes = buildDialogueScenes(parseSubtitle(source, '.ass'))
    expect(scenes[0].dialogue).toBe('I know.\nBut I want to.')
  })

  it('decodes UTF-16 subtitles', () => {
    const buffer = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('Hello', 'utf16le')
    ])
    expect(decodeSubtitle(buffer)).toContain('Hello')
  })
})
