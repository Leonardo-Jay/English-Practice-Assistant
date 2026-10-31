import { useState, useRef, useCallback, useEffect } from 'react'

export function useAudioPlayback() {
  const [isPlaying, setIsPlaying] = useState(false)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const blobUrlRef = useRef<string | null>(null)
  const stopResolverRef = useRef<(() => void) | null>(null)

  const play = useCallback(async (mp3Buffer: ArrayBuffer) => {
    stop()

    if (mp3Buffer.byteLength === 0) {
      throw new Error('语音服务返回了空音频。')
    }

    const blob = new Blob([mp3Buffer], { type: 'audio/wav' })
    const url = URL.createObjectURL(blob)
    blobUrlRef.current = url

    const audio = new Audio(url)
    audioRef.current = audio

    await new Promise<void>((resolve, reject) => {
      stopResolverRef.current = resolve
      audio.onended = () => {
        stopResolverRef.current = null
        setIsPlaying(false)
        cleanup()
        resolve()
      }
      audio.onerror = () => {
        stopResolverRef.current = null
        setIsPlaying(false)
        cleanup()
        reject(new Error('音频播放失败。'))
      }

      setIsPlaying(true)
      void audio.play().catch((error) => {
        stopResolverRef.current = null
        setIsPlaying(false)
        cleanup()
        reject(error)
      })
    })
  }, [])

  const speakWithSystemVoice = useCallback(async (text: string) => {
    stop()
    const content = text.trim()
    if (!content || !('speechSynthesis' in window)) {
      throw new Error('系统语音不可用。')
    }

    await new Promise<void>((resolve, reject) => {
      stopResolverRef.current = resolve
      const utterance = new SpeechSynthesisUtterance(content)
      utterance.lang = 'en-US'
      utterance.rate = 1
      utterance.onend = () => {
        stopResolverRef.current = null
        setIsPlaying(false)
        resolve()
      }
      utterance.onerror = (event) => {
        stopResolverRef.current = null
        setIsPlaying(false)
        reject(new Error(event.error || '系统语音播放失败。'))
      }
      setIsPlaying(true)
      window.speechSynthesis.speak(utterance)
    })
  }, [])

  const stop = useCallback(() => {
    const resolveStoppedPlayback = stopResolverRef.current
    stopResolverRef.current = null
    if (audioRef.current) {
      audioRef.current.onended = null
      audioRef.current.onerror = null
      audioRef.current.pause()
      audioRef.current.currentTime = 0
      audioRef.current = null
    }
    cleanup()
    window.speechSynthesis?.cancel()
    setIsPlaying(false)
    resolveStoppedPlayback?.()
  }, [])

  const cleanup = () => {
    if (blobUrlRef.current) {
      URL.revokeObjectURL(blobUrlRef.current)
      blobUrlRef.current = null
    }
  }

  useEffect(() => {
    return () => {
      if (audioRef.current) {
        audioRef.current.pause()
      }
      cleanup()
    }
  }, [])

  return { isPlaying, play, speakWithSystemVoice, stop }
}
