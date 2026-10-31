import type {
  CorrectionContext,
  CorrectionSentenceUnit,
  Message
} from '../../shared/types'
import type {
  ConversationRepository,
  MessageRepository
} from '../database/repositories'

const MAX_PREVIOUS_MESSAGES = 6
const MAX_SUMMARY_CHARACTERS = 1_200
const MAX_MESSAGE_CHARACTERS = 800

function boundedText(value: string, limit: number): string {
  const text = value.trim()
  if (text.length <= limit) return text
  const side = Math.floor((limit - 5) / 2)
  return `${text.slice(0, side)}\n...\n${text.slice(-side)}`
}

export function segmentCorrectionSentences(
  input: string
): CorrectionSentenceUnit[] {
  const units: CorrectionSentenceUnit[] = []
  const pattern = /[^.!?。！？\n]+(?:[.!?。！？]+|(?=\n|$))/g
  for (const match of input.matchAll(pattern)) {
    if (match.index === undefined) continue
    const raw = match[0]
    const leading = raw.search(/\S/)
    if (leading < 0) continue
    const text = raw.trim()
    if (!/[\p{L}\p{N}]/u.test(text)) continue
    const startOffset = match.index + leading
    units.push({
      index: units.length,
      text,
      startOffset,
      endOffset: startOffset + text.length
    })
  }
  if (units.length === 0 && input.trim()) {
    const text = input.trim()
    const startOffset = input.indexOf(text)
    return [{
      index: 0,
      text,
      startOffset,
      endOffset: startOffset + text.length
    }]
  }
  return units
}

export class CorrectionContextAssembler {
  constructor(
    private readonly conversations: ConversationRepository,
    private readonly messages: MessageRepository
  ) {}

  build(conversationId: string, userMessageId: string): CorrectionContext {
    const target = this.messages.get(userMessageId)
    if (
      !target ||
      target.role !== 'user' ||
      target.conversationId !== conversationId ||
      target.sequence === undefined
    ) {
      throw new Error('纠错目标消息不存在或不属于当前会话。')
    }
    const conversation = this.conversations.getSummary(conversationId)
    if (!conversation) throw new Error('纠错目标会话不存在或已删除。')

    let previous = this.messages.getBeforeSequence(
      conversationId,
      target.sequence,
      MAX_PREVIOUS_MESSAGES
    )
    while (previous[0]?.role === 'assistant') previous = previous.slice(1)

    const contextState = this.conversations.getContextState(conversationId)
    return {
      conversationId,
      userMessageId,
      practiceMode: conversation.practiceMode,
      topic: conversation.topic,
      contextSummary: boundedText(
        contextState.summary,
        MAX_SUMMARY_CHARACTERS
      ),
      previousMessages: previous.map((message: Message) => ({
        role: message.role,
        content: boundedText(message.content, MAX_MESSAGE_CHARACTERS)
      })),
      targetText: target.content,
      sentences: segmentCorrectionSentences(target.content)
    }
  }
}
