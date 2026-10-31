import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  SubtitleCandidate,
  SubtitleErrorCode,
  SubtitleJobProgress,
  SubtitleWorkflowRequest
} from '../../types'

interface Props {
  open: boolean
  initialRequest?: SubtitleWorkflowRequest
  resumeProgress?: SubtitleJobProgress
  onClose: () => void
}

const phaseLabels: Record<string, string> = {
  confirmed: '准备开始',
  searching: '正在搜索字幕',
  'awaiting-candidate-selection': '请选择字幕',
  verifying: '正在验证字幕网站',
  downloading: '正在下载字幕',
  extracting: '正在本地解压并选择剧集',
  processing: '正在生成本集剧情知识',
  ready: '字幕剧情知识已就绪',
  failed: '任务失败',
  cancelled: '任务已取消'
}

const subtitleErrorLabels: Partial<Record<SubtitleErrorCode, string>> = {
  'corrupt-archive': '字幕压缩包损坏或下载不完整，建议重新搜索其他候选。',
  'encrypted-archive': '这个字幕压缩包需要密码，软件无法自动处理。',
  'archive-tool-missing': '本地解压组件缺失，请重新安装完整版本。',
  'download-truncated': '字幕下载不完整，请检查网络后重试。',
  'invalid-knowledge-json': '模型返回的剧情分析不完整。已保留成功进度，可以直接重试。',
  'analysis-model-unavailable': '剧情分析模型当前受限或不可用。成功进度已保留，切换模型后可以继续。',
  'unsupported-archive': '这个压缩包格式暂不支持，请选择其他字幕。',
  'unsafe-archive': '字幕压缩包未通过本地安全检查。',
  'episode-not-found-in-pack': '字幕包中没有找到指定的剧集。',
  'download-rejected': '字幕下载地址没有返回有效字幕文件。',
  'candidate-selection-timeout': '候选字幕选择已超时。请重新搜索后再次选择。',
  'source-extension-unavailable': '此版本支持导入本地字幕，未包含在线字幕搜索。'
}

