import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type {
  ConversationSummary,
  LearningReviewData,
  ReviewAnswerEvaluation,
  ReviewAnswerInputMode,
  ReviewDashboard,
  ReviewGrade,
  ReviewItem,
  ReviewItemKind,
  ReviewLibraryFilter
} from '../../types'
import { useAudioPlayback } from '../hooks/useAudioPlayback'
import { useAudioCapture } from '../hooks/useAudioCapture'

interface Props {
  conversations: ConversationSummary[]
  initialConversationId?: string
}

type Tab = 'today' | 'session' | 'library'

const KIND_LABEL: Record<ReviewItemKind, string> = {
  vocabulary: '生词与搭配',
  correction: '重点纠错',
  expression: '自然表达'
}

function PlayButton({ text, onPlay }: { text: string; onPlay: (text: string) => void }) {
  return (
    <button
      type="button"
      onClick={() => onPlay(text)}
      className="shrink-0 rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs text-slate-600 transition hover:border-blue-200 hover:bg-blue-50 hover:text-blue-700"
      aria-label="播放英语原句"
      title="播放英语原句"
    >
      ▶ 播放
    </button>
  )
}

function KindPill({ kind }: { kind: ReviewItemKind }) {
  const color = kind === 'vocabulary'
    ? 'bg-indigo-50 text-indigo-700'
    : kind === 'correction' ? 'bg-amber-50 text-amber-700' : 'bg-emerald-50 text-emerald-700'
  return <span className={`rounded-full px-2 py-1 text-[11px] font-semibold ${color}`}>{KIND_LABEL[kind]}</span>
}

function DashboardStat({ label, value, accent = 'text-slate-900' }: { label: string; value: number; accent?: string }) {
  return (
    <div className="rounded-xl bg-slate-50 px-3 py-2.5">
      <p className="text-[11px] font-medium text-slate-500">{label}</p>
      <p className={`mt-1 text-xl font-bold tabular-nums ${accent}`}>{value}</p>
    </div>
  )
}

