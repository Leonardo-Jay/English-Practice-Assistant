interface Props {
  isRecording: boolean
  onStart: () => void
  onStop: () => void
  disabled?: boolean
}

export default function RecordButton({ isRecording, onStart, onStop, disabled }: Props) {
  return (
    <button
      onClick={() => (isRecording ? onStop() : onStart())}
      disabled={disabled}
      aria-label={isRecording ? '停止录音' : '开始录音'}
      className={`relative flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-xl text-white shadow-sm transition disabled:cursor-not-allowed disabled:opacity-50 ${
        isRecording ? 'bg-red-500 hover:bg-red-600' : 'bg-blue-600 hover:bg-blue-700'
      }`}
      title={isRecording ? '停止录音并自动发送（空格键）' : '开始录音（空格键）'}
    >
      {isRecording && <span className="absolute inset-0 animate-ping rounded-xl bg-red-400/30" />}
      <span className="relative z-10">
          {isRecording ? (
            <svg width="14" height="14" viewBox="0 0 14 14" fill="white">
              <rect x="2" y="2" width="10" height="10" rx="1" />
            </svg>
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="9" y="1" width="6" height="12" rx="3" />
              <path d="M19 10v1a7 7 0 0 1-14 0v-1" />
              <line x1="12" y1="18" x2="12" y2="22" />
              <line x1="8" y1="22" x2="16" y2="22" />
            </svg>
          )}
      </span>
    </button>
  )
}
