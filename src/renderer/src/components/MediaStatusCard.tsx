import type { ReactNode } from 'react'
import type {
  ConversationMediaContext,
  SubtitleErrorCode,
  SubtitleJobProgress
} from '../../types'

interface Props {
  context?: ConversationMediaContext
  progress?: SubtitleJobProgress
  onCancel: () => void
  onClear: () => void
  onOpenDirectory: () => void
  onSelectCandidate: (candidateId: string) => void
  onRetry: () => void
  onContinueWithout: () => void
}

const phaseLabels: Record<string, string> = {
  'candidate-detected': '已识别影视作品',
  'awaiting-title-confirmation': '等待确认作品',
  'awaiting-season-episode': '等待确认季和集',
  confirmed: '已确认剧情范围',
  searching: '正在搜索字幕',
  'awaiting-candidate-selection': '等待选择字幕',
  verifying: '正在自动验证字幕网站',
  downloading: '正在下载字幕',
  extracting: '正在本地解压',
  processing: '正在整理对白和剧情知识',
  ready: '字幕剧情知识已就绪',
  failed: '字幕准备失败',
  cancelled: '字幕任务已取消'
}

const subtitleErrorLabels: Partial<Record<SubtitleErrorCode, string>> = {
  'corrupt-archive': '字幕压缩包损坏，请重新搜索其他候选。',
  'encrypted-archive': '字幕压缩包需要密码。',
  'archive-tool-missing': '本地解压组件缺失。',
  'download-truncated': '字幕下载不完整。',
  'invalid-knowledge-json': '剧情分析输出不完整，成功进度已保留。',
  'analysis-model-unavailable': '剧情分析模型当前不可用，成功进度已保留。',
  'unsupported-archive': '字幕压缩格式暂不支持。',
  'unsafe-archive': '字幕压缩包未通过安全检查。'
}