export default function LearningReviewPage({ conversations, initialConversationId }: Props) {
  const [tab, setTab] = useState<Tab>('today')
  const [selectedId, setSelectedId] = useState(initialConversationId || conversations[0]?.id || '')
  const [data, setData] = useState<LearningReviewData | null>(null)
  const [dashboard, setDashboard] = useState<ReviewDashboard | null>(null)
  const [library, setLibrary] = useState<ReviewItem[]>([])
  const [libraryFilter, setLibraryFilter] = useState<ReviewLibraryFilter>({ kind: 'all', status: 'all' })
  const [loading, setLoading] = useState(false)
  const [generating, setGenerating] = useState(false)
  const [answerText, setAnswerText] = useState('')
  const [answerMode, setAnswerMode] = useState<ReviewAnswerInputMode>('text')
  const [evaluation, setEvaluation] = useState<ReviewAnswerEvaluation | null>(null)
  const [evaluating, setEvaluating] = useState(false)
  const [showReference, setShowReference] = useState(false)
  const [roundCompleted, setRoundCompleted] = useState(0)
  const [roundGoal, setRoundGoal] = useState(0)
  const [error, setError] = useState('')
  const handledSpeechEndRef = useRef(0)
  const recordingStopInProgressRef = useRef(false)
  const { play, stop, speakWithSystemVoice } = useAudioPlayback()
  const {
    isRecording,
    partialText,
    speechEndSequence,
    error: captureError,
    start: startRecording,
    stop: stopRecording,
    cancel: cancelRecording
  } = useAudioCapture({
    initialSilenceMs: 60_000,
    silenceAfterSpeechMs: 2_500,
    speechRmsThreshold: 0.012
  })

  const playText = useCallback(async (text: string) => {
    stop()
    try {
      await play(await window.api.synthesizeTTS(text))
    } catch {
      await speakWithSystemVoice(text)
    }
  }, [play, speakWithSystemVoice, stop])

  const loadDashboard = useCallback(async (beginRound = false) => {
    const next = await window.api.getReviewDashboard(20)
    setDashboard(next)
    setAnswerText('')
    setAnswerMode('text')
    setEvaluation(null)
    setShowReference(false)
    if (beginRound) {
      setRoundCompleted(0)
      setRoundGoal(next.items.length)
    }
  }, [])

  const loadLibrary = useCallback(async () => {
    setLibrary(await window.api.listReviewLibrary({ ...libraryFilter, limit: 150 }))
  }, [libraryFilter])

  useEffect(() => {
    void loadDashboard(true).catch((reason) => setError(reason instanceof Error ? reason.message : '加载今日复习失败。'))
  }, [loadDashboard])

  useEffect(() => {
    if (tab !== 'library') return
    void loadLibrary().catch((reason) => setError(reason instanceof Error ? reason.message : '加载学习资料库失败。'))
  }, [tab, loadLibrary])

  useEffect(() => {
    if (!selectedId && conversations[0]?.id) setSelectedId(conversations[0].id)
  }, [conversations, selectedId])

  useEffect(() => {
    if (tab !== 'session' || !selectedId) return
    let cancelled = false
    setLoading(true)
    setError('')
    void window.api.getReview(selectedId)
      .then((next) => { if (!cancelled) setData(next) })
      .catch((reason) => { if (!cancelled) setError(reason instanceof Error ? reason.message : '加载会话复盘失败。') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [selectedId, tab])

  const currentItem = roundCompleted < roundGoal ? dashboard?.items[0] : undefined
  const roundProgress = roundGoal > 0 ? Math.min(100, Math.round(roundCompleted / roundGoal * 100)) : 100
  const sessionVocabulary = useMemo(() => {
    const seen = new Set<string>()
    return (data?.conversation.messages.flatMap((message) => (message.vocabulary || []).map((item) => ({ ...item, messageId: message.id }))) || [])
      .filter((item) => {
        const key = (item.normalizedTerm || item.term).trim().toLocaleLowerCase('en-US')
        if (!key || seen.has(key)) return false
        seen.add(key)
        return true
      })
  }, [data])

  const finishCard = async (value: ReviewGrade) => {
    if (!currentItem || !evaluation || !answerText.trim()) return
    setError('')
    try {
      await window.api.gradeReviewItem(currentItem.id, value, {
        response: answerText.trim(),
        inputMode: answerMode,
        evaluation
      })
      setRoundCompleted((count) => count + 1)
      await loadDashboard()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '保存复习结果失败。')
    }
  }

  const submitAnswer = async () => {
    if (!currentItem || !answerText.trim() || evaluating) return
    setEvaluating(true)
    setError('')
    try {
      setEvaluation(await window.api.evaluateReviewAnswer(currentItem.id, answerText.trim()))
      setShowReference(false)
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '答案评估失败，请稍后重试。')
    } finally {
      setEvaluating(false)
    }
  }

  const finishRecording = useCallback(async () => {
    if (recordingStopInProgressRef.current) return
    recordingStopInProgressRef.current = true
    try {
      const result = await stopRecording()
      const recognized = result.trim() || partialText.trim()
      if (recognized) {
        setAnswerText(recognized)
        setAnswerMode('voice')
        setEvaluation(null)
        setShowReference(false)
      }
    } finally {
      recordingStopInProgressRef.current = false
    }
  }, [partialText, stopRecording])

  const beginRecording = useCallback(async () => {
    // speechEndSequence is cumulative. Mark every signal that existed before
    // this session as handled, otherwise the second recording would consume
    // the previous session's silence event and stop immediately.
    handledSpeechEndRef.current = speechEndSequence
    setAnswerMode('voice')
    setEvaluation(null)
    setShowReference(false)
    await startRecording()
  }, [speechEndSequence, startRecording])

  useEffect(() => {
    if (
      speechEndSequence === 0 ||
      speechEndSequence === handledSpeechEndRef.current ||
      !isRecording ||
      recordingStopInProgressRef.current
    ) return
    handledSpeechEndRef.current = speechEndSequence
    void finishRecording()
  }, [finishRecording, isRecording, speechEndSequence])

  const generate = async () => {
    if (!selectedId || generating) return
    setGenerating(true)
    setError('')
    try {
      await window.api.generateReview(selectedId, Boolean(data?.review))
      setData(await window.api.getReview(selectedId))
      await loadDashboard()
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '生成复习报告失败。')
    } finally {
      setGenerating(false)
    }
  }

  const setMastered = async (item: ReviewItem, mastered: boolean) => {
    await window.api.setReviewItemMastered(item.id, mastered)
    await Promise.all([loadLibrary(), loadDashboard()])
  }

  const masterCurrent = async () => {
    if (!currentItem) return
    await window.api.setReviewItemMastered(currentItem.id, true)
    setRoundCompleted((count) => count + 1)
    await loadDashboard()
  }

  const skipCurrent = () => {
    if (isRecording) void cancelRecording()
    setDashboard((current) => current && current.items.length > 1
      ? { ...current, items: [...current.items.slice(1), current.items[0]] }
      : current)
    setAnswerText('')
    setEvaluation(null)
    setShowReference(false)
  }

  const startNextRound = () => {
    if (!dashboard) return
    setRoundCompleted(0)
    setRoundGoal(dashboard.items.length)
    setAnswerText('')
    setEvaluation(null)
    setShowReference(false)
  }

  const deleteItem = async (item: ReviewItem) => {
    if (!window.confirm(`删除“${item.answer}”这张复习卡吗？删除后不会再自动出现。`)) return
    await window.api.deleteReviewItem(item.id)
    await Promise.all([loadLibrary(), loadDashboard()])
  }

  if (conversations.length === 0) {
    return (
      <div className="flex h-full items-center justify-center bg-slate-50 p-8 text-center">
        <div className="max-w-sm rounded-2xl border border-slate-200 bg-white p-7 shadow-sm">
          <p className="text-lg font-semibold text-slate-800">还没有可复习的内容</p>
          <p className="mt-2 text-sm leading-6 text-slate-500">完成一次英语对话后，生词、纠错和自然表达会自动进入学习收集箱。</p>
        </div>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto bg-slate-50">
      <main className="mx-auto min-h-full max-w-6xl p-4 sm:p-6">
        <header className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.16em] text-blue-600">Learning loop</p>
              <h1 className="mt-1 text-xl font-bold text-slate-900">学习复习</h1>
              <p className="mt-1 text-sm text-slate-500">从真实对话中提取内容，在合适的时间再次练习。</p>
            </div>
            <div className="flex rounded-xl bg-slate-100 p-1" role="tablist" aria-label="复习页面">
              {([
                ['today', '今日复习'], ['session', '会话复盘'], ['library', '资料库']
              ] as Array<[Tab, string]>).map(([value, label]) => (
                <button key={value} type="button" role="tab" aria-selected={tab === value}
                  onClick={() => setTab(value)}
                  className={`rounded-lg px-3 py-2 text-sm font-medium transition ${tab === value ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
                >{label}</button>
              ))}
            </div>
          </div>
          {error && <p className="mt-4 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700">{error}</p>}
        </header>

        {tab === 'today' && (
          <section className="mt-4">
            <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-6">
              <DashboardStat label="今日待复习" value={dashboard?.dueCount || 0} accent="text-blue-700" />
              <DashboardStat label="新内容" value={dashboard?.newCount || 0} accent="text-indigo-700" />
              <DashboardStat label="今日完成" value={dashboard?.reviewedToday || 0} accent="text-emerald-700" />
              <DashboardStat label="连续学习" value={dashboard?.streakDays || 0} accent="text-amber-700" />
              <DashboardStat label="已掌握" value={dashboard?.masteredCount || 0} accent="text-emerald-700" />
              <DashboardStat label="预计分钟" value={dashboard?.estimatedMinutes || 0} />
            </div>
            <article className="mt-4 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
              <div className="border-b border-slate-100 bg-gradient-to-r from-blue-50 via-indigo-50 to-violet-50 px-5 py-3 sm:px-7">
                <div className="flex items-center justify-between gap-3 text-xs">
                  <span className="font-semibold text-blue-800">本轮轻量复习</span>
                  <span className="tabular-nums text-slate-500">{Math.min(roundCompleted, roundGoal)} / {roundGoal}</span>
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-white/80">
                  <div className="h-full rounded-full bg-gradient-to-r from-blue-500 to-violet-500 transition-all duration-300" style={{ width: `${roundProgress}%` }} />
                </div>
              </div>
              {currentItem ? (
                <div className="p-5 sm:p-7">
                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <KindPill kind={currentItem.kind} />
                    <span className="text-xs text-slate-400">本轮第 {roundCompleted + 1} / {roundGoal} 张 · 一次只练一个重点</span>
                  </div>
                  <div className="mt-5 rounded-2xl border border-slate-100 bg-slate-50/80 p-4 sm:p-5">
                    <p className="max-h-96 overflow-y-auto whitespace-pre-line pr-2 text-base font-medium leading-8 text-slate-800 [scrollbar-gutter:stable]">{currentItem.prompt}</p>
                  </div>
                  <div className="mt-5 rounded-xl border border-blue-100 bg-blue-50/40 p-4 sm:p-5">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div><p className="text-sm font-semibold text-slate-800">提交你的真实答案</p><p className="mt-1 text-xs text-slate-500">可以打字，也可以直接说。提交前不会显示参考答案。</p></div>
                      <span className={`rounded-full px-2 py-1 text-[11px] font-semibold ${answerMode === 'voice' ? 'bg-rose-100 text-rose-700' : 'bg-white text-slate-500'}`}>{answerMode === 'voice' ? '语音作答' : '文字作答'}</span>
                    </div>
                    <textarea
                      value={answerText}
                      onChange={(event) => {
                        setAnswerText(event.target.value)
                        setAnswerMode('text')
                        setEvaluation(null)
                        setShowReference(false)
                      }}
                      disabled={isRecording || evaluating}
                      rows={currentItem.kind === 'vocabulary' ? 2 : 3}
                      placeholder={currentItem.kind === 'vocabulary' ? '输入对应的英语词或短语…' : '写出完整英语回答，不要只改一个片段…'}
                      className="mt-4 w-full resize-y rounded-xl border border-blue-200 bg-white px-3 py-2.5 text-sm leading-6 text-slate-800 outline-none transition placeholder:text-slate-400 focus:border-blue-400 focus:ring-2 focus:ring-blue-100 disabled:bg-slate-50"
                    />
                    {isRecording && <div className="mt-2 flex items-center gap-2 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700"><span className="h-2 w-2 animate-pulse rounded-full bg-rose-500" />正在听你作答…{partialText ? ` ${partialText}` : ''}</div>}
                    {captureError && <p className="mt-2 text-xs text-rose-600">{captureError}</p>}
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button type="button" onClick={() => isRecording ? void finishRecording() : void beginRecording()} disabled={evaluating} className={`rounded-lg border px-3 py-2 text-sm font-semibold ${isRecording ? 'border-rose-200 bg-rose-50 text-rose-700' : 'border-blue-200 bg-white text-blue-700 hover:bg-blue-50'}`}>{isRecording ? '■ 停止并转写' : '● 语音作答'}</button>
                      <button type="button" onClick={() => void submitAnswer()} disabled={!answerText.trim() || isRecording || evaluating} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-45">{evaluating ? '正在评估…' : evaluation ? '重新评估' : '提交答案'}</button>
                      {dashboard && dashboard.items.length > 1 && <button type="button" onClick={skipCurrent} disabled={isRecording || evaluating} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-500 hover:bg-slate-50 disabled:opacity-50">换一张，稍后再做</button>}
                    </div>
                  </div>

                  {evaluation && (
                    <div className={`mt-4 rounded-xl border p-4 ${evaluation.level === 'strong' ? 'border-emerald-200 bg-emerald-50' : evaluation.level === 'close' ? 'border-amber-200 bg-amber-50' : 'border-rose-200 bg-rose-50'}`}>
                      <div className="flex items-center justify-between gap-3"><div><p className={`text-xs font-semibold ${evaluation.level === 'strong' ? 'text-emerald-700' : evaluation.level === 'close' ? 'text-amber-700' : 'text-rose-700'}`}>{evaluation.level === 'strong' ? '表达清楚' : evaluation.level === 'close' ? '意思接近' : '建议再试一次'}</p><p className="mt-1 text-sm leading-6 text-slate-700">{evaluation.feedback}</p></div><div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-white text-lg font-bold text-slate-800 shadow-sm">{evaluation.score}</div></div>
                      {(evaluation.strengths.length > 0 || evaluation.improvements.length > 0) && <div className="mt-3 grid gap-2 sm:grid-cols-2">{evaluation.strengths.length > 0 && <div className="rounded-lg bg-white/70 px-3 py-2"><p className="text-[11px] font-semibold text-emerald-700">做到了</p>{evaluation.strengths.map((item) => <p key={item} className="mt-1 text-xs leading-5 text-slate-600">• {item}</p>)}</div>}{evaluation.improvements.length > 0 && <div className="rounded-lg bg-white/70 px-3 py-2"><p className="text-[11px] font-semibold text-amber-700">下一步</p>{evaluation.improvements.map((item) => <p key={item} className="mt-1 text-xs leading-5 text-slate-600">• {item}</p>)}</div>}</div>}
                      <div className="mt-4 flex flex-wrap gap-2">
                        {evaluation.level === 'strong' && <><button type="button" onClick={() => void finishCard('good')} className="rounded-lg bg-emerald-600 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-700">完成，进入下一张</button><button type="button" onClick={() => void finishCard('easy')} className="rounded-lg border border-emerald-200 bg-white px-3 py-2 text-sm font-medium text-emerald-700">很轻松，延长间隔</button></>}
                        {evaluation.level === 'close' && <><button type="button" onClick={() => { setEvaluation(null); setShowReference(false); setAnswerText('') }} className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700">根据建议再答一次</button><button type="button" onClick={() => void finishCard('hard')} className="rounded-lg border border-amber-200 bg-white px-3 py-2 text-sm font-medium text-amber-700">记录本次表现并继续</button></>}
                        {evaluation.level === 'retry' && <button type="button" onClick={() => { setEvaluation(null); setShowReference(false); setAnswerText('') }} className="rounded-lg bg-rose-600 px-4 py-2 text-sm font-semibold text-white hover:bg-rose-700">清空并重新作答</button>}
                        <button type="button" onClick={() => setShowReference(true)} className="rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-600 hover:bg-slate-50">对照参考表达</button>
                      </div>
                    </div>
                  )}

                  {showReference && evaluation && (
                    <div className="mt-4 rounded-xl border border-emerald-100 bg-emerald-50 p-4">
                      <div className="flex items-start justify-between gap-3">
                        <div><p className="text-xs font-semibold text-emerald-700">一种参考表达</p><p className="mt-1 text-lg font-semibold text-emerald-950">{currentItem.answer}</p></div>
                        <PlayButton text={currentItem.answer} onPlay={playText} />
                      </div>
                      {currentItem.meaning && <p className="mt-3 border-t border-emerald-100 pt-3 text-sm text-slate-700">中文：{currentItem.meaning}</p>}
                      {currentItem.explanation && <div className="mt-3 rounded-lg bg-white/80 px-3 py-2"><p className="text-[11px] font-semibold text-emerald-700">为什么这样说</p><p className="mt-1 whitespace-pre-line text-sm leading-6 text-slate-600">{currentItem.explanation}</p></div>}
                      {currentItem.sourceSentence && <p className="mt-3 text-xs leading-5 text-slate-500">原始表达：{currentItem.sourceSentence}</p>}
                      {evaluation.level === 'retry' && <div className="mt-4 flex flex-wrap gap-2"><button type="button" onClick={() => { setEvaluation(null); setShowReference(false); setAnswerText('') }} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">关掉答案，再独立答一次</button><button type="button" onClick={() => void finishCard('again')} className="rounded-lg border border-rose-200 bg-white px-3 py-2 text-sm font-medium text-rose-700">这次确实不会，加入近期复习</button></div>}
                      {evaluation.level === 'strong' && <div className="mt-3 flex justify-center"><button type="button" onClick={() => void masterCurrent()} className="text-xs text-slate-500 underline decoration-slate-300 underline-offset-4 hover:text-emerald-700">这项已经很熟，移入已掌握</button></div>}
                    </div>
                  )}
                </div>
              ) : (
                <div className="p-10 text-center"><div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-100 text-xl text-emerald-700">✓</div><p className="mt-3 text-lg font-semibold text-slate-800">{roundGoal > 0 ? '这一轮完成了' : '今天没有到期卡片'}</p><p className="mt-2 text-sm text-slate-500">{dashboard?.items.length ? `还有 ${dashboard.dueCount} 项待复习，可以休息一下或再来一轮。` : '新的学习内容会在合适的时间自动出现。'}</p><div className="mt-4 flex flex-wrap justify-center gap-2">{dashboard?.items.length ? <button type="button" onClick={startNextRound} className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-700">再来一轮</button> : null}<button type="button" onClick={() => setTab('session')} className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-2 text-sm font-semibold text-blue-700">去会话复盘</button></div></div>
              )}
            </article>
          </section>
        )}

        {tab === 'session' && (
          <section className="mt-4">
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-end gap-3">
                <label className="min-w-[240px] flex-1"><span className="mb-1.5 block text-xs font-semibold text-slate-500">选择会话</span><select value={selectedId} onChange={(event) => setSelectedId(event.target.value)} className="h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm">{conversations.map((conversation) => <option key={conversation.id} value={conversation.id}>{conversation.title}</option>)}</select></label>
                <button type="button" onClick={() => void generate()} disabled={loading || generating} className="h-10 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-50">{generating ? '正在生成…' : data?.review ? '更新复盘' : '生成复盘'}</button>
              </div>
              {data?.review?.stale && <p className="mt-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-700">会话内容已有更新，建议重新生成复盘。</p>}
            </div>
            {loading ? <p className="py-14 text-center text-sm text-slate-500">正在加载会话复盘…</p> : data && (
              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <article className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm lg:col-span-2"><div className="flex flex-wrap items-center justify-between gap-2"><div><h2 className="text-lg font-semibold text-slate-900">{data.conversation.title}</h2><p className="mt-1 text-xs text-slate-400">{data.conversation.messageCount} 条消息 · {new Date(data.conversation.updatedAt).toLocaleString()}</p></div>{data.review && <span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${data.review.status === 'ready' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>{data.review.status === 'ready' ? '复盘已生成' : '生成失败'}</span>}</div>{data.review?.summary ? <><p className="mt-4 leading-7 text-slate-700">{data.review.summary}</p><div className="mt-4 flex flex-wrap gap-2">{data.review.topics.map((topic) => <span key={topic} className="rounded-full bg-blue-50 px-3 py-1 text-xs text-blue-700">{topic}</span>)}</div><div className="mt-5 grid gap-4 sm:grid-cols-2"><div className="rounded-xl bg-emerald-50 p-3"><p className="text-sm font-semibold text-emerald-700">做得好的地方</p><ul className="mt-2 space-y-1 text-sm text-slate-600">{data.review.strengths.map((item) => <li key={item}>• {item}</li>)}</ul></div><div className="rounded-xl bg-amber-50 p-3"><p className="text-sm font-semibold text-amber-700">下一步重点</p><ul className="mt-2 space-y-1 text-sm text-slate-600">{data.review.priorities.map((item) => <li key={item}>• {item}</li>)}</ul></div></div></> : <p className="mt-4 text-sm text-slate-500">生成复盘后会提炼本次对话的优点、优先练习项和自然表达。</p>}</article>
                <SessionVocabulary items={sessionVocabulary} onPlay={playText} />
                <SessionCorrections data={data} onPlay={playText} />
                <SessionExpressions data={data} onPlay={playText} />
              </div>
            )}
          </section>
        )}

        {tab === 'library' && <section className="mt-4"><div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><div className="flex flex-wrap items-end gap-3"><label className="min-w-[150px]"><span className="mb-1 block text-xs font-semibold text-slate-500">类型</span><select value={libraryFilter.kind || 'all'} onChange={(event) => setLibraryFilter((value) => ({ ...value, kind: event.target.value as ReviewLibraryFilter['kind'] }))} className="h-10 w-full rounded-lg border border-slate-300 px-2 text-sm"><option value="all">全部类型</option><option value="vocabulary">生词与搭配</option><option value="correction">重点纠错</option><option value="expression">自然表达</option></select></label><label className="min-w-[150px]"><span className="mb-1 block text-xs font-semibold text-slate-500">状态</span><select value={libraryFilter.status || 'all'} onChange={(event) => setLibraryFilter((value) => ({ ...value, status: event.target.value as ReviewLibraryFilter['status'] }))} className="h-10 w-full rounded-lg border border-slate-300 px-2 text-sm"><option value="all">全部状态</option><option value="due">当前待复习</option><option value="learning">学习中</option><option value="mastered">已掌握</option></select></label><label className="min-w-[190px] flex-1"><span className="mb-1 block text-xs font-semibold text-slate-500">搜索</span><input value={libraryFilter.query || ''} onChange={(event) => setLibraryFilter((value) => ({ ...value, query: event.target.value }))} placeholder="英文、中文或原句" className="h-10 w-full rounded-lg border border-slate-300 px-3 text-sm" /></label></div></div><div className="mt-4 grid gap-3 md:grid-cols-2">{library.map((item) => <article key={item.id} className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><div className="flex items-start justify-between gap-2"><KindPill kind={item.kind} /><span className="text-[11px] text-slate-400">{item.status === 'mastered' ? '已掌握' : item.intervalDays ? `${item.intervalDays} 天间隔` : '新项目'}</span></div><p className="mt-3 font-semibold leading-6 text-slate-900">{item.answer}</p>{item.meaning && <p className="mt-1 text-sm text-slate-600">{item.meaning}</p>}<p className="mt-3 rounded-lg bg-slate-50 p-2.5 text-sm leading-6 text-slate-600">{item.prompt}</p><div className="mt-3 flex flex-wrap gap-2"><PlayButton text={item.answer} onPlay={playText} /><button type="button" onClick={() => void setMastered(item, item.status !== 'mastered')} className="rounded-lg border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-medium text-emerald-700">{item.status === 'mastered' ? '恢复学习' : '标记掌握'}</button><button type="button" onClick={() => void deleteItem(item)} className="rounded-lg border border-slate-200 px-2 py-1 text-xs text-slate-500 hover:text-rose-600">删除</button></div></article>)}{!library.length && <p className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center text-sm text-slate-500 md:col-span-2">暂时没有符合筛选条件的学习项目。</p>}</div></section>}
      </main>
    </div>
  )
}

function SessionVocabulary({ items, onPlay }: { items: Array<{ term: string; chineseMeaning: string; partOfSpeech: string; sourceSentence?: string }>; onPlay: (text: string) => void }) {
  return <section className="rounded-2xl border border-indigo-100 bg-white p-5 shadow-sm"><h2 className="font-semibold text-slate-900">本次生词与关键词</h2><div className="mt-3 max-h-80 space-y-2 overflow-y-auto pr-1">{items.map((item) => <article key={`${item.term}-${item.chineseMeaning}`} className="rounded-xl bg-indigo-50 p-3"><div className="flex justify-between gap-2"><div><p className="font-semibold text-indigo-950">{item.term}</p><p className="text-xs text-indigo-500">{item.partOfSpeech}</p></div><PlayButton text={item.sourceSentence || item.term} onPlay={onPlay} /></div><p className="mt-2 text-sm text-slate-700">{item.chineseMeaning}</p>{item.sourceSentence && <p className="mt-2 text-xs leading-5 text-slate-500">{item.sourceSentence}</p>}</article>)}{!items.length && <p className="text-sm text-slate-400">没有已提取的生词。</p>}</div></section>
}

function SessionCorrections({ data, onPlay }: { data: LearningReviewData; onPlay: (text: string) => void }) {
  const correctionMap = useMemo(() => new Map(data.conversation.messages.flatMap((message) => (message.corrections || []).filter((correction) => correction.id).map((correction) => [correction.id!, { correction, message }]))), [data])
  return <section className="rounded-2xl border border-amber-100 bg-white p-5 shadow-sm"><h2 className="font-semibold text-slate-900">重点纠错</h2><div className="mt-3 max-h-80 space-y-2 overflow-y-auto pr-1">{data.review?.selectedCorrections.map((selection) => { const entry = correctionMap.get(selection.correctionId); return entry ? <article key={selection.correctionId} className="rounded-xl bg-amber-50 p-3"><p className="text-xs text-slate-500">原句：{entry.message.content}</p><p className="mt-2 text-xs font-semibold text-emerald-700">正确表达</p><div className="flex gap-2"><p className="flex-1 font-medium text-slate-900">{entry.correction.corrected}</p><PlayButton text={entry.correction.corrected} onPlay={onPlay} /></div><p className="mt-2 text-sm text-slate-700">{selection.correctedMeaning || entry.correction.explanation}</p></article> : null })}{!data.review?.selectedCorrections.length && <p className="text-sm text-slate-400">生成复盘后会筛选值得反复练习的纠错。</p>}</div></section>
}

function SessionExpressions({ data, onPlay }: { data: LearningReviewData; onPlay: (text: string) => void }) {
  return <section className="rounded-2xl border border-emerald-100 bg-white p-5 shadow-sm lg:col-span-2"><h2 className="font-semibold text-slate-900">更自然的表达</h2><div className="mt-3 grid gap-3 md:grid-cols-2">{data.review?.expressions.map((item) => <article key={item.id} className="rounded-xl bg-emerald-50 p-3"><p className="text-xs text-slate-500">原表达</p><p className="mt-1 text-sm text-slate-700">{item.original}</p><div className="mt-3 flex gap-2 border-t border-emerald-100 pt-3"><div className="flex-1"><p className="text-xs font-semibold text-emerald-700">更自然的说法</p><p className="mt-1 font-medium text-emerald-950">{item.improved}</p></div><PlayButton text={item.improved} onPlay={onPlay} /></div><p className="mt-2 text-sm text-slate-700">{item.explanation}</p></article>)}{!data.review?.expressions.length && <p className="text-sm text-slate-400">生成复盘后会显示适合复述的表达。</p>}</div></section>
}
