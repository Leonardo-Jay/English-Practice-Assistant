import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { LLMDiagnosticLogger } from './llm-diagnostic-logger'

const temporary: string[] = []

afterEach(() => {
  for (const directory of temporary.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe('local LLM diagnostic logging', () => {
  it('stores full prompts and responses while redacting configured credentials', () => {
    const directory = mkdtempSync(join(tmpdir(), 'llm-trace-'))
    temporary.push(directory)
    const logger = new LLMDiagnosticLogger(directory, () => true)
    logger.writeTrace({
      traceId: '12345678-test',
      timestamp: '2026-07-06T12:34:56.789Z',
      purpose: 'chat',
      operation: 'conversation-chat',
      conversationId: 'conversation-1',
      provider: 'longcat',
      model: 'LongCat-2.0',
      endpointHost: 'api.longcat.chat',
      protocol: 'openai',
      attempt: 1,
      request: {
        systemPrompt: 'Full system prompt',
        messages: [{ role: 'user', content: 'My key is secret-key' }],
        temperature: 0.7,
        maxTokens: 512
      },
      response: {
        httpStatus: 200,
        elapsedMs: 123,
        rawBody: '{"reply":"hello"}',
        extractedContent: 'hello'
      }
    }, ['secret-key'])

    const dayDirectory = join(directory, '2026-07-06')
    const content = readFileSync(
      join(dayDirectory, readdirSync(dayDirectory)[0]),
      'utf8'
    )
    expect(content).toContain('Full system prompt')
    expect(content).toContain('hello')
    expect(content).not.toContain('secret-key')
    expect(content).toContain('[redacted]')
  })

  it('writes visible user and assistant turns to a daily JSONL file', () => {
    const directory = mkdtempSync(join(tmpdir(), 'llm-conversation-'))
    temporary.push(directory)
    const logger = new LLMDiagnosticLogger(directory, () => true)
    logger.appendConversation({
      timestamp: '2026-07-06T12:34:56.789Z',
      conversationId: 'conversation-1',
      user: 'What happened?',
      assistant: 'The main conflict begins here.'
    })

    const content = readFileSync(
      join(directory, 'conversation-2026-07-06.jsonl'),
      'utf8'
    )
    expect(content).toContain('What happened?')
    expect(content).toContain('The main conflict begins here.')
  })
})
