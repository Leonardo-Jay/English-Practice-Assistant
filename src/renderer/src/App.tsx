import { useCallback, useEffect, useRef, useState } from 'react'
import ChatView from './components/ChatView'
import ConversationSidebar from './components/ConversationSidebar'
import LearningReviewPage from './components/LearningReviewPage'
import SettingsPage from './components/SettingsPage'
import MediaSuggestionBar from './components/MediaSuggestionBar'
import SubtitleWorkflowModal from './components/SubtitleWorkflowModal'
import { isLLMConfigUsable } from '../../shared/llm-providers'
import type {
  ConversationDetail,
  ConversationSummary,
  MediaMentionSuggestion,
  SubtitleJobProgress,
  SubtitleWorkflowRequest
} from '../types'
import {
  getActiveLLMProfile,
  loadLLMProfileStore,
  saveLLMProfileStore,
  updateLLMProfileModel
} from './utils/llm-config-storage'

const VOICE_STORAGE_KEY = 'english-practice-tts-voice'
const TTS_SPEED_STORAGE_KEY = 'english-practice-tts-speed'

type Page = 'chat' | 'review' | 'settings'

export default function App() {
  const [page, setPage] = useState<Page>('chat')
  const [modelName, setModelName] = useState(() => {
    const profile = getActiveLLMProfile(loadLLMProfileStore())
    return profile && isLLMConfigUsable(profile)
      ? `${profile.name}${profile.model ? ` · ${profile.model}` : ''}`
      : ''
  })
  const [conversations, setConversations] = useState<ConversationSummary[]>([])
  const [nextConversationCursor, setNextConversationCursor] = useState<number>()
  const [conversationQuery, setConversationQuery] = useState('')
  const [activeConversation, setActiveConversation] =
    useState<ConversationDetail | null>(null)
  const [conversationPanelOpen, setConversationPanelOpen] = useState(
    () => window.innerWidth >= 1180
  )
  const [databaseError, setDatabaseError] = useState('')
  const [mentionsByConversation, setMentionsByConversation] = useState<
    Record<string, MediaMentionSuggestion[]>
  >({})
  const [workflowOpen, setWorkflowOpen] = useState(false)
  const [workflowRequest, setWorkflowRequest] =
    useState<SubtitleWorkflowRequest>()
  const [backgroundJob, setBackgroundJob] = useState<SubtitleJobProgress>()
  const activeIdRef = useRef<string | undefined>(undefined)

  useEffect(() => {
    activeIdRef.current = activeConversation?.id
  }, [activeConversation?.id])

  const refreshMentions = useCallback(async (conversationId: string) => {
    const items = await window.api.listMediaMentions(conversationId)
      setMentionsByConversation((current) => ({
        ...current,
        [conversationId]: items
      }))
  }, [])

  useEffect(() => {
    const conversationId = activeConversation?.id
    if (!conversationId) return
    void refreshMentions(conversationId)
  }, [activeConversation?.id])

  const refreshList = useCallback(async (query = conversationQuery) => {
    const result = await window.api.listConversations(0, 100, query)
    setConversations(result.items)
    setNextConversationCursor(result.nextCursor)
  }, [conversationQuery])

  const loadMoreConversations = useCallback(async () => {
    if (nextConversationCursor === undefined) return
    const result = await window.api.listConversations(
      nextConversationCursor,
      100,
      conversationQuery
    )
    setConversations((current) => {
      const known = new Set(current.map((item) => item.id))
      return [...current, ...result.items.filter((item) => !known.has(item.id))]
    })
    setNextConversationCursor(result.nextCursor)
  }, [conversationQuery, nextConversationCursor])

  const searchConversations = useCallback(async (query: string) => {
    setConversationQuery(query)
    const result = await window.api.listConversations(0, 100, query)
    setConversations(result.items)
    setNextConversationCursor(result.nextCursor)
  }, [])

  const refreshConversation = useCallback(async (conversationId?: string) => {
    const detail = conversationId
      ? await window.api.getConversation(conversationId)
      : await window.api.getActiveConversation()
    setActiveConversation((current) => mergeConversationDetail(current, detail))
    activeIdRef.current = detail?.id
    await refreshList()
  }, [refreshList])

  const loadEarlierMessages = useCallback(async () => {
    const current = activeConversation
    const beforeSequence = current?.messages[0]?.sequence
    if (!current?.id || beforeSequence === undefined || !current.hasEarlierMessages) return
    const page = await window.api.getConversationMessages(current.id, beforeSequence, 80)
    setActiveConversation((latest) => {
      if (!latest || latest.id !== current.id) return latest
      const known = new Set(latest.messages.map((message) => message.id))
      return {
        ...latest,
        messages: [
          ...page.messages.filter((message) => !known.has(message.id)),
          ...latest.messages
        ],
        hasEarlierMessages: page.hasEarlierMessages
      }
    })
  }, [activeConversation])

  useEffect(() => {
    void (async () => {
      try {
        const remoteProfiles = await window.api.getLLMProfiles()
        const profileStore = remoteProfiles || loadLLMProfileStore()
        if (remoteProfiles) {
          saveLLMProfileStore(remoteProfiles)
        } else {
          await window.api.saveLLMProfiles(profileStore)
        }
        const profile = getActiveLLMProfile(profileStore)
        if (profile && isLLMConfigUsable(profile)) {
          await window.api.configureLLM(profile)
          setModelName(`${profile.name}${profile.model ? ` · ${profile.model}` : ''}`)
        }
        const savedVoice = localStorage.getItem(VOICE_STORAGE_KEY)
        if (savedVoice) await window.api.setTTSVoice(savedVoice)
        const savedSpeed = Number(localStorage.getItem(TTS_SPEED_STORAGE_KEY))
        if (Number.isFinite(savedSpeed) && savedSpeed > 0) {
          await window.api.setTTSSpeed(savedSpeed)
        }

        const databaseStatus = await window.api.getDatabaseStatus()
        if (!databaseStatus.ready) {
          setDatabaseError(databaseStatus.error || '学习数据库尚未就绪。')
          return
        }
        await refreshConversation()
      } catch (error) {
        setDatabaseError(error instanceof Error ? error.message : '应用数据初始化失败。')
      }
    })()
  }, [refreshConversation])

  useEffect(() => {
    const removeConversationListener = window.api.onConversationUpdated((event) => {
      void refreshList()
      void refreshMentions(event.conversationId)
      if (!activeIdRef.current || activeIdRef.current === event.conversationId) {
        void refreshConversation(
          event.reason === 'delete' ? undefined : event.conversationId
        )
      }
    })
    const removeReviewListener = window.api.onReviewUpdated(() => {
      void refreshList()
    })
    const removeModelSwitchListener = window.api.onLLMModelSwitched((event) => {
      const profile = updateLLMProfileModel(event.profileId, event.model)
      void window.api.saveLLMProfiles(loadLLMProfileStore()).catch(() => undefined)
      if (profile) {
        setModelName(`${profile.name} · ${profile.model}`)
      }
    })
    const removeMentionListener = window.api.onMediaMentionDetected((suggestion) => {
      setMentionsByConversation((current) => ({
        ...current,
        [suggestion.conversationId]: [
          suggestion,
          ...(current[suggestion.conversationId] || []).filter(
            (item) => item.id !== suggestion.id
          )
        ]
      }))
    })
    const removeSubtitleProgress = window.api.onSubtitleProgress((progress) => {
      setBackgroundJob(progress)
    })
    return () => {
      removeConversationListener()
      removeReviewListener()
      removeModelSwitchListener()
      removeMentionListener()
      removeSubtitleProgress()
    }
  }, [refreshConversation, refreshList, refreshMentions])

  const selectConversation = async (conversationId: string) => {
    const detail = await window.api.setActiveConversation(conversationId)
    setActiveConversation(detail)
    setPage('chat')
    if (window.innerWidth < 1024) setConversationPanelOpen(false)
  }

  const newConversation = () => {
    setActiveConversation(null)
    activeIdRef.current = undefined
    setPage('chat')
    if (window.innerWidth < 1024) setConversationPanelOpen(false)
  }

  const renameConversation = async (conversationId: string, title: string) => {
    await window.api.renameConversation(conversationId, title)
    await refreshConversation(activeIdRef.current)
  }

  const deleteConversation = async (conversationId: string) => {
    const nextId = await window.api.deleteConversation(conversationId)
    if (activeIdRef.current === conversationId) {
      setActiveConversation(nextId ? await window.api.getConversation(nextId) : null)
    }
    await refreshList()
  }

  const activeSuggestion = activeConversation?.id
    ? (mentionsByConversation[activeConversation.id] || []).find(
        (item) => item.status === 'pending'
      )
    : undefined

  const openWorkflow = (request: SubtitleWorkflowRequest) => {
    setWorkflowRequest(request)
    setWorkflowOpen(true)
  }

  const openSuggestionWorkflow = (suggestion: MediaMentionSuggestion) => {
    openWorkflow({
      requestId: crypto.randomUUID(),
      origin: 'chat',
      conversationId: suggestion.conversationId,
      mentionId: suggestion.id,
      mediaType: suggestion.media.type,
      title: suggestion.media.title,
      aliases: suggestion.media.aliases,
      year: suggestion.media.year,
      season: suggestion.season,
      episode: suggestion.episode
    })
  }

  const acceptSuggestion = async (suggestion: MediaMentionSuggestion) => {
    if (suggestion.availability !== 'ready') {
      openSuggestionWorkflow(suggestion)
      return
    }
    try {
      await window.api.startSubtitleWorkflow({
        requestId: crypto.randomUUID(),
        origin: 'chat',
        conversationId: suggestion.conversationId,
        mentionId: suggestion.id,
        mediaType: suggestion.media.type,
        title: suggestion.media.title,
        aliases: suggestion.media.aliases,
        year: suggestion.media.year,
        season: suggestion.season,
        episode: suggestion.episode
      })
      await refreshMentions(suggestion.conversationId)
      await refreshConversation(suggestion.conversationId)
    } catch {
      // Keep the full workflow available when local metadata or files need repair.
      openSuggestionWorkflow(suggestion)
    }
  }

  const dismissSuggestion = async (suggestion: MediaMentionSuggestion) => {
    await window.api.dismissMediaMention(suggestion.id)
    setMentionsByConversation((current) => ({
      ...current,
      [suggestion.conversationId]: (current[suggestion.conversationId] || [])
        .map((item) =>
          item.id === suggestion.id ? { ...item, status: 'dismissed' } : item
        )
    }))
  }

  const navItems: Array<{ id: Page; label: string; icon: string }> = [
    { id: 'chat', label: '对话', icon: '◌' },
    { id: 'review', label: '复习', icon: '◇' },
    { id: 'settings', label: '设置', icon: '⚙' }
  ]

  return (
    <div className="flex h-screen min-h-0 bg-slate-50 text-slate-900">
      <aside className="flex w-16 shrink-0 flex-col items-center border-r border-slate-200 bg-white py-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-blue-600 font-bold text-white">
          E
        </div>
        <nav className="mt-6 flex w-full flex-col gap-2 px-2">
          {navItems.map((item) => (
            <button
              key={item.id}
              onClick={() => setPage(item.id)}
              className={`flex h-12 flex-col items-center justify-center rounded-xl text-[11px] transition ${
                page === item.id
                  ? 'bg-blue-50 font-semibold text-blue-700'
                  : 'text-slate-500 hover:bg-slate-100'
              }`}
              title={item.label}
            >
              <span className="text-base leading-none">{item.icon}</span>
              <span className="mt-1">{item.label}</span>
            </button>
          ))}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-16 shrink-0 items-center justify-between border-b border-slate-200 bg-white px-4 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            {page === 'chat' && (
              <button
                onClick={() => setConversationPanelOpen((value) => !value)}
                className="flex h-9 w-9 items-center justify-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
                title="会话列表"
              >
                ☰
              </button>
            )}
            <div className="min-w-0">
              <h1 className="truncate text-base font-semibold">
                {page === 'chat'
                  ? activeConversation?.title || '新对话'
                  : page === 'review'
                    ? '学习复习'
                    : '设置'}
              </h1>
              <p className="truncate text-xs text-slate-500">
                {modelName ? `当前模型：${modelName}` : '尚未配置大模型'}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {backgroundJob && !['ready', 'failed', 'cancelled'].includes(backgroundJob.phase) && (
              <button
                type="button"
                onClick={() => setWorkflowOpen(true)}
                className="rounded-xl border border-blue-200 bg-blue-50 px-3 py-2 text-xs font-semibold text-blue-700 hover:bg-blue-100"
                title={backgroundJob.message}
              >
                字幕任务 · {backgroundJob.percent !== undefined
                  ? `${backgroundJob.percent}%`
                  : '进行中'}
              </button>
            )}
            {page === 'chat' && (
              <button
                onClick={newConversation}
                className="rounded-xl bg-blue-600 px-3.5 py-2 text-sm font-semibold text-white hover:bg-blue-700"
              >
                ＋ 新对话
              </button>
            )}
          </div>
        </header>

        {page === 'chat' && activeSuggestion && (
          <MediaSuggestionBar
            suggestion={activeSuggestion}
            onAccept={() => void acceptSuggestion(activeSuggestion)}
            onDismiss={() => void dismissSuggestion(activeSuggestion)}
          />
        )}

        {databaseError ? (
          <main className="flex min-h-0 flex-1 items-center justify-center p-6">
            <div className="max-w-lg rounded-2xl border border-red-200 bg-white p-6 text-center shadow-sm">
              <h2 className="font-semibold text-red-700">学习数据库无法使用</h2>
              <p className="mt-2 text-sm leading-6 text-slate-600">{databaseError}</p>
              <button
                onClick={() => window.api.openDataDirectory()}
                className="mt-4 rounded-xl border border-slate-200 px-4 py-2 text-sm hover:bg-slate-50"
              >
                打开数据目录
              </button>
            </div>
          </main>
        ) : (
          <main className="relative flex min-h-0 min-w-0 flex-1 overflow-hidden">
            {page === 'chat' && conversationPanelOpen && (
              <>
                <div
                  className="absolute inset-0 z-20 bg-slate-900/25 lg:hidden"
                  onClick={() => setConversationPanelOpen(false)}
                />
                <div className="absolute inset-y-0 left-0 z-30 lg:relative lg:z-auto">
                  <ConversationSidebar
                    conversations={conversations}
                    activeConversationId={activeConversation?.id}
                    onNew={newConversation}
                    onSelect={(id) => void selectConversation(id)}
                    onRename={(id, title) => void renameConversation(id, title)}
                    onDelete={(id) => void deleteConversation(id)}
                    onSearch={(query) => void searchConversations(query)}
                    hasMore={nextConversationCursor !== undefined}
                    onLoadMore={() => void loadMoreConversations()}
                    onClose={() => setConversationPanelOpen(false)}
                  />
                </div>
              </>
            )}
            <div className="min-h-0 min-w-0 flex-1">
              {page === 'chat' ? (
                <ChatView
                  conversation={activeConversation}
                  onOpenSettings={() => setPage('settings')}
                  onConversationChanged={refreshConversation}
                  onLoadEarlier={() => void loadEarlierMessages()}
                  onDeleteCurrent={async () => {
                    if (activeConversation?.id) {
                      await deleteConversation(activeConversation.id)
                    } else {
                      newConversation()
                    }
                  }}
                />
              ) : page === 'review' ? (
                <LearningReviewPage
                  conversations={conversations}
                  initialConversationId={activeConversation?.id}
                />
              ) : (
                <SettingsPage
                  onConfigSaved={(model) => setModelName(model)}
                  onOpenSubtitleWorkflow={(title, mediaType, details) =>
                    openWorkflow({
                      requestId: crypto.randomUUID(),
                      origin: 'settings',
                      mediaType,
                      title,
                      ...details
                    })
                  }
                />
              )}
            </div>
          </main>
        )}
      </div>
      <SubtitleWorkflowModal
        open={workflowOpen}
        initialRequest={workflowRequest}
        resumeProgress={backgroundJob}
        onClose={() => setWorkflowOpen(false)}
      />
    </div>
  )
}

function mergeConversationDetail(
  current: ConversationDetail | null,
  incoming: ConversationDetail | null
): ConversationDetail | null {
  if (!current || !incoming || current.id !== incoming.id || current.messages.length === 0) {
    return incoming
  }
  const incomingEarliest = incoming.messages[0]?.sequence
  if (incomingEarliest === undefined) return incoming
  const retained = current.messages.filter(
    (message) => (message.sequence ?? Number.MAX_SAFE_INTEGER) < incomingEarliest
  )
  if (!retained.length) return incoming
  return {
    ...incoming,
    messages: [...retained, ...incoming.messages],
    hasEarlierMessages: current.hasEarlierMessages
  }
}
