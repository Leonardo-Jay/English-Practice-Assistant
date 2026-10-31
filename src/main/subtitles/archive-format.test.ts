import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  detectSubtitlePayload,
  inspectSubtitlePayload
} from './archive-format'

const temporary: string[] = []
afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('subtitle payload detection', () => {
  it.each([
    ['ZIP', [0x50, 0x4b, 0x03, 0x04], 'zip'],
    ['RAR4', [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00], 'rar'],
    ['RAR5', [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00], 'rar'],
    ['7z', [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], '7z']
  ])('recognizes %s by magic bytes', (_label, bytes, kind) => {
    expect(detectSubtitlePayload(Uint8Array.from(bytes))).toMatchObject({ kind })
  })

  it('recognizes a UTF-16 SRT file', () => {
    const text = Buffer.from(
      '\ufeff1\r\n00:00:01,000 --> 00:00:02,000\r\nHello.',
      'utf16le'
    )
    expect(detectSubtitlePayload(text)).toEqual({
      kind: 'subtitle',
      extension: '.srt'
    })
  })

  it('trusts RAR magic bytes over a misleading ZIP filename and content type', () => {
    const root = mkdtempSync(join(tmpdir(), 'subtitle-payload-'))
    temporary.push(root)
    const path = join(root, 'subtitle.zip')
    writeFileSync(
      path,
      Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00])
    )
    expect(
      inspectSubtitlePayload(path, 'application/zip', 'https://example.com/a.zip')
    ).toEqual({ kind: 'rar', extension: '.rar' })
  })

  it('reports an invalid archive response as corrupt instead of unknown', () => {
    const root = mkdtempSync(join(tmpdir(), 'subtitle-payload-'))
    temporary.push(root)
    const path = join(root, 'broken.rar')
    writeFileSync(path, 'not an archive')
    expect(() =>
      inspectSubtitlePayload(
        path,
        'application/x-rar-compressed',
        'https://example.com/a.rar'
      )
    ).toThrow('corrupt-archive')
  })
})
