const { test } = require('node:test')
const assert = require('node:assert/strict')
const { mkdirSync, mkdtempSync, rmSync, writeFileSync } = require('fs')
const { tmpdir } = require('os')
const { join } = require('path')
const { auditPublicSource } = require('./check-public-boundary.cjs')

function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), 'public-boundary-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'out/main'), { recursive: true })
  return root
}

test('rejects private implementation in a public build, including private sourcemaps', (t) => {
  const root = workspace(t)
  writeFileSync(join(root, 'out/main/index.js'), 'console.log("community")')
  assert.doesNotThrow(() => auditPublicSource(root, true))
  writeFileSync(join(root, 'out/main/index.js.map'), JSON.stringify({ sourcesContent: ['PRIVATE_SUBTITLE_PROVIDER_V1'] }))
  assert.throws(() => auditPublicSource(root, true), /Private subtitle implementation found in public build/)
})

test('rejects moving a private adapter back into the public source tree', (t) => {
  const root = workspace(t)
  writeFileSync(join(root, 'src/captcha-recognition-service.ts'), '// accidental move')
  assert.throws(() => auditPublicSource(root), /Private subtitle implementation found in public source/)
})
