const { app } = require('electron')
const Database = require('better-sqlite3')
const { join } = require('path')
const { existsSync, unlinkSync } = require('fs')

app.whenReady().then(() => {
  const databasePath = join(
    app.getPath('temp'),
    `english-practice-sqlite-smoke-${process.pid}.db`
  )
  try {
    let database = new Database(databasePath)
    database.pragma('journal_mode = WAL')
    database.exec('CREATE TABLE smoke(id INTEGER PRIMARY KEY, value TEXT NOT NULL)')
    database.prepare('INSERT INTO smoke(value) VALUES (?)').run('持久化正常')
    database.close()

    database = new Database(databasePath)
    const row = database.prepare('SELECT value FROM smoke').get()
    database.close()
    if (!row || row.value !== '持久化正常') {
      throw new Error('SQLite reopen verification failed.')
    }
    console.log(`SQLITE_SMOKE_OK ${databasePath}`)
    app.exit(0)
  } catch (error) {
    console.error('SQLITE_SMOKE_FAILED', error)
    app.exit(1)
  } finally {
    for (const suffix of ['', '-wal', '-shm']) {
      const target = `${databasePath}${suffix}`
      if (existsSync(target)) unlinkSync(target)
    }
  }
})
