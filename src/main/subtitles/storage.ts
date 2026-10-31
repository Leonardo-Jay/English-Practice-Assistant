import { app } from 'electron'
import {
  copyFileSync,
  mkdirSync,
  openSync,
  closeSync,
  rmSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  statSync,
  readdirSync
} from 'fs'
import { basename, dirname, join, relative, resolve, sep } from 'path'
import type {
  MediaIdentity,
  SubtitleCandidate,
  SubtitleStorageStatus
} from '../../shared/types'

export class SubtitleStorageError extends Error {
  readonly code = 'storage-not-writable'
}

export class SubtitleStorage {
  readonly root: string

  constructor(root = resolveSubtitleRoot()) {
    this.root = resolve(root)
  }

  probe(): SubtitleStorageStatus {
    try {
      mkdirSync(this.root, { recursive: true })
      const base = join(this.root, `.write-test-${process.pid}-${Date.now()}`)
      const renamed = `${base}.renamed`
      const fd = openSync(base, 'wx')
      writeFileSync(fd, 'ok', 'utf8')
      closeSync(fd)
      renameSync(base, renamed)
      unlinkSync(renamed)
      return { root: this.root, writable: true, cacheBytes: this.cacheBytes() }
    } catch (error) {
      return {
        root: this.root,
        writable: false,
        cacheBytes: 0,
        error: `字幕目录不可写：${error instanceof Error ? error.message : String(error)}`
      }
    }
  }

  assertWritable(): void {
    const status = this.probe()
    if (!status.writable) throw new SubtitleStorageError(status.error)
  }

  mediaDirectory(
    media: MediaIdentity,
    season?: number,
    episode?: number
  ): string {
    const key = stableMediaKey(media)
    const scope =
      media.type === 'movie'
        ? 'movie'
        : `S${pad(season)}E${pad(episode)}`
    const target = resolve(this.root, key, scope)
    this.assertInside(target)
    for (const child of ['raw', 'dialogue', 'knowledge', '.work']) {
      mkdirSync(join(target, child), { recursive: true })
    }
    return target
  }

  packageWorkDirectory(media: MediaIdentity, jobId: string): string {
    const target = resolve(
      this.root,
      stableMediaKey(media),
      '.work',
      this.safeFilename(jobId, 'job')
    )
    this.assertInside(target)
    mkdirSync(join(target, 'raw'), { recursive: true })
    mkdirSync(join(target, 'extracted'), { recursive: true })
    return target
  }

  packageDirectory(
    media: MediaIdentity,
    season: number | undefined,
    episode: number | undefined,
    packType: SubtitleCandidate['packType']
  ): string {
    const scope =
      media.type === 'movie' || packType === 'movie'
        ? 'movie'
        : packType === 'series'
          ? 'series'
          : packType === 'season'
            ? `S${pad(season)}`
            : `S${pad(season)}E${pad(episode)}`
    const target = resolve(this.root, stableMediaKey(media), scope)
    this.assertInside(target)
    for (const child of ['raw', 'files']) {
      mkdirSync(join(target, child), { recursive: true })
    }
    return target
  }

  persistPackageFiles(input: {
    media: MediaIdentity
    season?: number
    episode?: number
    packType: SubtitleCandidate['packType']
    rawPath: string
    subtitleFiles: string[]
    sha256: string
  }): { rawPath: string; subtitleFiles: string[] } {
    const sourceRaw = resolve(input.rawPath)
    this.assertInside(sourceRaw)
    input.subtitleFiles.forEach((file) => this.assertInside(resolve(file)))
    const directory = this.packageDirectory(
      input.media,
      input.season,
      input.episode,
      input.packType
    )
    const rawPath = join(
      directory,
      'raw',
      this.safeFilename(basename(sourceRaw), 'subtitle-package')
    )
    copyUnlessSame(sourceRaw, rawPath)
    const fileDirectory = join(
      directory,
      'files',
      (input.sha256 || 'unhashed').slice(0, 16)
    )
    mkdirSync(fileDirectory, { recursive: true })
    const subtitleFiles = input.subtitleFiles.map((source, index) => {
      const target = join(
        fileDirectory,
        `${String(index + 1).padStart(3, '0')}-${this.safeFilename(
          basename(source),
          `subtitle-${index + 1}`
        )}`
      )
      copyUnlessSame(source, target)
      return target
    })
    return { rawPath, subtitleFiles }
  }

  cleanupPackageWork(media: MediaIdentity, jobId: string): void {
    const target = resolve(
      this.root,
      stableMediaKey(media),
      '.work',
      this.safeFilename(jobId, 'job')
    )
    this.assertInside(target)
    try {
      rmSync(target, { recursive: true, force: true })
    } catch {
      // A temporary file can remain locked briefly by antivirus software.
      // Cleanup must never turn a completed subtitle task into a failure.
    }
  }

  relativePath(absolutePath: string): string {
    const target = resolve(absolutePath)
    this.assertInside(target)
    return relative(this.root, target).split(sep).join('/')
  }

  absolutePath(relativePath: string): string {
    const target = resolve(this.root, relativePath)
    this.assertInside(target)
    return target
  }

  promote(partialPath: string, finalPath: string): void {
    const source = resolve(partialPath)
    const target = resolve(finalPath)
    this.assertInside(source)
    this.assertInside(target)
    mkdirSync(dirname(target), { recursive: true })
    renameSync(source, target)
  }

  safeFilename(value: string, fallback = 'subtitle'): string {
    const safe = value
      .normalize('NFKC')
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_')
      .replace(/[. ]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120)
    return safe || fallback
  }

  private assertInside(target: string): void {
    const prefix = this.root.endsWith(sep) ? this.root : `${this.root}${sep}`
    if (target !== this.root && !target.startsWith(prefix)) {
      throw new Error('拒绝访问字幕目录之外的路径。')
    }
  }

  private cacheBytes(directory = this.root): number {
    try {
      return readdirSync(directory, { withFileTypes: true }).reduce((total, item) => {
        const path = join(directory, item.name)
        return total + (item.isDirectory() ? this.cacheBytes(path) : statSync(path).size)
      }, 0)
    } catch {
      return 0
    }
  }
}

export function resolveSubtitleRoot(): string {
  if (app.isPackaged) {
    return join(dirname(process.execPath), 'data', 'subtitles')
  }
  return join(app.getAppPath(), 'data', 'subtitles')
}

export function stableMediaKey(media: MediaIdentity): string {
  const title = media.normalizedTitle
    .normalize('NFKC')
    .toLocaleLowerCase('en-US')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72)
  return `${title || 'media'}${media.year ? `-${media.year}` : ''}`
}

const pad = (value?: number) => String(Math.max(0, value || 0)).padStart(2, '0')

const copyUnlessSame = (source: string, target: string) => {
  if (resolve(source) === resolve(target)) return
  mkdirSync(dirname(target), { recursive: true })
  copyFileSync(source, target)
}
