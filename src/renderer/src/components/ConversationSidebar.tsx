import { useEffect, useRef, useState } from 'react'
import type { ConversationSummary } from '../../types'

interface Props {
  conversations: ConversationSummary[]
  activeConversationId?: string
  onNew: () => void
  onSelect: (conversationId: string) => void
  onRename: (conversationId: string, title: string) => void | Promise<void>
  onDelete: (conversationId: string) => void
  onSearch?: (query: string) => void
  hasMore?: boolean
  onLoadMore?: () => void
  onClose?: () => void
}

export default function ConversationSidebar({
  conversations,
  activeConversationId,
  onNew,
  onSelect,
  onRename,
  onDelete,
  onSearch,
  hasMore = false,
  onLoadMore,
  onClose
}: Props) {
  const [query, setQuery] = useState('')
  const [editingId, setEditingId] = useState<string>()
  const [draftTitle, setDraftTitle] = useState('')
  const [renameError, setRenameError] = useState('')
  const titleInputRef = useRef<HTMLInputElement>(null)
  const normalized = query.trim().toLocaleLowerCase()
  const filtered = normalized
    ? conversations.filter((item) =>
        `${item.title} ${item.preview}`.toLocaleLowerCase().includes(normalized)
      )
    : conversations

  useEffect(() => {
    if (editingId) titleInputRef.current?.focus()
  }, [editingId])

  const beginRename = (item: ConversationSummary) => {
    setEditingId(item.id)
    setDraftTitle(item.title)
    setRenameError('')
  }

  const cancelRename = () => {
    setEditingId(undefined)
    setDraftTitle('')
    setRenameError('')
  }

  const saveRename = async (item: ConversationSummary) => {
    const next = draftTitle.replace(/\s+/g, ' ').trim()
    if (!next) {
      setRenameError('会话名称不能为空。')
      return
    }
    if (next === item.title) {
      cancelRename()
      return
    }
    try {
      await onRename(item.id, next)
      cancelRename()
    } catch (error) {
      setRenameError(error instanceof Error ? error.message : '重命名失败，请重试。')
    }
  }

  const remove = (item: ConversationSummary) => {
    if (window.confirm(`确定删除“${item.title}”吗？`)) onDelete(item.id)
  }

  return (
    <aside className="flex h-full w-[280px] flex-col border-r border-slate-200 bg-slate-50">
      <div className="border-b border-slate-200 p-3">
        <div className="flex items-center gap-2">
          <button
            onClick={onNew}
            className="flex h-10 flex-1 items-center justify-center gap-2 rounded-xl bg-blue-600 px-3 text-sm font-semibold text-white shadow-sm hover:bg-blue-700"
          >
            <span className="text-lg leading-none">＋</span>
            新对话
          </button>
          {onClose && (
            <button
              onClick={onClose}
              aria-label="收起会话列表"
              className="flex h-10 w-10 items-center justify-center rounded-xl border border-slate-200 bg-white text-slate-500 hover:bg-slate-100"
            >
              ×
            </button>
          )}
        </div>
        <input
          value={query}
          onChange={(event) => {
            const value = event.target.value
            setQuery(value)
            onSearch?.(value)
          }}
          placeholder="搜索会话"
          className="mt-3 h-9 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-blue-400"
        />
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-2">
        {filtered.length === 0 ? (
          <p className="px-3 py-8 text-center text-sm text-slate-400">
            {query ? '没有匹配的会话' : '还没有保存的会话'}
          </p>
        ) : (
          <div className="space-y-1">
            {filtered.map((item) => {
              const active = item.id === activeConversationId
              const editing = editingId === item.id
              return (
                <div
                  key={item.id}
                  className={`group rounded-xl border px-3 py-2.5 transition ${
                    active
                      ? 'border-blue-200 bg-blue-50'
                      : 'border-transparent hover:border-slate-200 hover:bg-white'
                  }`}
                >
                  {editing ? (
                    <div className="space-y-1.5">
                      <input
                        ref={titleInputRef}
                        value={draftTitle}
                        maxLength={80}
                        onChange={(event) => setDraftTitle(event.target.value)}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter') void saveRename(item)
                          if (event.key === 'Escape') cancelRename()
                        }}
                        aria-label="会话名称"
                        className="h-8 w-full rounded-lg border border-blue-300 bg-white px-2 text-sm text-slate-800 outline-none ring-blue-100 focus:ring-2"
                      />
                      {renameError && <p className="text-xs text-red-600">{renameError}</p>}
                    </div>
                  ) : (
                    <button onClick={() => onSelect(item.id)} className="block w-full text-left">
                      <p className="truncate text-sm font-medium text-slate-800">{item.title}</p>
                      <p className="mt-1 truncate text-xs text-slate-500">
                        {item.preview || '等待开始对话'}
                      </p>
                    </button>
                  )}
                  <div className="mt-2 flex items-center justify-between">
                    <span className="text-[10px] text-slate-400">
                      {new Date(item.updatedAt).toLocaleDateString()}
                    </span>
                    <div className="flex gap-1 sm:opacity-0 sm:transition sm:group-hover:opacity-100 sm:focus-within:opacity-100">
                      {editing ? (
                        <>
                          <button
                            onClick={() => void saveRename(item)}
                            className="rounded px-1.5 py-0.5 text-[11px] text-blue-600 hover:bg-blue-50"
                          >
                            保存
                          </button>
                          <button
                            onClick={cancelRename}
                            className="rounded px-1.5 py-0.5 text-[11px] text-slate-500 hover:bg-slate-100"
                          >
                            取消
                          </button>
                        </>
                      ) : (
                        <button
                          onClick={() => beginRename(item)}
                          className="rounded px-1.5 py-0.5 text-[11px] text-slate-500 hover:bg-slate-100"
                        >
                          重命名
                        </button>
                      )}
                      <button
                        onClick={() => remove(item)}
                        className="rounded px-1.5 py-0.5 text-[11px] text-red-500 hover:bg-red-50"
                      >
                        删除
                      </button>
                    </div>
                  </div>
                </div>
              )
            })}
            {hasMore && (
              <button
                onClick={onLoadMore}
                className="mt-2 w-full rounded-lg py-2 text-xs font-medium text-blue-600 hover:bg-blue-50"
              >
                加载更多会话
              </button>
            )}
          </div>
        )}
      </div>
    </aside>
  )
}