export default function MediaStatusCard({
  context,
  progress,
  onCancel,
  onClear,
  onOpenDirectory,
  onSelectCandidate,
  onRetry,
  onContinueWithout
}: Props) {
  if (!context?.media && !progress) return null
  const phase = progress?.phase || context?.phase || 'idle'
  const media = context?.media
  const title = media?.title || '影视剧情资料'
  const scope =
    media?.type === 'tv' && context?.season && context?.episode
      ? ` · S${String(context.season).padStart(2, '0')}E${String(context.episode).padStart(2, '0')}`
      : media?.year ? ` · ${media.year}` : ''
  const active = ['searching', 'verifying', 'downloading', 'extracting', 'processing'].includes(phase)
  const candidates = progress?.candidates || []
  const awaitingSelection = phase === 'awaiting-candidate-selection'

  return (
    <>
      <section className="mb-4 rounded-2xl border border-indigo-200 bg-indigo-50/70 px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold text-slate-900">
              {title}{scope}
            </p>
            <p className="mt-1 text-xs text-indigo-700">
              {(progress?.errorCode && subtitleErrorLabels[progress.errorCode]) ||
                phaseLabels[phase] ||
                progress?.message ||
                phase}
              {progress?.source ? ` · ${progress.source}` : ''}
            </p>
          </div>
          <div className="flex flex-wrap items-center justify-end gap-2">
            {(phase === 'failed' || (awaitingSelection && candidates.length === 0)) && (
              <button
                type="button"
                onClick={onRetry}
                className="rounded-lg bg-indigo-600 px-2.5 py-1.5 text-xs font-medium text-white hover:bg-indigo-700"
              >
                重新搜索
              </button>
            )}
            {phase === 'failed' && (
              <button
                type="button"
                onClick={onContinueWithout}
                className="rounded-lg border border-indigo-200 bg-white px-2.5 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100"
              >
                不使用字幕继续
              </button>
            )}
            {active && (
              <button
                type="button"
                onClick={onCancel}
                className="rounded-lg border border-indigo-200 bg-white px-2.5 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100"
              >
                取消
              </button>
            )}
            <button
              type="button"
              onClick={onOpenDirectory}
              className="rounded-lg border border-indigo-200 bg-white px-2.5 py-1.5 text-xs font-medium text-indigo-700 hover:bg-indigo-100"
            >
              打开目录
            </button>
            <button
              type="button"
              onClick={onClear}
              className="rounded-lg px-2.5 py-1.5 text-xs font-medium text-slate-500 hover:bg-white"
            >
              清除
            </button>
          </div>
        </div>
        {progress?.phase === 'downloading' && (
          <div className="mt-3">
            <div className="h-1.5 overflow-hidden rounded-full bg-indigo-100">
              <div
                className={`h-full rounded-full bg-indigo-600 transition-all ${
                  progress.percent === undefined ? 'w-1/3 animate-pulse' : ''
                }`}
                style={
                  progress.percent === undefined
                    ? undefined
                    : { width: `${Math.max(0, Math.min(100, progress.percent))}%` }
                }
              />
            </div>
            <p className="mt-1 text-right text-[11px] text-indigo-600">
              {progress.percent === undefined
                ? `${formatBytes(progress.receivedBytes || 0)} 已下载`
                : `${progress.percent}%`}
            </p>
          </div>
        )}
        {awaitingSelection && candidates.length > 0 && (
          <p className="mt-2 text-xs text-indigo-700">
            已找到 {candidates.length} 个候选，请在弹窗中选择要使用的字幕。
          </p>
        )}
        {(progress?.diagnostic || context?.errorMessage) && (
          <details className="mt-2 text-xs text-red-700">
            <summary className="cursor-pointer font-medium">查看诊断</summary>
            <p className="mt-1 break-words">{progress?.diagnostic || context?.errorMessage}</p>
          </details>
        )}
      </section>

      {awaitingSelection && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/45 p-3 backdrop-blur-[1px] sm:p-6"
          role="dialog"
          aria-modal="true"
          aria-labelledby="subtitle-candidate-title"
        >
          <div className="flex max-h-[88vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
            <div className="border-b border-slate-200 px-5 py-4 sm:px-6">
              <div className="flex items-start justify-between gap-4">
                <div className="min-w-0">
                  <h2 id="subtitle-candidate-title" className="text-lg font-semibold text-slate-900">
                    请选择要使用的字幕
                  </h2>
                  <p className="mt-1 truncate text-sm text-slate-600">
                    {title}{scope}
                  </p>
                </div>
                <span className="shrink-0 rounded-full bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700">
                  {candidates.length} 个候选
                </span>
              </div>
              <p className="mt-3 text-sm leading-6 text-slate-500">
                优先选择季、集数完全一致且包含英文或双语对白的字幕。点击候选后会立即开始下载。
              </p>
            </div>

            <div className="min-h-0 flex-1 overflow-y-auto bg-slate-50/70 p-4 sm:p-5">
              {candidates.length > 0 ? (
                <div className="grid gap-3 md:grid-cols-2">
                  {candidates.map((candidate, index) => (
                    <button
                      type="button"
                      key={candidate.id}
                      onClick={() => onSelectCandidate(candidate.id)}
                      className="group rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm transition hover:border-indigo-400 hover:bg-indigo-50/40 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-indigo-500"
                    >
                      <div className="flex items-start gap-3">
                        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-indigo-50 text-xs font-semibold text-indigo-700 group-hover:bg-indigo-600 group-hover:text-white">
                          {index + 1}
                        </span>
                        <div className="min-w-0 flex-1">
                          <p className="line-clamp-2 text-sm font-semibold leading-5 text-slate-900">
                            {candidate.title}
                          </p>
                          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
                            <CandidateTag>{sourceLabel(candidate.source)}</CandidateTag>
                            <CandidateTag>{languageLabel(candidate.language)}</CandidateTag>
                            <CandidateTag>{candidate.format || '未知格式'}</CandidateTag>
                            <CandidateTag>{packTypeLabel(candidate.packType)}</CandidateTag>
                            {candidate.season !== undefined && (
                              <CandidateTag>S{String(candidate.season).padStart(2, '0')}</CandidateTag>
                            )}
                            {candidate.episode !== undefined && (
                              <CandidateTag>E{String(candidate.episode).padStart(2, '0')}</CandidateTag>
                            )}
                            {candidate.fileSize && <CandidateTag>{candidate.fileSize}</CandidateTag>}
                          </div>
                          <p className="mt-2 text-xs font-medium text-indigo-700">
                            匹配分数：{candidate.score}
                          </p>
                          {candidate.scoreReasons.length > 0 && (
                            <p className="mt-1 line-clamp-2 text-xs leading-5 text-slate-500">
                              {candidate.scoreReasons.join('；')}
                            </p>
                          )}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-6 text-center">
                  <p className="font-medium text-amber-900">候选列表已经失效</p>
                  <p className="mt-2 text-sm leading-6 text-amber-700">
                    这通常发生在开发热重载或软件重启后。重新搜索会恢复候选列表，不会发送新的聊天消息。
                  </p>
                  <button
                    type="button"
                    onClick={onRetry}
                    className="mt-4 rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700"
                  >
                    重新搜索字幕
                  </button>
                </div>
              )}
            </div>

            <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-200 bg-white px-5 py-3 sm:px-6">
              <button
                type="button"
                onClick={onOpenDirectory}
                className="text-sm font-medium text-slate-500 hover:text-slate-800"
              >
                打开字幕目录
              </button>
              <div className="flex flex-wrap justify-end gap-2">
                <button
                  type="button"
                  onClick={onContinueWithout}
                  className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
                >
                  暂不使用字幕
                </button>
                <button
                  type="button"
                  onClick={onClear}
                  className="rounded-lg border border-red-200 bg-white px-3 py-2 text-sm font-medium text-red-600 hover:bg-red-50"
                >
                  清除本次剧情范围
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}

function CandidateTag({ children }: { children: ReactNode }) {
  return (
    <span className="rounded-md bg-slate-100 px-2 py-1 font-medium text-slate-600">
      {children}
    </span>
  )
}

const sourceLabel = (source: string) =>
  source === 'subhd' ? 'SubHD' : source === 'zimuwang' ? '字幕网' : source

const languageLabel = (language?: string) => {
  const labels: Record<string, string> = {
    bilingual: '双语',
    english: '英文',
    chinese: '中文',
    unknown: '语言未知'
  }
  return labels[language || 'unknown'] || language || '语言未知'
}

const packTypeLabel = (packType?: string) => {
  const labels: Record<string, string> = {
    episode: '单集',
    season: '整季',
    series: '全剧',
    movie: '电影',
    unknown: '范围未知'
  }
  return labels[packType || 'unknown'] || packType || '范围未知'
}

const formatBytes = (value: number) =>
  value >= 1024 * 1024
    ? `${(value / 1024 / 1024).toFixed(1)} MB`
    : `${Math.round(value / 1024)} KB`
