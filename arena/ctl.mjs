#!/usr/bin/env node
// What the mod runs: `setup` (one time), `ensure` (start the daemon if it
// isn't running) and `stop`. Each prints JSON on stdout for the mod to read.

import { execFile, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { chmodSync, openSync } from 'node:fs'
import { copyFile, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const here = dirname(fileURLToPath(import.meta.url))

const { values: args, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    data: { type: 'string' },
    port: { type: 'string', default: '25601' },
    'server-port': { type: 'string', default: '25599' },
    'idle-minutes': { type: 'string', default: '15' },
    launcher: { type: 'string', default: 'prism' },
    'prism-path': { type: 'string', default: '' },
    'prism-data': { type: 'string', default: '' },
    'accept-eula': { type: 'boolean', default: false },
    'fake-server': { type: 'string' },
    'no-bots': { type: 'boolean', default: false },
    'lease-ms': { type: 'string' },
    'keep-game': { type: 'boolean', default: false },
    'idle-ms': { type: 'string' },
    'join-wait-ms': { type: 'string' },
    'launch-wait-ms': { type: 'string' },
  },
})

const out = (obj) => process.stdout.write(JSON.stringify(obj) + '\n')
const dataDir = args.data
if (!dataDir) {
  out({ ok: false, error: '--data is required' })
  process.exit(2)
}
const testing = process.env.MC_PVP_BOTS_TESTING === '1'
if ((args['fake-server'] || args['no-bots']) && !testing) {
  out({ ok: false, error: 'test switches need MC_PVP_BOTS_TESTING=1' })
  process.exit(2)
}

// The data folder holds the control token, the server and its world: only
// you may read it (on Windows your profile folder's permissions do this)
async function privateDataDir() {
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') chmodSync(dataDir, 0o700)
}

async function control() {
  try {
    return JSON.parse(await readFile(join(dataDir, 'control.json'), 'utf8'))
  } catch {
    return {}
  }
}

async function ensureToken() {
  await privateDataDir()
  const path = join(dataDir, 'control.json')
  const c = await control()
  if (typeof c.token === 'string' && c.token.length >= 24) {
    if (process.platform !== 'win32') chmodSync(path, 0o600)
    return c.token
  }
  const token = randomBytes(24).toString('base64url')
  await writeFile(path, JSON.stringify({ token }), { mode: 0o600 })
  if (process.platform !== 'win32') chmodSync(path, 0o600)
  return token
}

async function health(port, token, timeoutMs = 800) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { 'x-arena-token': token },
      signal: AbortSignal.timeout(timeoutMs),
    })
    return res.ok ? await res.json() : null
  } catch {
    return null
  }
}

async function ensure() {
  const port = Number(args.port)
  const token = await ensureToken()
  let up = await health(port, token)
  // One that is shutting down is no use: let it finish, then start fresh
  for (let i = 0; up?.phase === 'stopping' && i < 60; i++) {
    await new Promise((r) => setTimeout(r, 500))
    up = await health(port, token)
  }
  if (up && up.phase !== 'stopping') return out({ ok: true, port, token, pid: up.pid, phase: up.phase, already: true })
  // Crash output only; start it over once it passes a megabyte
  const outPath = join(dataDir, 'daemon.out')
  const tooBig = await stat(outPath).then((s) => s.size > 1024 * 1024, () => false)
  const logFd = openSync(outPath, tooBig ? 'w' : 'a')
  const daemonArgs = [
    join(here, 'daemon.mjs'),
    '--data', dataDir,
    '--port', String(port),
    '--server-port', args['server-port'],
    '--idle-minutes', args['idle-minutes'],
    '--launcher', args.launcher === 'manual' ? 'manual' : 'prism',
    '--prism-path', args['prism-path'],
    '--prism-data', args['prism-data'],
    ...(args['fake-server'] ? ['--fake-server', args['fake-server']] : []),
    ...(args['no-bots'] ? ['--no-bots'] : []),
    ...(args['lease-ms'] ? ['--lease-ms', args['lease-ms']] : []),
    ...(args['idle-ms'] ? ['--idle-ms', args['idle-ms']] : []),
    ...(args['join-wait-ms'] ? ['--join-wait-ms', args['join-wait-ms']] : []),
    ...(args['launch-wait-ms'] ? ['--launch-wait-ms', args['launch-wait-ms']] : []),
  ]
  // Detached and with no pipes back to us, so this command returns at once and
  // the arena outlives the Claude Code session that started it
  const child = spawn(process.execPath, daemonArgs, { detached: true, stdio: ['ignore', logFd, logFd], windowsHide: true })
  child.unref()
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 150))
    const h = await health(port, token)
    if (h) return out({ ok: true, port, token, pid: h.pid, phase: h.phase, already: false })
    if (child.exitCode !== null) break
  }
  out({ ok: false, error: `the arena daemon did not start; see ${join(dataDir, 'daemon.out')}` })
}

