import AdmZip from 'adm-zip'
import { spawn } from 'child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync
} from 'fs'
import { extname, isAbsolute, join, resolve, sep } from 'path'
import { path7za } from '7zip-bin'
import { createExtractorFromData } from 'node-unrar-js'
import type { SubtitlePayloadKind } from './archive-format'
import { DEFAULT_SUBTITLE_LIMITS, SUPPORTED_SUBTITLE_EXTENSIONS } from './constants'

type SafeArchiveEntry = {
  name: string
  size: number
}

let rarExtractionQueue: Promise<void> = Promise.resolve()

export async function extractSubtitleArchive(
  archivePath: string,
  targetRoot: string,
  kind: Exclude<SubtitlePayloadKind, 'subtitle'>
): Promise<string[]> {
  if (kind === 'zip') return extractSubtitleZip(archivePath, targetRoot)
  if (kind === 'rar') return extractSubtitleRar(archivePath, targetRoot)
  return extractSubtitle7z(archivePath, targetRoot)
}

export function extractSubtitleZip(
  archivePath: string,
  targetRoot: string
): string[] {
  let entries: AdmZip.IZipEntry[]
  try {
    entries = new AdmZip(archivePath).getEntries()
  } catch (error) {
    throw archiveReadError('ZIP', error)
  }
  assertEntryCount(entries.length)
  const root = prepareRoot(targetRoot)
  const extracted: string[] = []
  let total = 0
  for (const entry of entries) {
    if (entry.isDirectory) continue
    const unixType = (entry.attr >>> 16) & 0o170000
    if (unixType === 0o120000) {
      throw new Error('unsafe-archive: 不允许符号链接')
    }
    const safe = validateArchiveEntry(entry.entryName, entry.header.size)
    if (!safe) continue
    total = addExpandedSize(total, safe.size)
    let data: Buffer
    try {
      data = entry.getData()
    } catch (error) {
      throw archiveReadError('ZIP', error)
    }
    if (data.length !== safe.size && safe.size > 0) {
      throw new Error('corrupt-archive: ZIP 字幕文件解压后大小不一致')
    }
    extracted.push(writeSafeEntry(root, safe.name, data))
  }
  assertHasSubtitles(extracted)
  return extracted
}

export function extractSubtitleRar(
  archivePath: string,
  targetRoot: string
): Promise<string[]> {
  const work = rarExtractionQueue.then(() =>
    extractSubtitleRarInternal(archivePath, targetRoot)
  )
  rarExtractionQueue = work.then(() => undefined, () => undefined)
  return work
}

async function extractSubtitleRarInternal(
  archivePath: string,
  targetRoot: string
): Promise<string[]> {
  try {
    const archive = Uint8Array.from(readFileSync(archivePath)).buffer
    const extractor = await createExtractorFromData({ data: archive })
    const listing = extractor.getFileList()
    if (listing.arcHeader.flags.headerEncrypted) {
      throw new Error('encrypted-archive: RAR 压缩包的文件头已加密')
    }
    if (listing.arcHeader.flags.volume) {
      throw new Error('unsupported-archive: 暂不支持分卷 RAR 压缩包')
    }
    const headers = [...listing.fileHeaders]
    assertEntryCount(headers.length)
    const selected: SafeArchiveEntry[] = []
    let total = 0
    for (const header of headers) {
      if (header.flags.directory) continue
      if (header.flags.encrypted) {
        throw new Error('encrypted-archive: RAR 压缩包中的字幕需要密码')
      }
      const safe = validateArchiveEntry(header.name, header.unpSize)
      if (!safe) continue
      total = addExpandedSize(total, safe.size)
      selected.push(safe)
    }
    assertHasSubtitles(selected)

    const root = prepareRoot(targetRoot)
    const output = extractor.extract({
      files: selected.map((entry) => entry.name)
    })
    const allowed = new Map(selected.map((entry) => [entry.name, entry]))
    const extracted: string[] = []
    for (const file of output.files) {
      const safe = allowed.get(file.fileHeader.name)
      if (!safe || file.fileHeader.flags.directory) continue
      if (!file.extraction) {
        throw new Error(`corrupt-archive: RAR 字幕文件解压失败：${safe.name}`)
      }
      const data = Buffer.from(file.extraction)
      if (data.length !== safe.size && safe.size > 0) {
        throw new Error('corrupt-archive: RAR 字幕文件解压后大小不一致')
      }
      extracted.push(writeSafeEntry(root, safe.name, data))
    }
    assertHasSubtitles(extracted)
    return extracted
  } catch (error) {
    if (isTypedArchiveError(error)) throw error
    throw archiveReadError('RAR', error)
  }
}

async function extractSubtitle7z(
  archivePath: string,
  targetRoot: string
): Promise<string[]> {
  const executable = resolve7zipExecutable()
  const listing = await run7zip(executable, [
    'l',
    '-slt',
    '-ba',
    '-bd',
    '-y',
    archivePath
  ])
  const records = parse7zipListing(listing.toString('utf8'))
  assertEntryCount(records.length)
  const selected: SafeArchiveEntry[] = []
  let total = 0
  for (const record of records) {
    if (record.folder || record.directory) continue
    if (record.encrypted) {
      throw new Error('encrypted-archive: 7z 压缩包中的字幕需要密码')
    }
    const safe = validateArchiveEntry(record.path, record.size)
    if (!safe) continue
    total = addExpandedSize(total, safe.size)
    selected.push(safe)
  }
  assertHasSubtitles(selected)

  const root = prepareRoot(targetRoot)
  const extracted: string[] = []
  for (const entry of selected) {
    const data = await run7zip(
      executable,
      ['e', '-so', '-bd', '-y', '-spd', archivePath, entry.name],
      DEFAULT_SUBTITLE_LIMITS.maxExtractedFileBytes
    )
    if (data.length !== entry.size && entry.size > 0) {
      throw new Error('corrupt-archive: 7z 字幕文件解压后大小不一致')
    }
    extracted.push(writeSafeEntry(root, entry.name, data))
  }
  return extracted
}

