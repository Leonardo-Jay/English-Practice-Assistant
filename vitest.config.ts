import { configDefaults, defineConfig } from 'vitest/config'

export default defineConfig({
  test: { exclude: [...configDefaults.exclude, 'private/**', 'public-source/**', 'scripts/**/*.test.cjs'] }
})
