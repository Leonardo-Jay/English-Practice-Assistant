const { spawnSync } = require('child_process')
const { join } = require('path')

const workspace = join(__dirname, '..')
const electron = join(
  workspace,
  'node_modules',
  'electron',
  'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron'
)
const smokeScript = join(workspace, 'scripts', 'sqlite-smoke.cjs')
const prebuild = join(
  workspace,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'prebuild-install.cmd' : 'prebuild-install'
)
const sqlitePackage = join(workspace, 'node_modules', 'better-sqlite3')
const electronVersion = require(join(
  workspace,
  'node_modules',
  'electron',
  'package.json'
)).version

function smoke() {
  return spawnSync(electron, [smokeScript], {
    cwd: workspace,
    stdio: 'inherit'
  }).status === 0
}

if (!smoke()) {
  console.log(`Preparing better-sqlite3 for Electron ${electronVersion}...`)
  const result = spawnSync(prebuild, ['--runtime=electron', `--target=${electronVersion}`], {
    cwd: sqlitePackage,
    stdio: 'inherit',
    env: {
      ...process.env,
      npm_config_runtime: 'electron',
      npm_config_target: electronVersion
    }
  })
  if (result.status !== 0 || !smoke()) {
    console.error(
      'SQLite native binding is unavailable for this Electron runtime. Packaging stopped.'
    )
    process.exit(1)
  }
}

console.log(`SQLite native binding is ready for Electron ${electronVersion}.`)

