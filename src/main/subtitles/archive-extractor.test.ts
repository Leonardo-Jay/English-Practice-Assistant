import AdmZip from 'adm-zip'
import { spawnSync } from 'child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { path7za } from '7zip-bin'
import { afterEach, describe, expect, it } from 'vitest'
import {
  extractSubtitleArchive,
  extractSubtitleZip
} from './archive-extractor'

const temporary: string[] = []
afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('safe local ZIP extraction', () => {
  it('extracts only supported subtitle files locally', () => {
    const root = mkdtempSync(join(tmpdir(), 'subtitle-zip-'))
    temporary.push(root)
    const archive = join(root, 'episode.zip')
    const zip = new AdmZip()
    zip.addFile('Season 1/S01E03.srt', Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nHello.'))
    zip.addFile('readme.exe', Buffer.from('not executable content'))
    zip.writeZip(archive)
    const files = extractSubtitleZip(archive, join(root, 'out'))
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/S01E03\.srt$/)
    expect(existsSync(join(root, 'out', 'readme.exe'))).toBe(false)
  })

  it('reports archives without supported subtitles', () => {
    const root = mkdtempSync(join(tmpdir(), 'subtitle-empty-zip-'))
    temporary.push(root)
    const archive = join(root, 'empty.zip')
    const zip = new AdmZip()
    zip.addFile('readme.txt', Buffer.from('nothing'))
    zip.writeZip(archive)
    expect(() => extractSubtitleZip(archive, join(root, 'out'))).toThrow(
      'unsupported-archive'
    )
  })

  it('reports a truncated ZIP with a typed corruption error', () => {
    const root = mkdtempSync(join(tmpdir(), 'subtitle-corrupt-zip-'))
    temporary.push(root)
    const archive = join(root, 'broken.zip')
    writeFileSync(archive, Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    expect(() => extractSubtitleZip(archive, join(root, 'out'))).toThrow(
      'corrupt-archive'
    )
  })

  it('extracts a local 7z subtitle through the packaged decoder', async () => {
    const root = mkdtempSync(join(tmpdir(), 'subtitle-7z-'))
    temporary.push(root)
    const subtitle = join(root, 'S01E03.srt')
    const archive = join(root, 'episode.7z')
    writeFileSync(
      subtitle,
      '1\n00:00:01,000 --> 00:00:02,000\nHello from 7z.'
    )
    const packed = spawnSync(
      path7za,
      ['a', '-t7z', '-y', archive, subtitle],
      { windowsHide: true, encoding: 'utf8' }
    )
    expect(packed.status, packed.stderr).toBe(0)

    const files = await extractSubtitleArchive(
      archive,
      join(root, 'out'),
      '7z'
    )
    expect(files).toHaveLength(1)
    expect(files[0]).toMatch(/S01E03\.srt$/)
  })
})
