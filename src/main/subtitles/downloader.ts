import { createHash } from 'crypto'
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync
} from 'fs'
import { dirname, extname } from 'path'
import { Readable } from 'stream'
import { finished } from 'stream/promises'
import { net } from 'electron'
import type { SubtitleDownloadResolution } from '../../shared/types'
import {
  inspectSubtitlePayload,
  type SubtitlePayloadKind
} from './archive-format'
import { DEFAULT_SUBTITLE_LIMITS } from './constants'

export interface DownloadResult {
  path: string
  sha256: string
  byteSize: number
  contentType: string
  kind: SubtitlePayloadKind
}

export async function downloadSubtitle(
  resolution: SubtitleDownloadResolution,
  finalPath: string,
  onProgress: (received: number, total?: number) => void,
  signal?: AbortSignal
): Promise<DownloadResult> {
  mkdirSync(dirname(finalPath), { recursive: true })
  const partial = `${finalPath}.partial-${process.pid}-${Date.now()}`
  const response = await net.fetch(resolution.url, {
    signal,
    headers: {
      ...(resolution.headers || {}),
      ...(resolution.referer ? { Referer: resolution.referer } : {})
    }
  })
  if (!response.ok || !response.body) {
    throw new Error(`download-rejected: HTTP ${response.status}`)
  }
  const totalHeader = Number(response.headers.get('content-length'))
  const total = Number.isFinite(totalHeader) && totalHeader > 0 ? totalHeader : undefined
  if (total && total > DEFAULT_SUBTITLE_LIMITS.maxDownloadBytes) {
    throw new Error('download-rejected: 文件超过安全大小限制')
  }
  let received = 0
  const hash = createHash('sha256')
  const source = Readable.fromWeb(
    response.body as unknown as import('stream/web').ReadableStream<Uint8Array>
  )
  source.on('data', (chunk: Buffer) => {
    received += chunk.length
    if (received > DEFAULT_SUBTITLE_LIMITS.maxDownloadBytes) {
      source.destroy(new Error('download-rejected: 文件超过安全大小限制'))
      return
    }
    hash.update(chunk)
    onProgress(received, total)
  })
  try {
    await finished(source.pipe(createWriteStream(partial, { flags: 'wx' })))
    if (
      total !== undefined &&
      !response.headers.get('content-encoding') &&
      received !== total
    ) {
      throw new Error(
        `download-truncated: 下载不完整（应收到 ${total} 字节，实际收到 ${received} 字节）`
      )
    }
    const inspection = inspectSubtitlePayload(
      partial,
      response.headers.get('content-type') || '',
      response.url
    )
    const detectedPath = replaceExtension(finalPath, inspection.extension)
    if (existsSync(detectedPath)) unlinkSync(detectedPath)
    renameSync(partial, detectedPath)
    return {
      path: detectedPath,
      sha256: hash.digest('hex'),
      byteSize: statSync(detectedPath).size,
      contentType: response.headers.get('content-type') || '',
      kind: inspection.kind
    }
  } catch (error) {
    if (existsSync(partial)) unlinkSync(partial)
    throw error
  }
}

function replaceExtension(path: string, extension: string): string {
  const current = extname(path)
  if (current.toLocaleLowerCase() === extension) return path
  return `${current ? path.slice(0, -current.length) : path}${extension}`
}
