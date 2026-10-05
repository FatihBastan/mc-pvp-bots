// Window switching between Minecraft and the terminal Claude runs in, and
// closing our own Minecraft when the arena shuts down.
// Best effort on every platform: when it can't, the in-game title still says
// what happened and you alt-tab yourself.

import { execFile } from 'node:child_process'
import { INSTANCE_ID } from './client.mjs'
import { listProcesses, stopIfMatches } from './proc.mjs'

function run(cmd, args, timeoutMs = 4000) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true }, (err, stdout) => {
      resolve(err ? null : String(stdout))
    })
  })
}

// Prism starts Java as `... -Djava.library.path=<instances>/claude-pvp/natives
// ... org.prismlauncher.EntryPoint`. Both parts, in that order, single out OUR
// client: never the player's own Minecraft, and never some other Java program
// that merely runs from a folder called claude-pvp.
export const OUR_CLIENT = new RegExp(`[\\\\/]${INSTANCE_ID}[\\\\/]natives\\b.*\\borg\\.prismlauncher\\.EntryPoint\\b`)
// Any vanilla-launched client: only used to focus, never to close
const ANY_CLIENT = /net\.minecraft\.client\.main\.Main|org\.prismlauncher\.EntryPoint/

// The program a command line runs, by file name: "java", "javaw.exe", ...
export function programOf(cmd) {
  const first = cmd.startsWith('"') ? cmd.slice(1, cmd.indexOf('"', 1)) : cmd.split(/\s/, 1)[0]
  return first.split(/[\\/]/).pop().toLowerCase()
}

export function pickClient(processes, { onlyOurs = false } = {}) {
  // Only real JVMs: a shell or editor whose command line merely mentions the
  // same words must never be mistaken for the game
  const java = processes.filter((p) => /^javaw?(\.exe)?$/.test(programOf(p.cmd)) && !/paper\.jar/.test(p.cmd))
  const ours = java.find((p) => OUR_CLIENT.test(p.cmd))
  if (ours || onlyOurs) return ours?.pid ?? null
  return java.find((p) => ANY_CLIENT.test(p.cmd))?.pid ?? null
}

