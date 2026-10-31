import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import { copyFile, stat } from 'fs/promises'
import { basename, join } from 'path'
import type { MediaIdentity } from '../../shared/types'
import { DEFAULT_SUBTITLE_LIMITS } from './constants'
import { inspectSubtitlePayload } from './archive-format'
import { extractSubtitleArchive } from './archive-extractor'
import type { SubtitleStorage } from './storage'

// Only the main process supplies filePath, from the native file picker.
// Stage a copy inside managed storage; never modify the user's original file.
export async function stageLocalSubtitle(
  storage: SubtitleStorage,
  media: MediaIdentity,
  jobId: string,
  filePath: string,
  signal: AbortSignal
) {
  signal.throwIfAborted()
  const info = await stat(filePath)
  if (!info.isFile() || !info.size || info.size > DEFAULT_SUBTITLE_LIMITS.maxDownloadBytes) {
    throw new Error('unsupported-archive: 请选择大小不超过 80 MB 的字幕或字幕压缩包。')
  }
  const work = storage.packageWorkDirectory(media, jobId)
  const rawPath = join(work, 'raw', storage.safeFilename(basename(filePath)))
  await copyFile(filePath, rawPath)
  signal.throwIfAborted()
  const payload = inspectSubtitlePayload(rawPath, '', '')
  const hash = createHash('sha256')
  let byteSize = 0
  for await (const chunk of createReadStream(rawPath, { signal })) {
    byteSize += chunk.length
    if (byteSize > DEFAULT_SUBTITLE_LIMITS.maxDownloadBytes) {
      throw new Error('unsafe-archive: 本地字幕包超过大小限制。')
    }
    hash.update(chunk)
  }
  const subtitleFiles = payload.kind === 'subtitle'
    ? [rawPath]
    : await extractSubtitleArchive(rawPath, join(work, 'extracted'), payload.kind)
  signal.throwIfAborted()
  return { rawPath, subtitleFiles, sha256: hash.digest('hex'), byteSize }
}