function validateArchiveEntry(
  originalName: string,
  size: number
): SafeArchiveEntry | undefined {
  const name = originalName.replace(/\\/g, '/')
  const parts = name.split('/')
  if (
    !name ||
    isAbsolute(name) ||
    /^[A-Za-z]:/.test(name) ||
    parts.includes('..') ||
    parts.some((part) => !part || /[\0\r\n]/.test(part)) ||
    parts.length > DEFAULT_SUBTITLE_LIMITS.maxArchiveDepth + 1
  ) {
    throw new Error('unsafe-archive: 检测到越界、异常或过深路径')
  }
  if (
    !Number.isSafeInteger(size) ||
    size < 0 ||
    size > DEFAULT_SUBTITLE_LIMITS.maxExtractedFileBytes
  ) {
    throw new Error('unsafe-archive: 单个文件超过限制或大小无效')
  }
  if (!SUPPORTED_SUBTITLE_EXTENSIONS.has(extname(name).toLocaleLowerCase())) {
    return undefined
  }
  return { name, size }
}

function prepareRoot(targetRoot: string): string {
  const root = resolve(targetRoot)
  mkdirSync(root, { recursive: true })
  return root
}

function writeSafeEntry(
  root: string,
  name: string,
  data: Uint8Array
): string {
  const destination = resolve(root, name)
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  if (!destination.startsWith(prefix)) {
    throw new Error('unsafe-archive: 解压路径越界')
  }
  mkdirSync(resolve(destination, '..'), { recursive: true })
  writeFileSync(destination, data, { flag: 'wx' })
  return destination
}

function assertEntryCount(count: number): void {
  if (count > DEFAULT_SUBTITLE_LIMITS.maxArchiveEntries) {
    throw new Error('unsafe-archive: 文件数量超过限制')
  }
}

function addExpandedSize(total: number, size: number): number {
  const next = total + size
  if (next > DEFAULT_SUBTITLE_LIMITS.maxExtractedBytes) {
    throw new Error('unsafe-archive: 解压总大小超过限制')
  }
  return next
}

function assertHasSubtitles<T>(items: T[]): void {
  if (!items.length) {
    throw new Error('unsupported-archive: 压缩包中没有支持的字幕文件')
  }
}

function archiveReadError(kind: string, error: unknown): Error {
  const message = error instanceof Error ? error.message : String(error)
  if (/password|encrypted|ERAR_MISSING_PASSWORD|ERAR_BAD_PASSWORD/i.test(message)) {
    return new Error(`encrypted-archive: ${kind} 压缩包需要密码`)
  }
  return new Error(`corrupt-archive: ${kind} 压缩包损坏或下载不完整（${message}）`)
}

function isTypedArchiveError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /^(?:unsafe|unsupported|encrypted|corrupt)-archive:/.test(message)
}

function resolve7zipExecutable(): string {
  const packaged = process.resourcesPath
    ? join(
        process.resourcesPath,
        'subtitle-tools',
        process.platform === 'win32' ? '7za.exe' : '7za'
      )
    : ''
  const executable = packaged && existsSync(packaged) ? packaged : path7za
  if (!executable || (executable !== '7za' && !existsSync(executable))) {
    throw new Error('archive-tool-missing: 未找到随应用安装的 7z 解压组件')
  }
  return executable
}

function run7zip(
  executable: string,
  args: string[],
  maxStdoutBytes = 4 * 1024 * 1024
): Promise<Buffer> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []
    let stdoutSize = 0
    let stderrSize = 0
    let settled = false
    child.stdout.on('data', (chunk: Buffer) => {
      stdoutSize += chunk.length
      if (stdoutSize > maxStdoutBytes) {
        child.kill()
        if (!settled) {
          settled = true
          reject(new Error('unsafe-archive: 解压输出超过单文件限制'))
        }
        return
      }
      stdout.push(chunk)
    })
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderrSize < 64 * 1024) {
        stderr.push(chunk)
        stderrSize += chunk.length
      }
    })
    child.once('error', () => {
      if (!settled) {
        settled = true
        reject(new Error('archive-tool-missing: 无法启动随应用安装的 7z 解压组件'))
      }
    })
    child.once('close', (code) => {
      if (settled) return
      settled = true
      if (code !== 0) {
        const diagnostic = Buffer.concat(stderr).toString('utf8').trim()
        reject(archiveReadError('7z', diagnostic || `退出码 ${code}`))
        return
      }
      resolvePromise(Buffer.concat(stdout))
    })
  })
}

function parse7zipListing(text: string): Array<{
  path: string
  size: number
  folder: boolean
  directory: boolean
  encrypted: boolean
}> {
  const records: Array<Record<string, string>> = []
  let current: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      if (current.Path) records.push(current)
      current = {}
      continue
    }
    const separator = line.indexOf(' = ')
    if (separator <= 0) continue
    const key = line.slice(0, separator)
    if (key === 'Path' && current.Path) {
      records.push(current)
      current = {}
    }
    current[key] = line.slice(separator + 3)
  }
  if (current.Path) records.push(current)
  return records.map((record) => ({
    path: record.Path,
    size: Number(record.Size || 0),
    folder: record.Folder === '+',
    directory: /^D/i.test(record.Attributes || ''),
    encrypted: record.Encrypted === '+'
  }))
}
