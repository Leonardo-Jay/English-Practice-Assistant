import { useState } from 'react'
import ChatView from './components/ChatView'
import SettingsPage from './components/SettingsPage'
import FeedbackPanel from './components/FeedbackPanel'

export default function App() {
  const [page, setPage] = useState<'chat' | 'settings'>('chat')
  const [showFeedback, setShowFeedback] = useState(false)
  const [allCorrections, setAllCorrections] = useState<import('./types').Correction[]>([])

  return (
    <div className="flex h-screen flex-col">
      {/* Header */}
      <header className="flex items-center justify-between border-b border-slate-700 bg-slate-800 px-6 py-3">
        <h1 className="text-lg font-semibold text-slate-100">English Practice</h1>
        <div className="flex gap-2">
          <button
            onClick={() => setShowFeedback(!showFeedback)}
            className="rounded-md px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-700 hover:text-white"
          >
            Feedback
          </button>
          <button
            onClick={() => setPage(page === 'chat' ? 'settings' : 'chat')}
            className="rounded-md px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-700 hover:text-white"
          >
            {page === 'chat' ? 'Settings' : 'Chat'}
          </button>
        </div>
      </header>

      {/* Body */}
      <div className="flex flex-1 overflow-hidden">
        <main className="flex-1">
          {page === 'chat' ? (
            <ChatView onCorrectionsUpdate={setAllCorrections} />
          ) : (
            <SettingsPage />
          )}
        </main>
        {showFeedback && (
          <FeedbackPanel
            corrections={allCorrections}
            onClose={() => setShowFeedback(false)}
          />
        )}
      </div>
    </div>
  )
}
