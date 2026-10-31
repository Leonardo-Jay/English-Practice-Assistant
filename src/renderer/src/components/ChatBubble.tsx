import { useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import type { Message } from '../../types'
import { useNormalizedAssistantMessage } from '../hooks/useNormalizedAssistantMessage'
import CorrectionCard from './CorrectionCard'
import VocabularyCard from './VocabularyCard'

interface Props {
  message: Message
  showStopPlayback?: boolean
  onStopPlayback?: () => void
  showReplay?: boolean
  onReplay?: () => void
  onRetry?: () => void
  onRetryCorrection?: () => void
  onRetryVocabulary?: () => void
  analysisRetrying?: boolean
}

function renderHighlightedContent(message: Message): ReactNode {
  if (message.role !== 'assistant' || !message.vocabulary?.length) {
    return message.content
  }

  const terms = [...new Set(message.vocabulary.map((item) => item.term.trim()).filter(Boolean))]
    .sort((left, right) => right.length - left.length)
  if (terms.length === 0) return message.content

  const escapedTerms = terms.map((term) =>
    term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  )
  const pattern = new RegExp(`(${escapedTerms.join('|')})`, 'gi')
  const termSet = new Set(terms.map((term) => term.toLowerCase()))

  return message.content.split(pattern).map((part, index) =>
    termSet.has(part.toLowerCase()) ? (
      <mark
        key={`${part}-${index}`}
        className="rounded bg-indigo-200 px-0.5 font-medium text-indigo-950"
      >
        {part}
      </mark>
    ) : (
      part
    )
  )
}

export default function ChatBubble({
  message,
  showStopPlayback = false,
  onStopPlayback,
  showReplay = false,
  onReplay,
  onRetry,
  onRetryCorrection,
  onRetryVocabulary,
  analysisRetrying = false
}: Props) {
  const displayMessage = useNormalizedAssistantMessage(message)
  const isUser = displayMessage.role === 'user'
  const hasCorrections = isUser && Boolean(message.corrections?.length)
  const hasVocabulary = !isUser && Boolean(message.vocabulary?.length)
  const correctionCompleteEmpty =
    isUser &&
    message.correctionStatus === 'complete' &&
    !message.corrections?.length
  const vocabularyCompleteEmpty =
    !isUser &&
    message.vocabularyStatus === 'complete' &&
    !message.vocabulary?.length
  const orderedCorrections = hasCorrections
    ? [...message.corrections!].sort(
        (left, right) =>
          (left.sentenceIndex ?? Number.MAX_SAFE_INTEGER) -
            (right.sentenceIndex ?? Number.MAX_SAFE_INTEGER) ||
          (left.scope === 'sentence' ? 1 : 0) -
            (right.scope === 'sentence' ? 1 : 0)
      )
    : []
  const assistantBubbleRef = useRef<HTMLDivElement>(null)
  const [assistantBubbleHeight, setAssistantBubbleHeight] = useState<number | null>(null)

  useLayoutEffect(() => {
    if (isUser || !hasVocabulary || !assistantBubbleRef.current) {
      setAssistantBubbleHeight(null)
      return
    }

    const bubble = assistantBubbleRef.current
    const syncHeight = () => setAssistantBubbleHeight(Math.ceil(bubble.getBoundingClientRect().height))
    syncHeight()
    const observer = new ResizeObserver(syncHeight)
    observer.observe(bubble)
    return () => observer.disconnect()
  }, [
    displayMessage.content,
    hasVocabulary,
    isUser,
    message.vocabulary?.length
  ])

  const timestamp = new Date(message.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit'
  })

  if (isUser) {
    return (
      <div className="mb-5 flex w-full items-start justify-end gap-3">
        {hasCorrections && (
          <aside className="max-h-44 w-[25.5rem] max-w-[42%] flex-shrink-0 overflow-y-auto rounded-xl border border-slate-200 bg-slate-50 p-2">
            <div className="mb-1.5 flex items-center justify-between px-0.5">
              <span className="text-[11px] font-semibold text-slate-600">本句纠错</span>
              <span className="text-[10px] text-slate-400">{message.corrections!.length} 项</span>
            </div>
            <div className="space-y-1.5">
              {orderedCorrections.map((correction, index) => (
                <CorrectionCard
                  key={`${correction.sentenceIndex ?? 'legacy'}-${correction.scope ?? 'span'}-${index}`}
                  correction={correction}
                />
              ))}
            </div>
          </aside>
        )}
        {correctionCompleteEmpty && (
          <span
            role="status"
            aria-label="纠错分析完成，未发现需要纠正的问题"
            title="纠错分析完成，未发现需要纠正的问题"
            className="mt-7 flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-emerald-200 bg-emerald-50 text-sm font-bold text-emerald-600"
          >
            ✓
          </span>
        )}
        <div className={`min-w-0 ${hasCorrections ? 'max-w-[54%]' : 'max-w-[70%]'}`}>
          <div className="mb-1.5 flex items-center justify-end gap-2 text-xs text-slate-400">
            <span>你</span>
            <span>{timestamp}</span>
          </div>
          <div className="whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-teal-600 px-4 py-3 text-[15px] leading-7 text-white shadow-sm">
            {displayMessage.content}
          </div>
          {message.status === 'failed' && (
            <div className="mt-1.5 flex items-center justify-end gap-2 text-xs text-red-600">
              <span>回复失败</span>
              {onRetry && (
                <button
                  onClick={onRetry}
                  className="rounded-md border border-red-200 bg-red-50 px-2 py-1 font-medium hover:bg-red-100"
                >
                  重试回复
                </button>
              )}
            </div>
          )}
          {message.correctionStatus === 'failed' && (
            <div className="mt-1 flex items-center justify-end gap-2 text-[11px] text-amber-700">
              <span>本句纠错分析暂时失败</span>
              {onRetryCorrection && (
                <button
                  type="button"
                  onClick={onRetryCorrection}
                  disabled={analysisRetrying}
                  className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 font-medium hover:bg-amber-100 disabled:opacity-50"
                >
                  {analysisRetrying ? '重试中…' : '重试分析'}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="mb-5 w-full">
      <div className="mb-1.5 flex items-center gap-2 text-xs text-slate-400">
        <span>练习助手</span>
        <span>{timestamp}</span>
      </div>
      <div className="flex w-full items-center gap-3">
        <div
          ref={assistantBubbleRef}
          className={`min-w-0 whitespace-pre-wrap break-words rounded-2xl rounded-bl-md border border-slate-200 bg-white px-4 py-3 text-[15px] leading-7 text-slate-700 shadow-sm ${
            hasVocabulary ? 'max-w-[54%]' : 'max-w-[70%]'
          }`}
        >
          {renderHighlightedContent(displayMessage)}
        </div>

        {hasVocabulary && (
          <aside
            style={assistantBubbleHeight ? { height: `${assistantBubbleHeight}px` } : undefined}
            className="w-[25.5rem] max-w-[42%] flex-shrink-0 overflow-y-auto rounded-xl border border-indigo-100 bg-indigo-50 p-2"
          >
            <div className="mb-1.5 flex items-center justify-between px-0.5">
              <span className="text-[11px] font-semibold text-indigo-700">生词与关键词</span>
              <span className="text-[10px] text-indigo-400">{message.vocabulary!.length} 项</span>
            </div>
            <div className="space-y-1.5">
              {message.vocabulary!.map((item) => (
                <VocabularyCard key={`${item.term}-${item.chineseMeaning}`} item={item} />
              ))}
            </div>
          </aside>
        )}
        {vocabularyCompleteEmpty && (
          <span
            role="status"
            aria-label="生词分析完成，没有需要展示的生词"
            title="生词分析完成，没有需要展示的生词"
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-emerald-200 bg-emerald-50 text-sm font-bold text-emerald-600"
          >
            ✓
          </span>
        )}
      </div>

      {(showStopPlayback || showReplay) && (
        <div className="mt-1.5 flex items-center gap-1.5">
          {showStopPlayback ? (
            <button
              onClick={onStopPlayback}
              aria-label="停止播放"
              title="停止播放"
              className="flex h-7 items-center gap-1 rounded-md border border-orange-200 bg-orange-50 px-2 text-[11px] font-medium text-orange-700 hover:bg-orange-100"
            >
              <svg width="10" height="10" viewBox="0 0 14 14" fill="currentColor" aria-hidden="true">
                <rect x="2" y="2" width="10" height="10" rx="1.5" />
              </svg>
              停止
            </button>
          ) : (
            <button
              onClick={onReplay}
              aria-label="重新播放这条回复"
              title="重新播放这条回复"
              className="flex h-7 items-center gap-1 rounded-md border border-slate-200 bg-white px-2 text-[11px] font-medium text-slate-500 hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true">
                <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
                <path d="M3 3v5h5" />
              </svg>
              重听
            </button>
          )}
        </div>
      )}
      {message.vocabularyStatus === 'failed' && (
        <div className="mt-1 flex items-center gap-2 text-[11px] text-amber-700">
          <span>这条回复的生词分析暂时失败，不影响正常对话</span>
          {onRetryVocabulary && (
            <button
              type="button"
              onClick={onRetryVocabulary}
              disabled={analysisRetrying}
              className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1 font-medium hover:bg-amber-100 disabled:opacity-50"
            >
              {analysisRetrying ? '重试中…' : '重试分析'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