export default function SubtitleWorkflowModal({
  open,
  initialRequest,
  resumeProgress,
  onClose
}: Props) {
  const [form, setForm] = useState<SubtitleWorkflowRequest>(() =>
    initialRequest || emptyRequest()
  )
  const [jobId, setJobId] = useState<string>()
  const [progress, setProgress] = useState<SubtitleJobProgress>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [onlineSourcesAvailable, setOnlineSourcesAvailable] = useState(false)
  const speedRef = useRef<{ bytes: number; time: number } | undefined>(undefined)
  const [bytesPerSecond, setBytesPerSecond] = useState(0)

  useEffect(() => {
    if (!open) return
    let active = true
    void window.api.getSubtitleStatus().then((status) => {
      if (active) setOnlineSourcesAvailable(status.sourceProvider?.available === true)
    }).catch(() => {
      if (active) setOnlineSourcesAvailable(false)
    })
    return () => { active = false }
  }, [open])

  useEffect(() => {
    if (!initialRequest) return
    setForm(initialRequest)
    setError('')
    setProgress(undefined)
    setJobId(undefined)
  }, [initialRequest?.requestId])

  // A workflow may continue after the dialog is closed.  The compact header
  // badge reopens this component with the last progress event so candidates,
  // download state, and diagnostics are visible again instead of becoming an
  // orphaned background task.
  useEffect(() => {
    if (!open || !resumeProgress) return
    setJobId(resumeProgress.jobId)
    setProgress(resumeProgress)
    setError('')
  }, [open, resumeProgress?.jobId, resumeProgress?.updatedAt])

  useEffect(() => window.api.onSubtitleProgress((event) => {
    if (
      (jobId && event.jobId !== jobId) ||
      (!jobId && event.requestId !== form.requestId)
    ) return
    setJobId(event.jobId)
    setProgress(event)
    if (event.phase === 'downloading' && event.receivedBytes !== undefined) {
      const now = Date.now()
      const previous = speedRef.current
      if (previous && now > previous.time) {
        setBytesPerSecond(
          Math.max(0, (event.receivedBytes - previous.bytes) * 1000 / (now - previous.time))
        )
      }
      speedRef.current = { bytes: event.receivedBytes, time: now }
    }
  }), [jobId, form.requestId])

  const canSubmit = useMemo(() => {
    if (!form.title.trim()) return false
    const type =
      form.mediaType === 'auto'
        ? form.season || form.episode ? 'tv' : 'movie'
        : form.mediaType
    if (type === 'tv' && form.origin === 'chat') {
      return Boolean(form.season && form.episode)
    }
    return true
  }, [form])

  const start = async (importLocal = false) => {
    if (!canSubmit || busy) return
    setBusy(true)
    setError('')
    setProgress(undefined)
    speedRef.current = undefined
    setBytesPerSecond(0)
    const request = { ...form, requestId: crypto.randomUUID() }
    setForm(request)
    try {
      const result = importLocal
        ? await window.api.importLocalSubtitle(request)
        : await window.api.startSubtitleWorkflow(request)
      if (!result) return
      setJobId(result.jobId)
      if (result.status === 'ready') {
        setProgress({
          jobId: result.jobId || `ready-${request.requestId}`,
          requestId: request.requestId,
          conversationId: request.conversationId,
          origin: request.origin,
          phase: 'ready',
          message:
            result.entry?.status === 'package'
              ? '整季字幕包已在本地保存。'
              : '已复用本地字幕剧情知识。',
          updatedAt: Date.now()
        })
      }
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : '字幕任务启动失败。')
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null
  const type =
    form.mediaType === 'auto'
      ? form.season || form.episode ? 'tv' : 'movie'
      : form.mediaType

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-slate-950/45 p-3 backdrop-blur-[1px] sm:p-6"
      role="dialog"
      aria-modal="true"
      aria-labelledby="subtitle-workflow-title"
    >
      <div className="flex max-h-[92vh] w-full max-w-4xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-5 py-4 sm:px-6">
          <div>
            <h2 id="subtitle-workflow-title" className="text-lg font-semibold text-slate-900">
              字幕剧情知识库
            </h2>
            <p className="mt-1 text-sm text-slate-500">
              {onlineSourcesAvailable
                ? '搜索、下载和剧情总结在后台进行，不会阻塞正常对话。'
                : '导入本地字幕或复用已保存的字幕包，在后台整理剧情知识。'}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-9 w-9 items-center justify-center rounded-lg text-xl text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="关闭字幕工作流"
          >
            ×
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto p-5 sm:p-6">
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="sm:col-span-2">
              <span className="mb-1.5 block text-sm font-medium text-slate-700">影视名称</span>
              <input
                value={form.title}
                onChange={(event) => setForm({ ...form, title: event.target.value })}
                placeholder="例如 The Vampire Diaries"
                className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm outline-none focus:border-blue-500 focus:ring-2 focus:ring-blue-100"
              />
            </label>
            <label>
              <span className="mb-1.5 block text-sm font-medium text-slate-700">类型</span>
              <select
                value={form.mediaType}
                onChange={(event) => setForm({
                  ...form,
                  mediaType: event.target.value as SubtitleWorkflowRequest['mediaType']
                })}
                className="w-full rounded-xl border border-slate-300 bg-white px-3.5 py-2.5 text-sm"
              >
                <option value="auto">自动识别</option>
                <option value="movie">电影</option>
                <option value="tv">电视剧</option>
              </select>
            </label>
            <label>
              <span className="mb-1.5 block text-sm font-medium text-slate-700">年份（可选）</span>
              <input
                type="number"
                min="1880"
                max="2100"
                value={form.year || ''}
                onChange={(event) => setForm({
                  ...form,
                  year: positiveNumber(event.target.value)
                })}
                className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm"
              />
            </label>
            {(type === 'tv' || form.mediaType === 'auto') && (
              <>
                <label>
                  <span className="mb-1.5 block text-sm font-medium text-slate-700">季数</span>
                  <input
                    type="number"
                    min="1"
                    value={form.season || ''}
                    onChange={(event) => setForm({
                      ...form,
                      season: positiveNumber(event.target.value)
                    })}
                    className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm"
                  />
                </label>
                <label>
                  <span className="mb-1.5 block text-sm font-medium text-slate-700">
                    集数{form.origin === 'settings' ? '（可选）' : ''}
                  </span>
                  <input
                    type="number"
                    min="1"
                    value={form.episode || ''}
                    onChange={(event) => setForm({
                      ...form,
                      episode: positiveNumber(event.target.value)
                    })}
                    className="w-full rounded-xl border border-slate-300 px-3.5 py-2.5 text-sm"
                  />
                </label>
              </>
            )}
          </div>

          <div className="mt-5 flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={() => void start()}
              disabled={!canSubmit || busy || isActive(progress?.phase)}
              className="rounded-xl bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {busy ? '正在启动…' : onlineSourcesAvailable
                ? progress?.phase === 'failed' ? '重新搜索' : '开始搜索'
                : '使用本地知识库'}
            </button>
            <button
              type="button"
              onClick={() => void start(true)}
              disabled={!canSubmit || busy || isActive(progress?.phase)}
              className="rounded-xl border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm font-semibold text-blue-700 hover:bg-blue-100 disabled:cursor-not-allowed disabled:opacity-50"
            >
              导入本地字幕
            </button>
            {jobId && isActive(progress?.phase) && (
              <button
                type="button"
                onClick={() => void window.api.cancelSubtitleJob(jobId)}
                className="rounded-xl border border-red-200 px-4 py-2.5 text-sm font-medium text-red-600 hover:bg-red-50"
              >
                取消任务
              </button>
            )}
            <button
              type="button"
              onClick={() => void window.api.openSubtitleDirectory()}
              className="rounded-xl border border-slate-300 px-4 py-2.5 text-sm text-slate-600 hover:bg-slate-50"
            >
              打开字幕目录
            </button>
          </div>

          {(progress || error) && (
            <div className={`mt-5 rounded-2xl border p-4 ${
              progress?.phase === 'failed' || error
                ? 'border-red-200 bg-red-50'
                : progress?.phase === 'ready'
                  ? 'border-emerald-200 bg-emerald-50'
                  : 'border-blue-200 bg-blue-50'
            }`}>
              <p className="font-semibold text-slate-900">
                {error ||
                  (progress?.errorCode && subtitleErrorLabels[progress.errorCode]) ||
                  phaseLabels[progress?.phase || ''] ||
                  progress?.message}
              </p>
              {progress?.message && (
                <p className="mt-1 text-sm text-slate-600">{progress.message}</p>
              )}
              {progress?.phase === 'downloading' && (
                <>
                  <div className="mt-3 h-2 overflow-hidden rounded-full bg-blue-100">
                    <div
                      className={`h-full rounded-full bg-blue-600 transition-all ${
                        progress.percent === undefined ? 'w-1/3 animate-pulse' : ''
                      }`}
                      style={
                        progress.percent === undefined
                          ? undefined
                          : { width: `${Math.max(0, Math.min(100, progress.percent))}%` }
                      }
                    />
                  </div>
                  <p className="mt-2 text-xs text-slate-500">
                    {formatBytes(progress.receivedBytes || 0)}
                    {progress.totalBytes ? ` / ${formatBytes(progress.totalBytes)}` : ''}
                    {bytesPerSecond > 0 ? ` · ${formatBytes(bytesPerSecond)}/s` : ''}
                    {progress.percent !== undefined ? ` · ${progress.percent}%` : ''}
                  </p>
                </>
              )}
              {progress?.diagnostic && (
                <details className="mt-3 text-xs text-red-700">
                  <summary className="cursor-pointer font-medium">查看诊断</summary>
                  <p className="mt-1 break-words">{progress.diagnostic}</p>
                </details>
              )}
            </div>
          )}

          {progress?.phase === 'awaiting-candidate-selection' && (
            <CandidateList
              candidates={progress.candidates || []}
              onSelect={(candidateId) => {
                if (jobId) void window.api.selectSubtitleCandidate(jobId, candidateId)
              }}
            />
          )}
        </div>
      </div>
    </div>
  )
}