async function stop() {
  const port = Number(args.port)
  const { token } = await control()
  if (!token) return out({ ok: true, wasRunning: false })
  try {
    await fetch(`http://127.0.0.1:${port}/stop`, {
      method: 'POST',
      headers: { 'x-arena-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({ closeGame: args['keep-game'] !== true }),
      signal: AbortSignal.timeout(2000),
    })
    out({ ok: true, wasRunning: true })
  } catch {
    out({ ok: true, wasRunning: false })
  }
}

function runQuiet(cmd, cmdArgs, opts = {}) {
  return new Promise((resolve) => {
    execFile(cmd, cmdArgs, { timeout: 10 * 60_000, windowsHide: true, shell: process.platform === 'win32', ...opts }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), error: err?.message })
    })
  })
}

async function setup() {
  const steps = []
  const warnings = []
  const step = (name, detail) => {
    steps.push(name)
    out({ step: name, detail })
  }
  const done = (ok, error) => out({ done: true, ok, error, steps, warnings })

  const nodeMajor = Number(process.versions.node.split('.')[0])
  if (nodeMajor < 20) return done(false, `Node ${process.versions.node} is too old; install Node 20 or newer`)
  step('node', process.versions.node)

  const java = await runQuiet('java', ['-version'], { shell: false })
  const javaText = java.stderr + java.stdout
  const javaMajor = Number(/version "(\d+)/.exec(javaText)?.[1] ?? 0)
  if (!java.ok || javaMajor < 21) {
    return done(false, java.ok ? `Java ${javaMajor} found; the server needs Java 21 or newer` : 'Java not found; install Java 21 (for example Eclipse Temurin 21)')
  }
  step('java', String(javaMajor))

  await privateDataDir()
  const runtime = join(dataDir, 'runtime')
  await mkdir(runtime, { recursive: true })
  // Exactly the versions in the shipped lockfile, each checked against its
  // recorded hash (npm ci), and no package's install scripts run: none of
  // the bots' dependencies needs one, and that's how npm malware runs
  const lock = await readFile(join(here, 'runtime', 'package-lock.json'))
  const want = createHash('sha256').update(lock).digest('hex')
  // Written only after npm finished, so an install cut short (Claude Code
  // closed mid-setup) is redone instead of half-used
  const marker = join(runtime, '.installed')
  const installed = await readFile(marker, 'utf8').catch(() => null)
  if (installed !== want) {
    await rm(marker, { force: true })
    step('bots', 'installing mineflayer (one time, ~40 MB)')
    await copyFile(join(here, 'runtime', 'package.json'), join(runtime, 'package.json'))
    await copyFile(join(here, 'runtime', 'package-lock.json'), join(runtime, 'package-lock.json'))
    const npm = await runQuiet(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: runtime })
    if (!npm.ok) return done(false, `npm ci failed: ${(npm.stderr || npm.error || '').slice(-400)}`)
    await writeFile(marker, want)
  }
  step('bots', 'ready')

  const server = await import('./server.mjs')
  if (args['accept-eula']) await server.acceptEula(dataDir)
  if (!server.isEulaAccepted(dataDir)) return done(false, 'eula-needed')
  step('eula', 'accepted')

  step('server', `downloading Paper ${server.MC_VERSION} (one time, ~50 MB)`)
  try {
    await server.ensurePaper(dataDir, (line) => out({ step: 'server', detail: line }))
  } catch (err) {
    return done(false, `Paper download failed: ${err.message}`)
  }
  await server.writeServerConfig(dataDir, { serverPort: Number(args['server-port']) })
  step('server', 'ready')

  if (args.launcher === 'prism') {
    const client = await import('./client.mjs')
    const prism = client.findPrism({ override: args['prism-path'], dataOverride: args['prism-data'] })
    if (!prism) {
      warnings.push('Prism Launcher not found. Install it from prismlauncher.org, or set launcher to "manual" and join 127.0.0.1:' + args['server-port'] + ' yourself.')
    } else {
      await client.ensureInstance(prism.data, Number(args['server-port']))
      step('client', 'Prism instance "Claude PvP" ready')
      if (!(await client.hasPrismAccount(prism.data))) {
        warnings.push('Prism has no Minecraft account yet: open Prism Launcher once and add your Microsoft account.')
      }
    }
  }
  done(true)
}

const command = positionals[0]
if (command === 'ensure') await ensure()
else if (command === 'stop') await stop()
else if (command === 'setup') await setup()
else {
  out({ ok: false, error: `unknown command ${command}` })
  process.exit(2)
}
