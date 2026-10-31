const { existsSync, lstatSync, readdirSync, readFileSync } = require('fs')
const { join, relative } = require('path')
const { spawnSync } = require('child_process')

const privateNames = new Set([
  'subhd-adapter.ts', 'zimuwang-adapter.ts', 'captcha-recognition-service.ts',
  'source-session.ts', 'source-parsers.test.ts'
])
const privateCode = /PRIVATE_SUBTITLE_PROVIDER_V1|class\s+(?:SubHDAdapter|ZiMuWangAdapter|CaptchaRecognitionService)|security_verify_img|YunsuoAutoJump/

function filesIn(directory) {
  if (!existsSync(directory)) return []
  if (lstatSync(directory).isSymbolicLink()) throw new Error(`Symlink is not permitted: ${directory}`)
  if (lstatSync(directory).isFile()) return [directory]
  return readdirSync(directory).flatMap((name) => filesIn(join(directory, name)))
}

function auditPublicSource(root, checkBuild = false) {
  for (const path of filesIn(join(root, 'src'))) {
    const name = relative(root, path).replaceAll('\\', '/')
    if (privateNames.has(name.split('/').pop()) || privateCode.test(readFileSync(path, 'utf8'))) {
      throw new Error(`Private subtitle implementation found in public source: ${name}`)
    }
    if (/\b(?:from|import)\s*['"][^'"]*\bprivate[\\/]/.test(readFileSync(path, 'utf8'))) {
      throw new Error(`Public code imports a private implementation directly: ${name}`)
    }
  }
  // Ignore rules do not protect an already-tracked private file.
  const tracked = spawnSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', windowsHide: true })
  if (tracked.status === 0) {
    const forbidden = tracked.stdout.split('\0').filter((name) =>
      /^(?:private|public-source|node_modules|out|out-private|release|data|models|build-cache)\//.test(name) ||
      /(?:^|\/)(?:config\.json|\.env(?:\..*)?)$|\.(?:log|db|sqlite)(?:$|-)/i.test(name)
    )
    if (forbidden.length) throw new Error(`Private or generated files are tracked by Git: ${forbidden.join(', ')}`)
  }
  if (checkBuild) {
    if (!existsSync(join(root, 'out/main/index.js'))) throw new Error('Build output is missing. Run npm run build first.')
    for (const part of ['main', 'preload', 'renderer']) {
      for (const path of filesIn(join(root, 'out', part))) {
        if (privateCode.test(readFileSync(path, 'utf8'))) {
          throw new Error(`Private subtitle implementation found in public build: ${relative(root, path)}`)
        }
      }
    }
  }
}

if (require.main === module) {
  try {
    auditPublicSource(join(__dirname, '..'), process.argv.includes('--build'))
    console.log('PUBLIC_BOUNDARY_OK: public source and requested build contain no private subtitle implementation.')
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}

module.exports = { auditPublicSource, filesIn }
