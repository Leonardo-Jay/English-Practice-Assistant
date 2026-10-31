import { useState, useRef, useEffect, useCallback } from 'react'
import ChatBubble from './ChatBubble'
import RecordButton from './RecordButton'
import { useAudioPlayback } from '../hooks/useAudioPlayback'
import { useAudioCapture } from '../hooks/useAudioCapture'
import { normalizeAssistantReplyText } from '../../../shared/assistant-text'
import type {
  ConversationDetail,
  Message,
  ChatResponse,
  SttInstallerState,
  SttModelPreset,
  SttStatus,
  VoiceCaptureSettings
} from '../../types'

interface Props {
  onOpenSettings: () => void
  conversation: ConversationDetail | null
  onConversationChanged: (conversationId?: string) => void | Promise<void>
  onDeleteCurrent: () => void | Promise<void>
  onLoadEarlier: () => void | Promise<void>
}

const MAX_CACHED_SPEECH_MESSAGES = 3
const MAX_CACHED_SPEECH_BYTES = 12 * 1024 * 1024

export default function ChatView({
  onOpenSettings,
  conversation,
  onConversationChanged,
  onDeleteCurrent,
  onLoadEarlier
}: Props) {
  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [isGeneratingSpeech, setIsGeneratingSpeech] = useState(false)
  const [activeSpeechMessageId, setActiveSpeechMessageId] = useState<string | null>(null)
  const [voiceConversationActive, setVoiceConversationActive] = useState(false)
  const [error, setError] = useState('')
  const [retryingAnalysisKeys, setRetryingAnalysisKeys] = useState<Set<string>>(
    () => new Set()
  )
  const [sttStatus, setSttStatus] = useState<SttStatus | null>(null)
  const [sttPresets, setSttPresets] = useState<SttModelPreset[]>([])
  const [installerState, setInstallerState] = useState<SttInstallerState>({
    isInstalling: false,
    progress: 0,
    message: '尚未开始安装语音识别模型。',
    downloadedBytes: 0
  })
  const [sttActionMessage, setSttActionMessage] = useState('')
  const [sttActionBusy, setSttActionBusy] = useState(false)
  const [voiceCaptureSettings, setVoiceCaptureSettings] =
    useState<VoiceCaptureSettings>({
      initialSilenceMs: 20_000,
      silenceAfterSpeechMs: 5_000,
      speechRmsThreshold: 0.012
    })
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const [showMoreMenu, setShowMoreMenu] = useState(false)
  const messagesEndRef = useRef<HTMLDivElement>(null)
  const voiceConversationRef = useRef(false)
  const autoStopInProgressRef = useRef(false)
  const handledSpeechEndRef = useRef(0)
  const speechTaskIdRef = useRef(0)
  const speechAudioCacheRef = useRef<Map<string, ArrayBuffer[]>>(new Map())
  const suppressNextAutoScrollRef = useRef(false)
  const { isPlaying, play: playAudio, speakWithSystemVoice, stop: stopAudio } = useAudioPlayback()
  const {
    isRecording,
    partialText,
    speechEndSequence,
    error: captureError,
    start: startRecording,
    stop: stopRecording
  } = useAudioCapture(voiceCaptureSettings)

  const refreshSttStatus = useCallback(async () => {
    const status = await window.api.getSTTStatus()
    setSttStatus(status)
    return status
  }, [])

  const refreshInstallerState = useCallback(async () => {
    const state = await window.api.getSTTInstallerState()
    setInstallerState(state)
    return state
  }, [])

  useEffect(() => {
    if (suppressNextAutoScrollRef.current) {
      suppressNextAutoScrollRef.current = false
      return
    }
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  useEffect(() => {
    setMessages(conversation?.messages || [])
    speechAudioCacheRef.current.clear()
  }, [conversation?.id, conversation?.messages])

  useEffect(() => () => {
    speechAudioCacheRef.current.clear()
  }, [])

  const cacheSpeechAudio = (messageId: string, audio: ArrayBuffer[]) => {
    const cache = speechAudioCacheRef.current
    const byteLength = audio.reduce((total, item) => total + item.byteLength, 0)
    if (byteLength > MAX_CACHED_SPEECH_BYTES) return

    cache.delete(messageId)
    cache.set(messageId, audio)
    let cachedBytes = [...cache.values()]
      .flat()
      .reduce((total, item) => total + item.byteLength, 0)
    while (cache.size > MAX_CACHED_SPEECH_MESSAGES || cachedBytes > MAX_CACHED_SPEECH_BYTES) {
      const oldest = cache.entries().next().value as [string, ArrayBuffer[]] | undefined
      if (!oldest) break
      cache.delete(oldest[0])
      cachedBytes -= oldest[1].reduce((total, item) => total + item.byteLength, 0)
    }
  }

  useEffect(() => {
    let cancelled = false

    void (async () => {
      try {
        const [status, presets, installer, captureSettings] = await Promise.all([
          window.api.getSTTStatus(),
          window.api.getSTTModelPresets(),
          window.api.getSTTInstallerState(),
          window.api.getVoiceCaptureSettings()
        ])

        if (cancelled) {
          return
        }

        setSttStatus(status)
        setSttPresets(presets)
        setInstallerState(installer)
        setVoiceCaptureSettings(captureSettings)
      } catch {
        if (!cancelled) {
          setError('加载对话记录失败。')
        }
      }
    })()

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (!installerState.isInstalling) {
      return
    }

    const timer = window.setInterval(() => {
      void refreshInstallerState()
    }, 800)

    return () => {
      window.clearInterval(timer)
    }
  }, [installerState.isInstalling, refreshInstallerState])

  const speakReply = async (
    reply: string,
    resumeVoiceConversation: boolean,
    taskId: number,
    messageId: string
  ) => {
    const normalizedReply = normalizeAssistantReplyText(reply)
    if (!normalizedReply) {
      if (resumeVoiceConversation && voiceConversationRef.current) {
        await startRecording()
      }
      return
    }
    setIsGeneratingSpeech(true)
    try {
      const cachedAudio = speechAudioCacheRef.current.get(messageId)
      if (cachedAudio?.length) {
        setIsGeneratingSpeech(false)
        for (const audioBuffer of cachedAudio) {
          if (taskId !== speechTaskIdRef.current) return
          await playAudio(audioBuffer)
        }
        return
      }

      const sentences =
        normalizedReply.match(/[^.!?。！？]+[.!?。！？]+|[^.!?。！？]+$/g)
          ?.map((sentence) => sentence.trim())
          .filter(Boolean) || [normalizedReply]

      const createAudioJob = async (sentence: string) => {
        try {
          return {
            audioBuffer: await window.api.synthesizeTTS(sentence),
            error: null
          }
        } catch (error) {
          return { audioBuffer: null, error }
        }
      }

      // Safe pipeline: only one native synthesis runs at a time. As soon as
      // one sentence is ready, start generating the next while the current
      // sentence plays in Chromium.
      let audioJob = createAudioJob(sentences[0])
      const generatedAudio: ArrayBuffer[] = []
      for (let index = 0; index < sentences.length; index += 1) {
        if (
          taskId !== speechTaskIdRef.current ||
          (resumeVoiceConversation && !voiceConversationRef.current)
        ) {
          return
        }
        const { audioBuffer, error } = await audioJob
        if (error || !audioBuffer) {
          throw error || new Error('语音生成失败。')
        }
        generatedAudio.push(audioBuffer)
        const nextAudioJob =
          index + 1 < sentences.length
            ? createAudioJob(sentences[index + 1])
            : null
        if (
          taskId !== speechTaskIdRef.current ||
          (resumeVoiceConversation && !voiceConversationRef.current)
        ) {
          return
        }
        await playAudio(audioBuffer)
        if (nextAudioJob) {
          audioJob = nextAudioJob
        }
      }
      cacheSpeechAudio(messageId, generatedAudio)
    } catch (ttsError) {
      if (
        taskId !== speechTaskIdRef.current ||
        (resumeVoiceConversation && !voiceConversationRef.current)
      ) {
        return
      }
      try {
        await speakWithSystemVoice(normalizedReply)
      } catch (fallbackError) {
        const detail =
          fallbackError instanceof Error
            ? fallbackError.message
            : ttsError instanceof Error
              ? ttsError.message
              : '未知错误'
        setError(`文字回复已收到，但语音播报失败：${detail}`)
      }
    } finally {
      if (taskId === speechTaskIdRef.current) {
        setIsGeneratingSpeech(false)
        setActiveSpeechMessageId(null)
        if (resumeVoiceConversation && voiceConversationRef.current) {
          await startRecording()
        }
      }
    }
  }

  const handleSend = async (textOverride?: string, resumeVoiceConversation = false) => {
    const text = (textOverride || input).trim()
    if (!text || isLoading) return

    setInput('')
    setError('')
    const clientRequestId = crypto.randomUUID()
    const userMsg: Message = {
      id: clientRequestId,
      role: 'user',
      content: text,
      timestamp: Date.now(),
      inputMode: textOverride ? 'voice' : 'text',
      status: 'pending'
    }
    setMessages((prev) => [...prev, userMsg])
    setIsLoading(true)

    let speechScheduled = false
    try {
      const result: ChatResponse = await window.api.sendChat({
        conversationId: conversation?.id,
        clientRequestId,
        content: text,
        inputMode: textOverride ? 'voice' : 'text'
      })
      const assistantReply = normalizeAssistantReplyText(result.reply)
      const assistantMsg: Message = {
        id: result.assistantMessageId,
        conversationId: result.conversationId,
        role: 'assistant',
        content: assistantReply,
        timestamp: Date.now(),
        status: 'complete',
        replyToMessageId: result.userMessageId
      }
      setMessages((prev) => [
        ...prev.map((message) =>
          message.id === userMsg.id
            ? {
                ...message,
                id: result.userMessageId,
                conversationId: result.conversationId,
                status: 'complete' as const
              }
            : message
        ),
        assistantMsg
      ])
      await onConversationChanged(result.conversationId)

      // Corrections run in a separate, stateless model request and are
      // attached to the matching user message when they finish.
      void window.api
        .analyzeCorrections(result.conversationId, text, result.userMessageId)
        .then((corrections) => {
          setMessages((prev) =>
            prev.map((message) =>
              message.id === result.userMessageId
                ? {
                    ...message,
                    corrections,
                    correctionStatus: 'complete'
                  }
                : message
            )
          )
          void onConversationChanged(result.conversationId)
        })
        .catch(() => {
          // Correction failure must not interrupt the conversation or speech.
        })

      // Vocabulary analysis is another isolated request. It only studies the
      // assistant reply and is attached beneath that assistant message.
      void window.api
        .analyzeVocabulary(
          result.conversationId,
          assistantReply,
          result.assistantMessageId
        )
        .then((vocabulary) => {
          setMessages((prev) =>
            prev.map((message) =>
              message.id === assistantMsg.id
                ? {
                    ...message,
                    vocabulary,
                    vocabularyStatus: 'complete'
                  }
                : message
            )
          )
          void onConversationChanged(result.conversationId)
        })
        .catch(() => {
          // Vocabulary analysis is optional and never blocks voice playback.
        })

      if (assistantReply) {
        speechScheduled = true
        const taskId = ++speechTaskIdRef.current
        setActiveSpeechMessageId(assistantMsg.id)
        void speakReply(
          assistantReply,
          resumeVoiceConversation,
          taskId,
          assistantMsg.id
        )
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取回复失败。')
      setMessages((prev) =>
        prev.map((message) =>
          message.id === userMsg.id ? { ...message, status: 'failed' } : message
        )
      )
      void onConversationChanged(conversation?.id)
    } finally {
      setIsLoading(false)
      if (!speechScheduled && resumeVoiceConversation && voiceConversationRef.current) {
        await startRecording()
      }
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  const handleRecordingStop = async (automatic = false) => {
    const text = await stopRecording()
    if (automatic && !voiceConversationRef.current) {
      return
    }
    const hasMeaningfulSpeech = /[\p{L}\p{N}]/u.test(text)
    if (hasMeaningfulSpeech) {
      await handleSend(text, true)
    } else {
      voiceConversationRef.current = false
      setVoiceConversationActive(false)
    }
  }

  const handleRecordingStart = async () => {
    setError('')
    speechTaskIdRef.current += 1
    setIsGeneratingSpeech(false)
    setActiveSpeechMessageId(null)
    stopAudio()
    voiceConversationRef.current = true
    setVoiceConversationActive(true)
    await startRecording()
    try {
      const status = await window.api.getSTTStatus()
      setSttStatus(status)
    } catch {
      // Ignore status refresh errors.
    }
  }

  useEffect(() => {
    const handleRecordingShortcut = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat) return
      const target = event.target
      if (
        target instanceof HTMLElement &&
        (target.matches('input, textarea, select, button') || target.isContentEditable)
      ) {
        return
      }
      if (isRecording) {
        event.preventDefault()
        void handleRecordingStop(false)
        return
      }
      if (!isLoading && !isGeneratingSpeech) {
        event.preventDefault()
        void handleRecordingStart()
      }
    }

    window.addEventListener('keydown', handleRecordingShortcut)
    return () => window.removeEventListener('keydown', handleRecordingShortcut)
  }, [isRecording, isLoading, isGeneratingSpeech])

  useEffect(() => {
    if (
      speechEndSequence === 0 ||
      speechEndSequence === handledSpeechEndRef.current ||
      !isRecording ||
      isLoading ||
      autoStopInProgressRef.current
    ) {
      return
    }

    handledSpeechEndRef.current = speechEndSequence
    autoStopInProgressRef.current = true
    void handleRecordingStop(true).finally(() => {
      autoStopInProgressRef.current = false
    })
  }, [speechEndSequence, isRecording, isLoading])

  const handleStopConversation = async () => {
    voiceConversationRef.current = false
    setVoiceConversationActive(false)
    speechTaskIdRef.current += 1
    setIsGeneratingSpeech(false)
    setActiveSpeechMessageId(null)
    stopAudio()
    if (isRecording) {
      await stopRecording()
    }
  }

  const handleStopPlayback = () => {
    const resumeRecording = voiceConversationRef.current
    speechTaskIdRef.current += 1
    setIsGeneratingSpeech(false)
    setActiveSpeechMessageId(null)
    stopAudio()
    if (resumeRecording) {
      void startRecording()
    }
  }

  const handleReplayMessage = async (message: Message) => {
    voiceConversationRef.current = false
    setVoiceConversationActive(false)
    if (isRecording) {
      await stopRecording()
    }
    speechTaskIdRef.current += 1
    stopAudio()
    const taskId = speechTaskIdRef.current
    setActiveSpeechMessageId(message.id)
    void speakReply(message.content, false, taskId, message.id)
  }

  const handleRetryMessage = async (message: Message) => {
    if (!conversation?.id || isLoading) return
    setIsLoading(true)
    setError('')
    try {
      const result = await window.api.retryChat(conversation.id, message.id)
      await onConversationChanged(conversation.id)
      const taskId = ++speechTaskIdRef.current
      setActiveSpeechMessageId(result.assistantMessageId)
      void speakReply(
        result.reply,
        voiceConversationRef.current,
        taskId,
        result.assistantMessageId
      )
      void window.api
        .analyzeCorrections(conversation.id, message.content, message.id)
        .then(() => onConversationChanged(conversation.id))
        .catch(() => undefined)
      void window.api
        .analyzeVocabulary(
          conversation.id,
          normalizeAssistantReplyText(result.reply),
          result.assistantMessageId
        )
        .then(() => onConversationChanged(conversation.id))
        .catch(() => undefined)
    } catch (retryError) {
      setError(retryError instanceof Error ? retryError.message : '重试失败。')
      await onConversationChanged(conversation.id)
    } finally {
      setIsLoading(false)
    }
  }

  const handleRetryAnalysis = async (
    message: Message,
    kind: 'correction' | 'vocabulary'
  ) => {
    if (!conversation?.id) return
    const key = `${message.id}:${kind}`
    if (retryingAnalysisKeys.has(key)) return
    setRetryingAnalysisKeys((current) => new Set(current).add(key))
    setError('')
    try {
      if (kind === 'correction') {
        await window.api.analyzeCorrections(
          conversation.id,
          message.content,
          message.id
        )
      } else {
        await window.api.analyzeVocabulary(
          conversation.id,
          normalizeAssistantReplyText(message.content),
          message.id
        )
      }
      await onConversationChanged(conversation.id)
    } catch (analysisError) {
      const label = kind === 'correction' ? '纠错分析' : '生词分析'
      setError(
        `${label}重试失败：${
          analysisError instanceof Error ? analysisError.message : '未知错误'
        }`
      )
      await onConversationChanged(conversation.id)
    } finally {
      setRetryingAnalysisKeys((current) => {
        const next = new Set(current)
        next.delete(key)
        return next
      })
    }
  }

  const handleClear = async () => {
    if (!conversation?.id) {
      setMessages([])
      setShowMoreMenu(false)
      return
    }
    if (!window.confirm('确定要将当前对话移入回收站吗？你可在设置的回收站中恢复或彻底删除。')) {
      setShowMoreMenu(false)
      return
    }
    await handleStopConversation()
    await onDeleteCurrent()
    stopAudio()
    setMessages([])
    speechAudioCacheRef.current.clear()
    setShowMoreMenu(false)
  }

  const handleInstallStt = async () => {
    const presetId = sttPresets[0]?.id
    if (!presetId) {
      setSttActionMessage('当前没有可安装的语音识别模型预设，请先打开设置页查看。')
      return
    }

    setSttActionBusy(true)
    setSttActionMessage('')
    setInstallerState({
      isInstalling: true,
      presetId,
      progress: 0,
      message: '已开始安装，正在准备下载...',
      downloadedBytes: 0
    })

    try {
      const result = await window.api.installSTTModelPreset(presetId)
      setInstallerState(result.installer)
      setSttStatus(result.status)
      setSttActionMessage(result.status.initialized ? '语音识别模型安装完成，现在可以直接录音了。' : result.status.message)
    } catch (installError) {
      const latestState = await refreshInstallerState()
      setSttActionMessage(
        latestState.error || (installError instanceof Error ? installError.message : '语音识别模型安装失败。')
      )
      await refreshSttStatus()
    } finally {
      setSttActionBusy(false)
    }
  }

  const handleLoadEarlier = async () => {
    if (loadingEarlier || !conversation?.hasEarlierMessages) return
    suppressNextAutoScrollRef.current = true
    setLoadingEarlier(true)
    try {
      await onLoadEarlier()
    } catch (loadError) {
      suppressNextAutoScrollRef.current = false
      setError(loadError instanceof Error ? loadError.message : '加载更早消息失败。')
    } finally {
      setLoadingEarlier(false)
    }
  }

  const activityLabel = isRecording
    ? sttStatus?.supportsPartialResults && partialText
      ? `正在聆听，停顿 ${Math.round(voiceCaptureSettings.silenceAfterSpeechMs / 1000)} 秒后自动发送`
      : sttStatus?.supportsPartialResults
        ? `等待你开口，${Math.round(voiceCaptureSettings.initialSilenceMs / 1000)} 秒无声音将结束对话`
        : `正在聆听（离线模型会在结束后显示文字），说完停顿 ${Math.round(voiceCaptureSettings.silenceAfterSpeechMs / 1000)} 秒后自动发送`
    : isLoading
      ? '正在理解你的话'
      : isGeneratingSpeech
        ? '正在生成语音'
        : isPlaying
          ? '正在播放回复'
          : voiceConversationActive
            ? '连续语音对话已开启'
            : ''

  return (
    <div className="flex h-full w-full flex-col bg-white">
      <div className="flex-1 overflow-y-auto px-4 py-5 sm:px-8">
        {!sttStatus?.initialized && sttStatus?.message && (
          <div className="mb-5 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-semibold text-amber-800">语音识别尚未就绪</p>
                <p className="mt-1 text-sm text-amber-700">安装语音识别模型后即可使用麦克风练习。</p>
              </div>
              <button
                onClick={handleInstallStt}
                disabled={sttActionBusy || installerState.isInstalling}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {installerState.isInstalling ? '正在安装模型...' : '一键安装模型'}
              </button>
            </div>
            {installerState.isInstalling && (
              <div className="mt-3">
                <p className="text-sm text-amber-700">{installerState.message}</p>
                <div className="mt-2 h-2 overflow-hidden rounded-full bg-amber-100">
                  <div
                    className="h-full rounded-full bg-blue-600 transition-all"
                    style={{ width: `${Math.max(0, Math.min(installerState.progress, 100))}%` }}
                  />
                </div>
              </div>
            )}
            {sttActionMessage && (
              <>
                <p className="mt-3 text-sm text-amber-700">{sttActionMessage}</p>
                {!installerState.isInstalling && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      onClick={() => window.api.openSTTDownloadPage()}
                      className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-sm text-amber-800 hover:bg-amber-100"
                    >
                      打开下载页
                    </button>
                    <button
                      onClick={onOpenSettings}
                      className="rounded-lg border border-amber-300 bg-white px-3 py-1.5 text-sm text-amber-800 hover:bg-amber-100"
                    >
                      打开设置
                    </button>
                  </div>
                )}
              </>
            )}
          </div>
        )}
        {messages.length === 0 && (
          <div className="flex h-full items-center justify-center">
            <div className="max-w-lg px-4 text-center">
              <div className="mx-auto flex h-16 w-16 items-center justify-center rounded-2xl bg-blue-50 text-blue-600">
                <svg width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M21 15a4 4 0 0 1-4 4H8l-5 3V7a4 4 0 0 1 4-4h10a4 4 0 0 1 4 4Z" />
                  <path d="M8 9h8M8 13h5" />
                </svg>
              </div>
              <p className="mt-5 text-2xl font-semibold text-slate-900">开始今天的英语练习</p>
              <p className="mt-3 leading-7 text-slate-600">
                你可以直接输入英文，或者点击麦克风开始口语练习。我会在对话中帮你改进表达、语法和用词。
              </p>
              <div className="mt-5 flex flex-wrap items-center justify-center gap-3">
                <button
                  onClick={onOpenSettings}
                  className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm font-medium text-slate-700 shadow-sm hover:bg-slate-50"
                >
                  检查模型设置
                </button>
              </div>
            </div>
          </div>
        )}
        {conversation?.hasEarlierMessages && messages.length > 0 && (
          <div className="mb-4 flex justify-center">
            <button
              type="button"
              onClick={() => void handleLoadEarlier()}
              disabled={loadingEarlier}
              className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-medium text-slate-600 shadow-sm hover:bg-slate-50 disabled:opacity-50"
            >
              {loadingEarlier ? '正在加载更早消息…' : '加载更早消息'}
            </button>
          </div>
        )}
        {messages.map((msg) => (
          <ChatBubble
            key={msg.id}
            message={msg}
            showStopPlayback={
              msg.id === activeSpeechMessageId && (isPlaying || isGeneratingSpeech)
            }
            onStopPlayback={handleStopPlayback}
            showReplay={msg.role === 'assistant' && Boolean(msg.content.trim())}
            onReplay={() => void handleReplayMessage(msg)}
            onRetry={
              msg.role === 'user' && msg.status === 'failed'
                ? () => void handleRetryMessage(msg)
                : undefined
            }
            onRetryCorrection={
              msg.role === 'user' && msg.correctionStatus === 'failed'
                ? () => void handleRetryAnalysis(msg, 'correction')
                : undefined
            }
            onRetryVocabulary={
              msg.role === 'assistant' && msg.vocabularyStatus === 'failed'
                ? () => void handleRetryAnalysis(msg, 'vocabulary')
                : undefined
            }
            analysisRetrying={
              retryingAnalysisKeys.has(`${msg.id}:correction`) ||
              retryingAnalysisKeys.has(`${msg.id}:vocabulary`)
            }
          />
        ))}
        {isLoading && (
          <div className="mb-4 flex justify-start">
            <div className="rounded-2xl rounded-bl-md border border-slate-200 bg-white px-4 py-3 text-sm text-slate-500 shadow-sm">
              正在理解你的话…
            </div>
          </div>
        )}
        {error && (
          <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="border-t border-slate-200 bg-white px-4 py-3 sm:px-6 sm:py-4">
        {(activityLabel || (isRecording && partialText)) && (
          <div className="mb-2 flex min-h-6 items-center gap-2 text-sm text-slate-500">
            <span className={`h-2 w-2 rounded-full ${isRecording ? 'animate-pulse bg-red-500' : 'bg-blue-500'}`} />
            <span className="font-medium">{activityLabel}</span>
            {isRecording && partialText && (
              <span className="min-w-0 flex-1 truncate text-slate-700">“{partialText}”</span>
            )}
          </div>
        )}
        {captureError && (
          <div className="mb-2 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">
            {captureError}
          </div>
        )}
        <div className="flex items-center gap-2 sm:gap-3">
          <RecordButton
            isRecording={isRecording}
            onStart={handleRecordingStart}
            onStop={handleRecordingStop}
            disabled={isLoading || isGeneratingSpeech}
          />
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isRecording ? '正在听写...' : '请输入英文...'}
            disabled={isLoading || isRecording}
            className="h-11 min-w-0 flex-1 rounded-xl border border-slate-300 bg-slate-50 px-4 text-sm text-slate-900 placeholder-slate-400 transition focus:border-blue-500 focus:bg-white focus:outline-none disabled:opacity-50"
          />
          <button
            onClick={() => void handleSend()}
            disabled={isLoading || !input.trim() || isRecording}
            className="h-11 rounded-xl bg-blue-600 px-4 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-40"
          >
            发送
          </button>
          {voiceConversationActive && (
            <button
              onClick={handleStopConversation}
              className="hidden h-11 rounded-xl border border-red-200 bg-red-50 px-3 text-sm font-medium text-red-700 hover:bg-red-100 sm:block"
              title="停止监听、取消待播报内容并结束连续语音对话"
            >
              结束语音对话
            </button>
          )}
          <div className="relative">
            <button
              onClick={() => setShowMoreMenu((visible) => !visible)}
              aria-label="更多对话操作"
              className="flex h-11 w-11 items-center justify-center rounded-xl border border-slate-200 bg-white text-xl text-slate-500 hover:bg-slate-50"
              title="更多操作"
            >···</button>
            {showMoreMenu && (
              <div className="absolute bottom-14 right-0 z-20 w-44 overflow-hidden rounded-xl border border-slate-200 bg-white p-1.5 shadow-xl">
                {voiceConversationActive && (
                  <button onClick={handleStopConversation} className="w-full rounded-lg px-3 py-2 text-left text-sm text-red-700 hover:bg-red-50 sm:hidden">
                    结束语音对话
                  </button>
                )}
                {messages.length > 0 && (
                  <button onClick={handleClear} className="w-full rounded-lg px-3 py-2 text-left text-sm text-red-700 hover:bg-red-50">
                    删除当前对话
                  </button>
                )}
                {!voiceConversationActive && messages.length === 0 && (
                  <p className="px-3 py-2 text-sm text-slate-400">暂无可用操作</p>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
