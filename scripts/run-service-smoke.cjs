const { buildSync } = require('esbuild')
const { spawnSync } = require('child_process')
const { join } = require('path')

const workspace = join(__dirname, '..')
const output = join(workspace, 'out', 'test', 'service-smoke.cjs')
buildSync({
  entryPoints: [join(workspace, 'scripts', 'service-smoke.ts')],
  outfile: output,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  external: ['electron', 'better-sqlite3'],
  sourcemap: false
})

const electron = join(
  workspace,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
)
const result = spawnSync(electron, [output], {
  cwd: workspace,
  stdio: 'inherit'
})
process.exit(result.status ?? 1)

