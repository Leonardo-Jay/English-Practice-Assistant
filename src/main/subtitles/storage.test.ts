import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: () => process.cwd()
  }
}))

import { SubtitleStorage } from './storage'

const temporary: string[] = []
afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('installation-relative subtitle storage', () => {
  it('supports spaces, Chinese names, and relative relocation-safe paths', () => {
    const root = mkdtempSync(join(tmpdir(), 'D-drive 模拟 安装目录-'))
    temporary.push(root)
    const storage = new SubtitleStorage(join(root, 'data', 'subtitles'))
    expect(storage.probe().writable).toBe(true)
    const mediaDirectory = storage.mediaDirectory({
      type: 'tv',
      title: '吸血鬼日记',
      normalizedTitle: '吸血鬼日记',
      aliases: ['The Vampire Diaries'],
      confirmed: true
    }, 1, 3)
    const relative = storage.relativePath(join(mediaDirectory, 'dialogue', '对白.txt'))
    expect(relative).toContain('S01E03/dialogue')
    expect(storage.absolutePath(relative)).toBe(
      join(mediaDirectory, 'dialogue', '对白.txt')
    )
  })

  it('reports a non-writable root and never chooses a fallback', () => {
    const root = mkdtempSync(join(tmpdir(), 'subtitle-file-root-'))
    temporary.push(root)
    const file = join(root, 'not-a-directory')
    writeFileSync(file, 'occupied')
    const storage = new SubtitleStorage(file)
    const status = storage.probe()
    expect(status.writable).toBe(false)
    expect(status.root).toBe(file)
  })

  it('stores a season package once at season scope while keeping episode outputs separate', () => {
    const root = mkdtempSync(join(tmpdir(), 'subtitle-season-package-'))
    temporary.push(root)
    const storage = new SubtitleStorage(root)
    const media = {
      type: 'tv' as const,
      title: 'White Collar',
      normalizedTitle: 'White Collar',
      aliases: [],
      confirmed: true
    }
    const work = storage.packageWorkDirectory(media, 'job-1')
    const raw = join(work, 'raw', 'white-collar-s01.rar')
    const episode1 = join(work, 'extracted', 'White.Collar.S01E01.srt')
    const episode8 = join(work, 'extracted', 'White.Collar.S01E08.srt')
    writeFileSync(raw, 'archive')
    writeFileSync(episode1, 'episode one')
    writeFileSync(episode8, 'episode eight')

    const persisted = storage.persistPackageFiles({
      media,
      season: 1,
      packType: 'season',
      rawPath: raw,
      subtitleFiles: [episode1, episode8],
      sha256: 'abcdef0123456789'
    })

    expect(storage.relativePath(persisted.rawPath)).toContain(
      'white-collar/S01/raw/'
    )
    expect(storage.relativePath(persisted.rawPath)).not.toContain('S01E01')
    expect(storage.relativePath(persisted.subtitleFiles[1])).toContain(
      'white-collar/S01/files/abcdef0123456789/'
    )
    expect(readFileSync(persisted.subtitleFiles[1], 'utf8')).toBe('episode eight')
    expect(storage.mediaDirectory(media, 1, 8)).toContain('S01E08')
  })

  it('rejects path traversal outside the subtitle root', () => {
    const root = mkdtempSync(join(tmpdir(), 'subtitle-safe-root-'))
    temporary.push(root)
    const storage = new SubtitleStorage(root)
    expect(() => storage.absolutePath('../escape.srt')).toThrow(
      '拒绝访问字幕目录之外的路径'
    )
  })
})
