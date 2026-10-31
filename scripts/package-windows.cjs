const { createHash } = require('crypto')
const { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync } = require('fs')
const { join } = require('path')
const { spawnSync } = require('child_process')

const workspace = join(__dirname, '..')
const privateBuild = process.argv.includes('--private')
if (!privateBuild) require('./check-public-boundary.cjs').auditPublicSource(workspace, true)
const cacheRoot = join(workspace, 'build-cache', 'electron-builder')

const assets = [
  {
    release: 'winCodeSign-2.6.0',
    file: 'winCodeSign-2.6.0.7z',
    sha256: 'cdaec7154dda7cc31f88d886e2489379a0625a737d610b5ae7f62a12f16743a4'
  },
  {
    release: 'nsis-3.0.4.1',
    file: 'nsis-3.0.4.1.7z',
    sha256: '9877df902530f96357d13a7a31ae2b9df67f48b11ffc9a1700a7c961574ec5fa'
  },
  {
    release: 'nsis-resources-3.4.1',
    file: 'nsis-resources-3.4.1.7z',
    sha256: '593a9a92ef958321293ac6a2ee61e64bf1bd543142a5bd6b3d310709cc924103'
  }
]

function hash(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

for (const asset of assets) {
  const directory = join(cacheRoot, asset.release)
  const target = join(directory, asset.file)
  mkdirSync(directory, { recursive: true })
  if (existsSync(target) && hash(target) === asset.sha256) {
    console.log(`[cache] ${asset.file}: verified`)
    continue
  }

  const temporary = `${target}.download`
  if (existsSync(temporary)) unlinkSync(temporary)
  const url =
    `https://github.com/electron-userland/electron-builder-binaries/releases/download/` +
    `${asset.release}/${asset.file}`
  console.log(`[download] ${asset.file}`)
  const download = spawnSync(
    process.platform === 'win32' ? 'curl.exe' : 'curl',
    [
      '-L',
      '--fail',
      '--retry',
      '3',
      '--retry-delay',
      '2',
      '--connect-timeout',
      '15',
      '--progress-bar',
      '-o',
      temporary,
      url
    ],
    { stdio: 'inherit' }
  )
  if (download.status !== 0) {
    throw new Error(`Failed to download ${asset.file}.`)
  }
  const actualHash = hash(temporary)
  if (actualHash !== asset.sha256) {
    unlinkSync(temporary)
    throw new Error(
      `Checksum mismatch for ${asset.file}: expected ${asset.sha256}, got ${actualHash}`
    )
  }
  if (existsSync(target)) unlinkSync(target)
  renameSync(temporary, target)
  console.log(`[download] ${asset.file}: complete and verified`)
}

const builderCli = require.resolve('electron-builder/cli.js')
console.log(`[build] electron-builder cache: ${cacheRoot}`)
const result = spawnSync(
  process.execPath,
  [builderCli, '--win', 'nsis', '--x64', ...(privateBuild ? [
    '--config.directories.output=release/private',
    '--config.artifactName=EnglishPracticeAssistant-Private-Setup-${version}.${ext}'
  ] : [])],
  {
    cwd: workspace,
    stdio: 'inherit',
    env: {
      ...process.env,
      ELECTRON_BUILDER_CACHE: cacheRoot
    }
  }
)
process.exit(result.status ?? 1)
