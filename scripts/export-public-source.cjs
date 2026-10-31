const { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } = require('fs')
const { dirname, join, relative, resolve } = require('path')
const { auditPublicSource, filesIn } = require('./check-public-boundary.cjs')

const workspace = resolve(__dirname, '..')
if (!existsSync(join(workspace, 'LICENSE'))) {
  throw new Error('A LICENSE file is required before exporting public source.')
}
auditPublicSource(workspace)
const timestamp = new Date().toISOString().replace(/[:.]/g, '-')
const destination = join(workspace, 'public-source', `english-practice-community-${timestamp}`)

// Deliberately allowlist source inputs. Never copy the development workspace,
// its Git history, runtime profiles, downloaded content, or private directory.
const inputs = [
  'src', 'scripts', 'docs', 'build/installer.nsh', '.gitignore', 'README.md', 'LICENSE',
  'package.json', 'package-lock.json', 'tsconfig.json',
  'electron.vite.config.ts', 'vitest.config.ts', '.github/workflows/community-ci.yml'
]
for (const input of inputs) {
  for (const source of filesIn(join(workspace, input))) {
    const name = relative(workspace, source).replaceAll('\\', '/')
    if (/(?:^|\/)(?:config\.json|\.env(?:\..*)?|\.npmrc)$|\.(?:log|jsonl|db|sqlite|pem|key)$/i.test(name)) {
      throw new Error(`Private runtime file found among export inputs: ${name}`)
    }
    const target = join(destination, relative(workspace, source))
    mkdirSync(dirname(target), { recursive: true })
    copyFileSync(source, target)
  }
}
const manifestPath = join(destination, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
for (const script of Object.keys(manifest.scripts)) {
  if (script.includes('private')) delete manifest.scripts[script]
}
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
for (const name of ['private', 'data', 'models', 'out', 'release', '.git', '.codex', '.npmrc']) {
  if (existsSync(join(destination, name))) throw new Error(`Unexpected private export content: ${name}`)
}
auditPublicSource(destination)
console.log('PUBLIC_SOURCE_EXPORT_OK')
console.log(`GitHub source directory: ${destination}`)
console.log('Create the public repository from this directory, not from the private development workspace.')
