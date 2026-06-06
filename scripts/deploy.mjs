import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const projectRoot = path.resolve(import.meta.dirname, '..')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const wranglerCli = require.resolve('wrangler/wrangler-dist/cli.js')

const run = (label, command, args = []) => {
  console.log(`[personal-runtime-deploy] ${label}`)
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: false
  })
  if (result.status === 0) return
  const error = new Error(`${label} failed with exit code ${result.status || 1}`)
  error.exitCode = result.status || 1
  throw error
}

const getLatestWranglerLog = () => {
  const logsDir = path.join(os.homedir(), '.config', '.wrangler', 'logs')
  if (!fs.existsSync(logsDir)) return null
  const logs = fs.readdirSync(logsDir)
    .filter((name) => /^wrangler-.*\.log$/i.test(name))
    .map((name) => {
      const filePath = path.join(logsDir, name)
      return {
        filePath,
        mtimeMs: fs.statSync(filePath).mtimeMs
      }
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
  return logs[0]?.filePath || null
}

const printLatestWranglerLogTail = () => {
  const logPath = getLatestWranglerLog()
  if (!logPath) {
    console.error('[personal-runtime-deploy] no wrangler log file found')
    return
  }
  const content = fs.readFileSync(logPath, 'utf8')
  const lines = content.split(/\r?\n/).slice(-160)
  console.error(`[personal-runtime-deploy] latest wrangler log: ${logPath}`)
  console.error(lines.join('\n'))
}

try {
  run('apply D1 migrations', npmCommand, ['run', 'db:migrations:apply'])
  run('ensure runtime secrets', npmCommand, ['run', 'secrets:ensure'])
  run('deploy worker with cron triggers', process.execPath, [wranglerCli, 'deploy'])
} catch (error) {
  console.error(`[personal-runtime-deploy] ${error?.message || String(error || 'deploy failed')}`)
  printLatestWranglerLogTail()
  process.exitCode = error?.exitCode || 1
}
