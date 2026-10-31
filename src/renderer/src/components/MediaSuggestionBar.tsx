import type { MediaMentionSuggestion } from '../../types'

interface Props {
  suggestion: MediaMentionSuggestion
  onAccept: () => void
  onDismiss: () => void
}

export default function MediaSuggestionBar({
  suggestion,
  onAccept,
  onDismiss
}: Props) {
  const action =
    suggestion.availability === 'ready'
      ? '使用本地剧情知识'
      : suggestion.availability === 'package'
        ? '从本地生成本集知识'
        : '准备字幕剧情'
  const scope =
    suggestion.media.type === 'tv'
      ? [
          suggestion.season ? `第 ${suggestion.season} 季` : '',
          suggestion.episode ? `第 ${suggestion.episode} 集` : ''
        ].filter(Boolean).join(' · ')
      : suggestion.media.year ? String(suggestion.media.year) : ''

  return (
    <div className="shrink-0 border-b border-blue-100 bg-blue-50 px-4 py-3 sm:px-6">
      <div className="mx-auto flex max-w-5xl flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900">
            检测到你提到了《{suggestion.media.title}》
          </p>
          <p className="mt-0.5 text-xs text-slate-500">
            {scope || '可以准备本地字幕剧情知识，不会影响当前对话回复。'}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={onAccept}
            className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700"
          >
            {action}
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-lg border border-blue-200 bg-white px-3 py-2 text-sm text-slate-600 hover:bg-blue-100"
          >
            暂不使用
          </button>
        </div>
      </div>
    </div>
  )
}
