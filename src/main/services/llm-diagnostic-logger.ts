import { mkdirSync, writeFileSync, appendFileSync } from 'fs'
import { join } from 'path'

export type LLMTraceRecord = {
  traceId: string
  timestamp: string
  purpose: string
  operation?: string
  conversationId?: string
  provider: string
  model: string
  endpointHost: string
  protocol: string
  attempt: number
  request: {
    systemPrompt: string
    messages: Array<{ role: string; content: string }>
    temperature?: number
    maxTokens?: number
    thinkingDisabled?: boolean
  }
  response?: {
    httpStatus?: number
    elapsedMs: number
    rawBody?: string
    extractedContent?: string
  }
  error?: string
}

export class LLMDiagnosticLogger {
  constructor(
    readonly directory: string,
    private readonly isEnabled: () => boolean
  ) {}

  get enabled(): boolean {
    return this.isEnabled()
  }

  writeTrace(record: LLMTraceRecord, secrets: string[] = []): void {
    if (!this.enabled) return
    try {
      const day = record.timestamp.slice(0, 10)
      const directory = join(this.directory, day)
      mkdirSync(directory, { recursive: true })
      const time = record.timestamp
        .slice(11, 23)
        .replace(/[:.]/g, '-')
      const operation = safeSegment(record.operation || record.purpose)
      const filename = `${time}_${operation}_${record.traceId.slice(0, 8)}_a${record.attempt}.json`
      const sanitized = redact(record, secrets)
      writeFileSync(
        join(directory, filename),
        JSON.stringify(sanitized, null, 2),
        'utf8'
      )
    } catch (error) {
      console.warn(
        '[llm-diagnostics] trace write failed:',
        error instanceof Error ? error.message : String(error)
      )
    }
  }

  appendConversation(
    record: {
      timestamp: string
      conversationId?: string
      user: string
      assistant?: string
      error?: string
    },
    secrets: string[] = []
  ): void {
    if (!this.enabled) return
    try {
      mkdirSync(this.directory, { recursive: true })
      const day = record.timestamp.slice(0, 10)
      appendFileSync(
        join(this.directory, `conversation-${day}.jsonl`),
        `${JSON.stringify(redact(record, secrets))}\n`,
        'utf8'
      )
    } catch (error) {
      console.warn(
        '[llm-diagnostics] conversation write failed:',
        error instanceof Error ? error.message : String(error)
      )
    }
  }
}

function safeSegment(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'request'
}

function redact<T>(value: T, secrets: string[]): T {
  const blockedKeys = /^(?:authorization|cookie|set-cookie|x-api-key|apiKey|apiId|key)$/i
  const secretValues = secrets.filter((secret) => secret.length >= 3)
  const visit = (input: unknown, key = ''): unknown => {
    if (blockedKeys.test(key)) return '[redacted]'
    if (typeof input === 'string') {
      let output = input.replace(/Bearer\s+\S+/gi, 'Bearer [redacted]')
      for (const secret of secretValues) {
        output = output.split(secret).join('[redacted]')
      }
      return output
    }
    if (Array.isArray(input)) return input.map((item) => visit(item))
    if (input && typeof input === 'object') {
      return Object.fromEntries(
        Object.entries(input).map(([childKey, child]) => [
          childKey,
          visit(child, childKey)
        ])
      )
    }
    return input
  }
  return visit(value) as T
}
