declare module '*.css'

declare module 'sherpa-onnx-node/streaming-asr' {
  export class OnlineStream {
    acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void
    inputFinished(): void
  }

  export class OnlineRecognizer {
    constructor(config: unknown)
    createStream(): OnlineStream
    isReady(stream: OnlineStream): boolean
    decode(stream: OnlineStream): void
    isEndpoint(stream: OnlineStream): boolean
    getResult(stream: OnlineStream): { text?: string }
    reset(stream: OnlineStream): void
  }
}

declare module 'sherpa-onnx-node/non-streaming-asr' {
  export class OfflineRecognizer {
    constructor(config: unknown)
    createStream(): {
      acceptWaveform(input: { samples: Float32Array; sampleRate: number }): void
    }
    decodeAsync(stream: unknown): Promise<void>
    getResult(stream: unknown): { text?: string }
  }
}

declare module 'sherpa-onnx-node/non-streaming-tts' {
  export class OfflineTts {
    constructor(config: unknown)
    static createAsync(config: unknown): Promise<OfflineTts>
    generateAsync(input: {
      text: string
      sid?: number
      speed?: number
      enableExternalBuffer?: boolean
    }): Promise<{ samples: Float32Array; sampleRate: number }>
  }
}
