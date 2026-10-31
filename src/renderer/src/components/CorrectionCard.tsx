import type { Correction } from '../../types'

interface Props {
  correction: Correction
}

const typeColors: Record<string, string> = {
  grammar: 'bg-amber-100 text-amber-700',
  expression: 'bg-violet-100 text-violet-700',
  vocabulary: 'bg-cyan-100 text-cyan-700'
}

const typeLabels: Record<string, string> = {
  grammar: '语法',
  expression: '表达',
  vocabulary: '词汇'
}

export default function CorrectionCard({ correction }: Props) {
  const colorClass = typeColors[correction.type] || typeColors.grammar
  const label =
    correction.scope === 'sentence' && correction.type === 'expression'
      ? '更自然的整句表达'
      : typeLabels[correction.type] || correction.type

  return (
    <div className={`rounded-lg border bg-white px-2.5 py-2 shadow-sm ${
      correction.scope === 'sentence'
        ? 'border-violet-200'
        : 'border-slate-200'
    }`}>
      <div className="flex items-center gap-1.5 text-[11px] font-semibold">
        <span className={`rounded-full px-1.5 py-0.5 ${colorClass}`}>
          {label}
        </span>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1.5 text-xs leading-5">
        <span className={correction.scope === 'sentence' ? 'text-slate-500' : 'line-through opacity-60'}>
          {correction.original}
        </span>
        <span aria-hidden="true" className="opacity-50">→</span>
        <span className="font-semibold">{correction.corrected}</span>
      </div>
      <p className="mt-1 text-[11px] leading-4 text-slate-500">{correction.explanation}</p>
    </div>
  )
}
