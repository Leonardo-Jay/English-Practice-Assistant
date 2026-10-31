import { resolve } from 'path'
import { existsSync } from 'fs'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig(({ command, mode }) => {
  const privateEntry = resolve(__dirname, 'private/subtitle-sources/index.ts')
  // All distribution builds are public unless private mode is explicit.
  // Local development keeps the private extension when it is present.
  const usePrivate = mode === 'private' ||
    (command === 'serve' && mode !== 'community' && existsSync(privateEntry))
  if (usePrivate && !existsSync(privateEntry)) {
    throw new Error('Private subtitle provider is absent. Use the community build instead.')
  }
  return {
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@subtitle-source-provider': usePrivate
          ? privateEntry
          : resolve(__dirname, 'src/main/subtitles/sources/community-provider.ts')
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()]
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        // Give the HTML entry a stable logical name. Vite 7 on Windows can
        // otherwise propagate the absolute drive path as an emitted asset name.
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    }
  }
  }
})
