import { closeSync, openSync, readSync } from 'fs'
import iconv from 'iconv-lite'

export type SubtitlePayloadKind = 'subtitle' | 'zip' | 'rar' | '7z'

export interface SubtitlePayloadInspection {
  kind: SubtitlePayloadKind
  extension: '.srt' | '.ass' | '.vtt' | '.zip' | '.rar' | '.7z'
}

const ZIP_SIGNATURES = [
  [0x50, 0x4b, 0x03, 0x04],
  [0x50, 0x4b, 0x05, 0x06],
  [0x50, 0x4b, 0x07, 0x08],
  [0x50, 0x4b, 0x06, 0x06]
]
const RAR4_SIGNATURE = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00]
const RAR5_SIGNATURE = [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]
const SEVEN_Z_SIGNATURE = [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c]

export function inspectSubtitlePayload(
  path: string,
  contentType: string,
  responseUrl: string
): SubtitlePayloadInspection {
  const buffer = Buffer.alloc(4096)
  const fd = openSync(path, 'r')
  let length = 0
  try {
    length = readSync(fd, buffer, 0, buffer.length, 0)
  } finally {
    closeSync(fd)
  }
  const head = buffer.subarray(0, length)
  const detected = detectSubtitlePayload(head)
  if (detected) return detected

  const text = decodePrefix(head).replace(/^\ufeff/, '').trimStart()
  const looksHtml =
    /^(?:<!doctype\s+html|<html|<head|<body)/i.test(text) ||
    /text\/html/i.test(contentType)
  const host = safeHost(responseUrl)
  const details = [
    host ? `来源 ${host}` : '',
    contentType ? `Content-Type ${contentType}` : ''
  ].filter(Boolean).join('，')

  if (looksHtml) {
    throw new Error(
      `download-rejected: 下载地址返回了 HTML 页面，不是字幕文件` +
      `${details ? `（${details}）` : ''}`
    )
  }
  if (/(?:rar|7z|zip|compressed|archive)/i.test(contentType)) {
    throw new Error(
      `corrupt-archive: 响应声明为压缩包，但文件头无效或下载内容不完整` +
      `${details ? `（${details}）` : ''}`
    )
  }
  throw new Error(
    `download-rejected: 下载地址返回了未知文件，不是支持的字幕或压缩包` +
    `${details ? `（${details}）` : ''}`
  )
}

export function detectSubtitlePayload(
  head: Uint8Array
): SubtitlePayloadInspection | undefined {
  if (ZIP_SIGNATURES.some((signature) => startsWith(head, signature))) {
    return { kind: 'zip', extension: '.zip' }
  }
  if (
    startsWith(head, RAR5_SIGNATURE) ||
    startsWith(head, RAR4_SIGNATURE)
  ) {
    return { kind: 'rar', extension: '.rar' }
  }
  if (startsWith(head, SEVEN_Z_SIGNATURE)) {
    return { kind: '7z', extension: '.7z' }
  }

  const text = decodePrefix(head).replace(/^\ufeff/, '').trimStart()
  if (/^WEBVTT\b/i.test(text)) {
    return { kind: 'subtitle', extension: '.vtt' }
  }
  if (/^\[Script Info\]/i.test(text) || /^Dialogue\s*:/im.test(text)) {
    return { kind: 'subtitle', extension: '.ass' }
  }
  if (
    /(?:^|\n)\d+\s*\n\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s*-->/m.test(text) ||
    /\d{1,2}:\d{2}:\d{2}[,.]\d{3}\s*-->/.test(text)
  ) {
    return { kind: 'subtitle', extension: '.srt' }
  }
  return undefined
}

function decodePrefix(buffer: Uint8Array): string {
  const bytes = Buffer.from(buffer)
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return iconv.decode(bytes, 'utf16-le')
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    return iconv.decode(bytes, 'utf16-be')
  }
  return bytes.toString('utf8')
}

function startsWith(buffer: Uint8Array, signature: number[]): boolean {
  return signature.every((byte, index) => buffer[index] === byte)
}

function safeHost(value: string): string {
  try {
    return new URL(value).host
  } catch {
    return ''
  }
}
