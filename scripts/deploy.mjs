import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const projectRoot = path.resolve(import.meta.dirname, '..')
const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
const wranglerCli = require.resolve('wrangler/wrangler-dist/cli.js')

const run = (label, command, args = [], options = {}) => {
  console.log(`[personal-runtime-deploy] ${label}`)
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    shell: false,
    env: {
      ...process.env,
      ...(options.env || {})
    }
  })
  if (result.status === 0) return
  const error = new Error(`${label} failed with exit code ${result.status || 1}`)
  error.exitCode = result.status || 1
  throw error
}

const redactLog = (value = '') => String(value || '')
  .replace(/(Authorization:\s*Bearer\s+)[^\s]+/gi, '$1[redacted]')
  .replace(/(X-Auth-Key:\s*)[^\s]+/gi, '$1[redacted]')
  .replace(/(Cookie:\s*)[^\n\r]+/gi, '$1[redacted]')
  .replace(/(token["']?\s*[:=]\s*["']?)[A-Za-z0-9._-]{16,}/gi, '$1[redacted]')
  .replace(/(api[_-]?key["']?\s*[:=]\s*["']?)[A-Za-z0-9._-]{16,}/gi, '$1[redacted]')

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

const collectLogWindows = (lines = [], patterns = []) => {
  const indexes = []
  lines.forEach((line, index) => {
    if (patterns.some((pattern) => pattern.test(line))) indexes.push(index)
  })
  const ranges = []
  indexes.forEach((index) => {
    const start = Math.max(0, index - 80)
    const end = Math.min(lines.length, index + 100)
    const last = ranges[ranges.length - 1]
    if (last && start <= last.end) {
      last.end = Math.max(last.end, end)
      return
    }
    ranges.push({ start, end })
  })
  return ranges.map(({ start, end }) => lines.slice(start, end).join('\n'))
}

const printLatestWranglerLogDiagnostics = () => {
  const logPath = getLatestWranglerLog()
  if (!logPath) {
    console.error('[personal-runtime-deploy] no wrangler log file found')
    return
  }
  const content = fs.readFileSync(logPath, 'utf8')
  const lines = content.split(/\r?\n/)
  const windows = collectLogWindows(lines, [
    /\/schedules\b/i,
    /Some triggers failed/i,
    /START CF API RESPONSE/i,
    /ERROR/i
  ])
  const tail = lines.slice(-220).join('\n')
  console.error(`[personal-runtime-deploy] latest wrangler log: ${logPath}`)
  if (windows.length) {
    console.error('[personal-runtime-deploy] focused wrangler log excerpts:')
    windows.forEach((window, index) => {
      console.error(`--- excerpt ${index + 1} ---`)
      console.error(redactLog(window))
    })
  }
  console.error('[personal-runtime-deploy] wrangler log tail:')
  console.error(redactLog(tail))
}

try {
  run('apply D1 migrations', npmCommand, ['run', 'db:migrations:apply'])
  run('ensure runtime secrets', npmCommand, ['run', 'secrets:ensure'])
  run('deploy worker with cron triggers', process.execPath, [wranglerCli, 'deploy'], {
    env: {
      WRANGLER_LOG_SANITIZE: 'false'
    }
  })
} catch (error) {
  console.error(`[personal-runtime-deploy] ${error?.message || String(error || 'deploy failed')}`)
  printLatestWranglerLogDiagnostics()
  process.exitCode = error?.exitCode || 1
}