function CandidateList({
  candidates,
  onSelect
}: {
  candidates: SubtitleCandidate[]
  onSelect: (candidateId: string) => void
}) {
  return (
    <div className="mt-5">
      <h3 className="text-sm font-semibold text-slate-900">选择匹配字幕</h3>
      <div className="mt-3 grid gap-3 md:grid-cols-2">
        {candidates.map((candidate, index) => (
          <button
            type="button"
            key={candidate.id}
            onClick={() => onSelect(candidate.id)}
            className="rounded-xl border border-slate-200 bg-white p-4 text-left shadow-sm hover:border-blue-400 hover:bg-blue-50"
          >
            <p className="text-sm font-semibold text-slate-900">
              {index + 1}. {candidate.title}
            </p>
            <p className="mt-2 text-xs text-slate-500">
              {candidate.source} · {languageLabel(candidate.language)} · {candidate.format || '未知格式'}
              {' · '}{packTypeLabel(candidate.packType)} · 匹配 {candidate.score}
            </p>
            {candidate.scoreReasons.length > 0 && (
              <p className="mt-2 text-xs leading-5 text-slate-500">
                {candidate.scoreReasons.join('；')}
              </p>
            )}
          </button>
        ))}
      </div>
    </div>
  )
}

const emptyRequest = (): SubtitleWorkflowRequest => ({
  requestId: crypto.randomUUID(),
  origin: 'settings',
  mediaType: 'auto',
  title: ''
})

const positiveNumber = (value: string) => {
  const number = Number(value)
  return Number.isInteger(number) && number > 0 ? number : undefined
}

const isActive = (phase?: string) =>
  [
    'searching',
    'verifying',
    'downloading',
    'extracting',
    'processing',
    'awaiting-candidate-selection'
  ].includes(phase || '')

const formatBytes = (value: number) =>
  value >= 1024 * 1024
    ? `${(value / 1024 / 1024).toFixed(1)} MB`
    : `${Math.max(0, value / 1024).toFixed(0)} KB`

const languageLabel = (language?: string) =>
  ({ bilingual: '双语', english: '英文', chinese: '中文', unknown: '语言未知' }[
    language || 'unknown'
  ] || language)

const packTypeLabel = (packType?: string) =>
  ({ episode: '单集', season: '整季', series: '全剧', movie: '电影', unknown: '范围未知' }[
    packType || 'unknown'
  ] || packType)
