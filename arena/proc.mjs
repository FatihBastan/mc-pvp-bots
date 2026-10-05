// Finding and stopping our own processes, and only ours: every kill checks
// the command line first, so a reused pid never takes down something else.

import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'

function run(cmd, args, timeoutMs = 5000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      resolve(err ? null : String(stdout))
    })
  })
}

export function isAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err.code === 'EPERM'
  }
}

export async function commandLineOf(pid, platform = process.platform) {
  if (!isAlive(pid)) return null
  if (platform === 'linux') {
    const raw = await readFile(`/proc/${pid}/cmdline`, 'utf8').catch(() => null)
    return raw === null ? null : raw.split('\0').join(' ').trim()
  }
  if (platform === 'win32') {
    const out = await run('powershell', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`])
    return out?.trim() || null
  }
  const out = await run('ps', ['-ww', '-p', String(pid), '-o', 'command='])
  return out?.trim() || null
}

// Every process as { pid, cmd }
export async function listProcesses(platform = process.platform) {
  if (platform === 'win32') {
    const out = await run('powershell', [
      '-NoProfile',
      '-Command',
      "Get-CimInstance Win32_Process -Filter \"Name like 'java%' or Name like 'prismlauncher%'\" | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }",
    ])
    return parseList(out)
  }
  return parseList(await run('ps', ['-axww', '-o', 'pid=,args=']))
}

export function parseList(out) {
  if (!out) return []
  const list = []
  for (const line of out.split(/\r?\n/)) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line)
    if (m) list.push({ pid: Number(m[1]), cmd: m[2] })
  }
  return list
}

// Stops pid if its command line still matches; true once it's gone
export async function stopIfMatches(pid, pattern, { graceMs = 8000, platform = process.platform } = {}) {
  if (!isAlive(pid)) return true
  const cmd = await commandLineOf(pid, platform)
  if (cmd === null) return !isAlive(pid)
  if (!pattern.test(cmd)) return false
  if (platform === 'win32') {
    // taskkill without /F asks the window to close; force it after the grace period
    await run('taskkill', ['/PID', String(pid)])
  } else {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {}
  }
  const until = Date.now() + graceMs
  while (Date.now() < until) {
    if (!isAlive(pid)) return true
    await new Promise((r) => setTimeout(r, 200))
  }
  if (platform === 'win32') await run('taskkill', ['/F', '/PID', String(pid)])
  else {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {}
  }
  await new Promise((r) => setTimeout(r, 200))
  return !isAlive(pid)
}
