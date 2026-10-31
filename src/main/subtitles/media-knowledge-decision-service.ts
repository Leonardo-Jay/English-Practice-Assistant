import type {
  GroundedMediaContext,
  Message
} from '../../shared/types'
import type { LLMClient } from '../services/llm-client'
import type { SubtitleLibraryService } from './subtitle-library-service'

export class MediaKnowledgeDecisionService {
  constructor(
    private readonly llm: LLMClient,
    private readonly library: SubtitleLibraryService
  ) {}

  async contextsForReply(
    conversationId: string,
    latestMessage: string,
    recentMessages: Message[]
  ): Promise<GroundedMediaContext[]> {
    const linked = this.library.linked(conversationId)
    if (!linked.length) {
      console.info(
        `[subtitle-knowledge] conversation=${conversationId.slice(0, 8)} ` +
          'linked=0 injected=0'
      )
      return []
    }
    try {
      const decision = await this.llm.decideMediaKnowledge(
        latestMessage,
        recentMessages,
        linked.map((item) => item.entry)
      )
      const selected = selectBestScope(
        linked.filter((item) => decision.scopeIds.includes(item.entry.scopeId)),
        latestMessage,
        recentMessages
      )
      const effective = decision.useKnowledge && selected.length
        ? selected
        : needsPlotFacts(latestMessage)
          ? selectBestScope(linked, latestMessage, recentMessages)
          : []
      console.info(
        `[subtitle-knowledge] conversation=${conversationId.slice(0, 8)} ` +
          `linked=${linked.length} decision=${decision.useKnowledge} ` +
          `requested=${decision.scopeIds.length} injected=${effective.length}`
      )
      return effective
        .slice(0, 2)
        .map((item) =>
          this.library.groundedContext(
            item.entry,
            item.knowledge,
            decision.retrievalQuery || latestMessage
          )
        )
    } catch (error) {
      console.warn('[subtitle-knowledge] decision failed, using conservative fallback:', error)
      if (!needsPlotFacts(latestMessage)) return []
      return selectBestScope(linked, latestMessage, recentMessages)
        .slice(0, 1)
        .map((fallback) =>
          this.library.groundedContext(
            fallback.entry,
            fallback.knowledge,
            latestMessage
          )
        )
    }
  }
}

const needsPlotFacts = (content: string) =>
  /(?:plot|scene|episode|what happened|why did|dialogue|line|ending|剧情|情节|这一集|发生了什么|为什么|对白|台词|结局|关系变化)/i
    .test(content)

function selectBestScope(
  linked: ReturnType<SubtitleLibraryService['linked']>,
  latestMessage: string,
  recentMessages: Message[]
) {
  const text = [
    ...recentMessages.slice(-6).map((message) => message.content),
    latestMessage
  ].join(' ').toLocaleLowerCase()
  const requestedEpisode = extractNumber(text, [
    /season\s*\d+\s*[,;:-]?\s*episode\s*(\d+)/i,
    /\bs\d{1,2}e(\d{1,3})\b/i,
    /第\s*\d+\s*季\s*第\s*(\d+)\s*集/
  ])
  const requestedSeason = extractNumber(text, [
    /season\s*(\d+)/i,
    /\bs(\d{1,2})e\d{1,3}\b/i,
    /第\s*(\d+)\s*季/
  ])
  const scoped = linked.filter(({ entry }) =>
    (requestedSeason === undefined || entry.season === requestedSeason) &&
    (requestedEpisode === undefined || entry.episode === requestedEpisode)
  )
  if (!scoped.length && (requestedSeason !== undefined || requestedEpisode !== undefined)) {
    return []
  }
  const candidates = scoped.length ? scoped : linked
  const titleMatches = candidates.filter(({ entry }) =>
    [entry.media.title, ...entry.media.aliases].some((title) =>
      title && text.includes(title.toLocaleLowerCase())
    )
  )
  return titleMatches.length ? titleMatches : candidates.slice(0, 1)
}

function extractNumber(text: string, patterns: RegExp[]): number | undefined {
  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match) return Number(match[1])
  }
  return undefined
}
