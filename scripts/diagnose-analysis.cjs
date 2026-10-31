const { app } = require('electron')
const Database = require('better-sqlite3')
const { join } = require('path')
const { existsSync, copyFileSync, mkdtempSync, rmSync } = require('fs')
const { tmpdir } = require('os')

app.whenReady().then(() => {
  const databasePath = resolveDatabasePath()
  const copy = createDiagnosticCopy(databasePath)
  const database = new Database(copy.path, { fileMustExist: true })
  try {
    const rows = database.prepare(`
      SELECT
        ma.message_id,
        ma.kind,
        ma.status,
        ma.attempt_count,
        ma.error_detail,
        ma.updated_at,
        substr(m.content, 1, 300) AS content
      FROM message_analyses ma
      JOIN messages m ON m.id = ma.message_id
      ORDER BY ma.updated_at DESC
      LIMIT 20
    `).all()
    console.log(JSON.stringify({ databasePath, rows }, null, 2))
  } finally {
    database.close()
    rmSync(copy.directory, { recursive: true, force: true })
    app.quit()
  }
}).catch((error) => {
  console.error(error)
  app.exit(1)
})

function resolveDatabasePath() {
  const appData = process.env.APPDATA || app.getPath('appData')
  const explicit = process.env.LEARNING_DB_PATH
  const userDataOverride = process.env.APP_USER_DATA_DIR
  const candidates = [
    explicit,
    userDataOverride && join(userDataOverride, 'data', 'learning.db'),
    join(app.getPath('userData'), 'data', 'learning.db'),
    join(appData, 'new-practice-english', 'data', 'learning.db'),
    join(appData, 'EnglishPracticeAssistant', 'data', 'learning.db'),
    // Electron development builds may use this directory before an app name
    // has been applied. Keep it as a compatibility fallback only.
    join(appData, 'Electron', 'data', 'learning.db')
  ].filter(Boolean)
  const found = candidates.find((path) => existsSync(path))
  if (found) return found
  throw new Error(
    `找不到学习数据库。请先启动一次应用，或设置 LEARNING_DB_PATH 指向 learning.db。已检查：${candidates.join('；')}`
  )
}

function createDiagnosticCopy(databasePath) {
  // SQLite uses WAL files for recent commits. Opening the application's live
  // database as readonly can fail when SQLite cannot create/read its -shm
  // sidecar. Work on a disposable copy instead, preserving the original data.
  const directory = mkdtempSync(join(tmpdir(), 'english-practice-diagnose-'))
  const target = join(directory, 'learning.db')
  copyFileSync(databasePath, target)
  for (const suffix of ['-wal', '-shm']) {
    const source = `${databasePath}${suffix}`
    if (existsSync(source)) copyFileSync(source, `${target}${suffix}`)
  }
  return { path: target, directory }
}