const PRISM = /(^|[\s\\/"])prismlauncher(\.exe)?("|\s|$)/i

// Is Minecraft for the arena still on its way: Prism running (downloading
// the game, or between launch steps) or our client already started?
export function isClientStarting(processes) {
  return processes.some((p) => PRISM.test(p.cmd) || OUR_CLIENT.test(p.cmd))
}

export async function clientStarting() {
  return isClientStarting(await listProcesses())
}

export async function findClientPid({ onlyOurs = false } = {}) {
  return pickClient(await listProcesses(), { onlyOurs })
}

// Closes the Minecraft that Prism started for the arena (never any other)
export async function closeOurClient() {
  const pid = await findClientPid({ onlyOurs: true })
  if (!pid) return false
  return stopIfMatches(pid, OUR_CLIENT, { graceMs: 6000 })
}

// Windows only lets the app you last used take the foreground. A synthetic
// Alt press first is the standard, harmless way around that lock, so the
// switch actually happens instead of just flashing the taskbar button.
// Walks up from `pid` (Claude Code, or Minecraft's JVM) to the first process
// with a VISIBLE window: Windows Terminal's tabs hide behind conhost/ConPTY.
export function windowsForegroundScript(pid, { fallbackApps = [] } = {}) {
  const n = Number(pid)
  if (!Number.isInteger(n) || n <= 0 || n > 0xffffffff) throw new Error('bad pid')
  for (const app of fallbackApps) if (!/^[A-Za-z0-9_-]{1,40}$/.test(app)) throw new Error('bad app name')
  return [
    'Add-Type -Namespace McPvp -Name W -MemberDefinition @"',
    '[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);',
    '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);',
    '[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);',
    '[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
    '[DllImport("user32.dll")] public static extern void keybd_event(byte v, byte s, uint f, UIntPtr e);',
    '"@',
    'function Raise($proc) {',
    '  if (-not $proc -or $proc.MainWindowHandle -eq 0) { return $false }',
    '  $h = $proc.MainWindowHandle',
    '  if (-not [McPvp.W]::IsWindowVisible($h)) { return $false }',
    '  if ([McPvp.W]::IsIconic($h)) { [void][McPvp.W]::ShowWindow($h, 9) }',
    '  [McPvp.W]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)',
    '  [McPvp.W]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)',
    '  return [McPvp.W]::SetForegroundWindow($h)',
    '}',
    `$p = ${n}`,
    'for ($i = 0; $i -lt 8 -and $p; $i++) {',
    '  if (Raise (Get-Process -Id $p -ErrorAction SilentlyContinue)) { exit 0 }',
    '  $p = (Get-CimInstance Win32_Process -Filter "ProcessId=$p").ParentProcessId',
    '}',
    // A terminal started some other way (the "default terminal" handoff) may
    // not be an ancestor: try the usual terminal apps by name
    ...fallbackApps.map((app) => `foreach ($proc in @(Get-Process -Name '${app}' -ErrorAction SilentlyContinue)) { if (Raise $proc) { exit 0 } }`),
    'exit 1',
  ].join('\n')
}

const WINDOWS_TERMINAL_APPS = ['WindowsTerminal', 'Code', 'Cursor', 'wezterm-gui', 'alacritty']

async function windowsForeground(pid, options) {
  let script
  try {
    script = windowsForegroundScript(pid, options)
  } catch {
    return false
  }
  return (await run('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], 8000)) !== null
}

// The parent of a process on macOS and Linux, or null
async function parentOf(pid) {
  const out = await run('ps', ['-o', 'ppid=', '-p', String(pid)])
  const ppid = Number(out?.trim())
  return ppid > 1 ? ppid : null
}

// Up from a pid to the first process that owns a visible window (X11)
async function linuxActivateFrom(pid) {
  for (let p = pid, i = 0; p && i < 8; i++, p = await parentOf(p)) {
    if ((await run('xdotool', ['search', '--pid', String(p), '--onlyvisible', 'windowactivate'])) !== null) return true
  }
  return false
}

// Up from a pid to the app macOS shows a window for (Terminal, iTerm, Code...)
async function macActivateFrom(pid) {
  for (let p = pid, i = 0; p && i < 8; i++, p = await parentOf(p)) {
    const ok = await run('osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${Number(p)} and background only is false) to true`])
    if (ok !== null) return true
  }
  return false
}

export async function focusGame(platform = process.platform) {
  const pid = await findClientPid()
  if (!pid) return false
  if (platform === 'darwin') {
    return (await run('osascript', ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`])) !== null
  }
  if (platform === 'win32') return windowsForeground(pid)
  // X11; Wayland gives programs no way to raise another app's window
  if (await linuxActivateFrom(pid)) return true
  return (await run('wmctrl', ['-a', 'Minecraft'])) !== null
}

// What the mod says about its terminal, reduced to what focusTerminal needs and
// in shapes that can't smuggle anything into the commands it runs
export function cleanTerminal(t) {
  if (!t || typeof t !== 'object') return null
  const out = {}
  if (typeof t.bundleId === 'string' && /^[A-Za-z0-9][A-Za-z0-9.-]{0,199}$/.test(t.bundleId)) out.bundleId = t.bundleId
  if (typeof t.windowId === 'string' && /^\d{1,20}$/.test(t.windowId)) out.windowId = t.windowId
  if (typeof t.termProgram === 'string' && /^[A-Za-z0-9._-]{1,40}$/.test(t.termProgram)) out.termProgram = t.termProgram
  // Claude Code's own process: the window to come back to is its nearest
  // ancestor with one
  if (typeof t.pid === 'string' && /^[1-9]\d{0,9}$/.test(t.pid)) out.pid = t.pid
  return out
}

// `terminal` comes from the mod (through cleanTerminal): the env vars of the
// Claude Code process
export async function focusTerminal(terminal = {}, platform = process.platform) {
  const { bundleId, windowId, termProgram, pid } = terminal ?? {}
  if (platform === 'darwin') {
    if (bundleId && (await run('open', ['-b', bundleId])) !== null) return true
    if (pid && (await macActivateFrom(Number(pid)))) return true
    const app = { Apple_Terminal: 'Terminal', 'iTerm.app': 'iTerm', ghostty: 'Ghostty', WezTerm: 'WezTerm', vscode: 'Visual Studio Code' }[termProgram]
    return app ? (await run('open', ['-a', app])) !== null : false
  }
  if (platform === 'win32') return pid ? windowsForeground(pid, { fallbackApps: WINDOWS_TERMINAL_APPS }) : false
  if (windowId && (await run('xdotool', ['windowactivate', String(windowId)])) !== null) return true
  return pid ? linuxActivateFrom(Number(pid)) : false
}
