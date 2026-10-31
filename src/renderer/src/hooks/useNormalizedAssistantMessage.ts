import { useMemo } from 'react'
import { normalizeAssistantReplyText } from '../../../shared/assistant-text'
import type { Message } from '../../types'

export function useNormalizedAssistantMessage(message: Message): Message {
  return useMemo(() => {
    if (message.role !== 'assistant') return message
    const content = normalizeAssistantReplyText(message.content)
    return content === message.content ? message : { ...message, content }
  }, [message])
}
