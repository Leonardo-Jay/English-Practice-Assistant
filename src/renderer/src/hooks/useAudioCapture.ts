import { useState, useRef, useCallback, useEffect } from 'react'
import type { SttResult, VoiceCaptureSettings } from '../../types'

const SAMPLE_RATE = 16000
const BUFFER_SIZE = 4096
const DEFAULT_CAPTURE_SETTINGS: VoiceCaptureSettings = {
  initialSilenceMs: 20_000,
  silenceAfterSpeechMs: 5_000,
  speechRmsThreshold: 0.012
}
// At 16 kHz this is six seconds (about 375 KiB before IPC copies). Keeping a
// hard limit prevents a slow recognizer from retaining every audio callback.
const MAX_PENDING_AUDIO_SAMPLES = SAMPLE_RATE * 6

export function useAudioCapture(
  settings: VoiceCaptureSettings = DEFAULT_CAPTURE_SETTINGS
) {
  const [isRecording, setIsRecording] = useState(false)
  const [partialText, setPartialText] = useState('')
  const [error, setError] = useState('')
  const [speechEndSequence, setSpeechEndSequence] = useState(0)

  const audioContextRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const sourceRef = useRef<MediaStreamAudioSourceNode | null>(null)
  const processorRef = useRef<ScriptProcessorNode | null>(null)
  const gainRef = useRef<GainNode | null>(null)
  const pendingAudioRef = useRef<Float32Array[]>([])
  const pendingSamplesRef = useRef(0)
  const drainingAudioRef = useRef<Promise<void> | null>(null)
  const recordingActiveRef = useRef(false)
  const heardSpeechRef = useRef(false)
  const recordingStartedAtRef = useRef(0)
  const lastSpeechAtRef = useRef(0)
  const silenceTriggeredRef = useRef(false)

  const drainAudio = useCallback((): Promise<void> => {
    if (drainingAudioRef.current) return drainingAudioRef.current

    const drain = async () => {
      while (pendingAudioRef.current.length > 0) {
        const samples = pendingAudioRef.current.shift()!
        pendingSamplesRef.current -= samples.length
        try {
          const result: SttResult = await window.api.feedSTTChunk(samples)
          if (result.text) setPartialText(result.text)
        } catch {
          // Individual chunks are best-effort. stop() reports session failures.
        }
      }
    }

    const promise = drain().finally(() => {
      drainingAudioRef.current = null
      if (pendingAudioRef.current.length > 0) void drainAudio()
    })
    drainingAudioRef.current = promise
    return promise
  }, [])

  const enqueueAudio = useCallback((samples: Float32Array) => {
    pendingAudioRef.current.push(samples)
    pendingSamplesRef.current += samples.length
    // Prefer the newest audio if the recognizer cannot keep up. Under normal
    // conditions nothing is discarded; this is a memory-pressure safeguard.
    while (
      pendingSamplesRef.current > MAX_PENDING_AUDIO_SAMPLES &&
      pendingAudioRef.current.length > 1
    ) {
      const discarded = pendingAudioRef.current.shift()!
      pendingSamplesRef.current -= discarded.length
    }
    void drainAudio()
  }, [drainAudio])

  const releaseCaptureResources = useCallback(async () => {
    if (processorRef.current) {
      processorRef.current.onaudioprocess = null
      processorRef.current.disconnect()
      processorRef.current = null
    }
    if (sourceRef.current) {
      sourceRef.current.disconnect()
      sourceRef.current = null
    }
    if (gainRef.current) {
      gainRef.current.disconnect()
      gainRef.current = null
    }
    if (audioContextRef.current) {
      await audioContextRef.current.close()
      audioContextRef.current = null
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop())
      streamRef.current = null
    }
  }, [])

  const start = useCallback(async () => {
    try {
      if (recordingActiveRef.current) {
        return
      }
      recordingActiveRef.current = true

      setError('')

      // Check STT availability
      let initialized = await window.api.isSTTInitialized()
      if (!initialized) {
        initialized = await window.api.initSTT()
      }

      if (!initialized) {
        const status = await window.api.getSTTStatus()
        setError(status.message)
        recordingActiveRef.current = false
        return
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: SAMPLE_RATE,
          echoCancellation: true,
          noiseSuppression: true,
        }
      })
      streamRef.current = stream

      const audioContext = new AudioContext({ sampleRate: SAMPLE_RATE })
      audioContextRef.current = audioContext
      const source = audioContext.createMediaStreamSource(stream)
      sourceRef.current = source
      const processor = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1)
      processorRef.current = processor
      const gain = audioContext.createGain()
      gainRef.current = gain
      gain.gain.value = 0

      source.connect(processor)
      processor.connect(gain)
      gain.connect(audioContext.destination)
      await audioContext.resume()

      // Start STT session
      await window.api.startSTT()
      pendingAudioRef.current = []
      pendingSamplesRef.current = 0
      drainingAudioRef.current = null
      heardSpeechRef.current = false
      recordingStartedAtRef.current = performance.now()
      lastSpeechAtRef.current = recordingStartedAtRef.current
      silenceTriggeredRef.current = false

      processor.onaudioprocess = (e) => {
        const float32 = e.inputBuffer.getChannelData(0)
        // Send a copy because the buffer gets reused
        const copy = new Float32Array(float32)
        let energy = 0
        for (let index = 0; index < copy.length; index += 1) {
          energy += copy[index] * copy[index]
        }
        const rms = Math.sqrt(energy / copy.length)
        const now = performance.now()
        if (rms >= settings.speechRmsThreshold) {
          heardSpeechRef.current = true
          lastSpeechAtRef.current = now
          silenceTriggeredRef.current = false
        } else if (!silenceTriggeredRef.current) {
          const reachedEnd = heardSpeechRef.current
            ? now - lastSpeechAtRef.current >= settings.silenceAfterSpeechMs
            : now - recordingStartedAtRef.current >= settings.initialSilenceMs
          if (reachedEnd) {
            silenceTriggeredRef.current = true
            setSpeechEndSequence((value) => value + 1)
          }
        }
        // Keep chunks ordered without building an unbounded promise chain.
        enqueueAudio(copy)
      }

      setIsRecording(true)
      setPartialText('')
    } catch (err) {
      recordingActiveRef.current = false
      await releaseCaptureResources()
      setError(err instanceof Error ? err.message : '启动录音失败。')
    }
  }, [enqueueAudio, releaseCaptureResources, settings])

  const stop = useCallback(async (): Promise<string> => {
    recordingActiveRef.current = false
    await releaseCaptureResources()

    setIsRecording(false)

    // Get final STT result
    try {
      await drainingAudioRef.current
      const finalText = await window.api.stopSTT()
      pendingAudioRef.current = []
      pendingSamplesRef.current = 0
      setPartialText('')
      return finalText
    } catch {
      pendingAudioRef.current = []
      pendingSamplesRef.current = 0
      setPartialText('')
      return ''
    }
  }, [releaseCaptureResources])

  useEffect(() => {
    return () => {
      // ChatView can unmount when navigating away. Release microphone and its
      // AudioContext instead of leaving capture alive in a hidden page.
      void stop()
    }
  }, [stop])

  const cancel = useCallback(async () => {
    await stop()
  }, [stop])

  return {
    isRecording,
    partialText,
    speechEndSequence,
    error,
    start,
    stop,
    cancel
  }
}
