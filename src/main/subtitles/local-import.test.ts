import AdmZip from 'adm-zip'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { stageLocalSubtitle } from './local-import'
import { SubtitleStorage } from './storage'

vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => process.cwd() } }))

const temporary: string[] = []
const media = { type: 'tv' as const, title: 'Example Series', normalizedTitle: 'example series', aliases: [], confirmed: true }
const subtitle = '1\n00:00:01,000 --> 00:00:03,000\nWe need to find the missing key.\n'

function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'subtitle-local-import-'))
  temporary.push(directory)
  return { directory, storage: new SubtitleStorage(join(directory, 'library')) }
}

afterEach(() => {
  for (const directory of temporary.splice(0)) rmSync(directory, { recursive: true, force: true })
})

describe('community local subtitle import', () => {
  it('stages a subtitle copy and preserves the original file', async () => {
    const { directory, storage } = setup()
    const original = join(directory, 'Example.S01E01.srt')
    writeFileSync(original, subtitle)
    const result = await stageLocalSubtitle(storage, media, 'local-one', original, new AbortController().signal)
    expect(result.rawPath).not.toBe(original)
    expect(storage.relativePath(result.rawPath)).toContain('.work/local-one/raw')
    expect(result.subtitleFiles).toEqual([result.rawPath])
    expect(result.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(readFileSync(original, 'utf8')).toBe(subtitle)
  })

  it('extracts a complete season locally without losing episode names', async () => {
    const { directory, storage } = setup()
    const original = join(directory, 'Example.S01.zip')
    const zip = new AdmZip()
    zip.addFile('Example.S01E01.srt', Buffer.from(subtitle))
    zip.addFile('Example.S01E02.srt', Buffer.from(subtitle))
    zip.writeZip(original)
    const result = await stageLocalSubtitle(storage, media, 'local-season', original, new AbortController().signal)
    expect(result.subtitleFiles).toHaveLength(2)
    expect(result.subtitleFiles.some((path) => path.endsWith('S01E02.srt'))).toBe(true)
  })

  it('rejects an HTML file disguised as a subtitle', async () => {
    const { directory, storage } = setup()
    const original = join(directory, 'invalid.srt')
    writeFileSync(original, '<html><body>Not a subtitle</body></html>')
    await expect(stageLocalSubtitle(storage, media, 'local-invalid', original, new AbortController().signal))
      .rejects.toThrow('download-rejected')
  })
})
