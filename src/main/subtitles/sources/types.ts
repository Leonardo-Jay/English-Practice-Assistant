import type {
  SubtitleCandidate,
  SubtitleFeatureConfig,
  SubtitleDownloadResolution,
  SubtitleSearchQuery,
  SubtitleSourceHealth,
  SubtitleSourceId,
  SubtitleSourceOutcome
} from '../../../shared/types'

// Public extension contract only. Website sessions, parsers and verification
// implementations belong to the separately maintained private provider.
export interface SubtitleSourceSession {
  fetch(url: string, init?: RequestInit, signal?: AbortSignal): Promise<{
    status: number
    ok: boolean
    url: string
    headers: Headers
    text(): Promise<string>
    arrayBuffer(): Promise<ArrayBuffer>
  }>
  setCookie(name: string, value: string): void
  getCookie(name: string): string | undefined
}

export interface SubtitleSourceProvider {
  readonly available: boolean
  createAdapters(config: SubtitleFeatureConfig): SubtitleSourceAdapter[]
  createSession(timeoutMs: number): SubtitleSourceSession
}

export interface SourceResult<T> {
  outcome: SubtitleSourceOutcome
  value?: T
  diagnostic?: string
}

export interface SubtitleSourceAdapter {
  readonly id: SubtitleSourceId
  healthCheck(signal?: AbortSignal): Promise<SubtitleSourceHealth>
  search(
    query: SubtitleSearchQuery,
    session: SubtitleSourceSession,
    signal?: AbortSignal
  ): Promise<SourceResult<SubtitleCandidate[]>>
  resolveDownload(
    candidate: SubtitleCandidate,
    session: SubtitleSourceSession,
    signal?: AbortSignal
  ): Promise<SourceResult<SubtitleDownloadResolution>>
}
