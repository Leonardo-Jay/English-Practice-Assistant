import type { VocabularyInsight } from '../../types'

interface Props {
  item: VocabularyInsight
}

export default function VocabularyCard({ item }: Props) {
  return (
    <div className="rounded-lg border border-indigo-100 bg-white px-2.5 py-2 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-indigo-900">{item.term}</span>
        <span className="rounded-full bg-indigo-100 px-1.5 py-0.5 text-[10px] font-medium text-indigo-600">
          {item.partOfSpeech}
        </span>
      </div>
      <p className="mt-1.5 text-[11px] leading-4 text-slate-600">
        {item.chineseMeaning}
      </p>
    </div>
  )
}
