#!/usr/bin/env node
// The arena daemon: owns the Paper server and the bots, and takes orders from
// the Claude Code mod over HTTP on 127.0.0.1. One per machine, shared by every
// Claude Code session.
//
// Nothing it starts may outlive a reason to exist:
//   - while you fight, the mod checks in every few seconds; miss the lease
//     (Claude Code quit, crashed, or the terminal closed) and the arena pauses
//   - paused with nobody asking for anything, it shuts down after idleMinutes,
//     closing the Minecraft it launched
//   - the server runs under a watcher that stops it if this process dies, and
//     a server left behind anyway is stopped through its pid file on next start

import { timingSafeEqual } from 'node:crypto'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseArgs } from 'node:util'
import { BotSwarm, loadBotLibraries } from './bots.mjs'
import {
  DIFFICULTIES,
  arenaSpawnPoint,
  botsShouldFight,
  countdownLeft,
  isProtected,
  nextHumanState,
  normalizeCount,
  tierMix,
} from './brain.mjs'
import { ensureInstance, findPrism, launchClient } from './client.mjs'
import { cleanTerminal, clientStarting, closeOurClient, focusGame, focusTerminal } from './focus.mjs'
import {
  MC_VERSION,
  PaperServer,
  alertCommands,
  arenaBuildCommands,
  arenaRuleCommands,
  freezeHumanCommands,
  hideStatusBarCommands,
  statusBarCommands,
  isArenaBuilt,
  isEulaAccepted,
  kitCommands,
  markArenaBuilt,
  openLog,
  readJson,
  serverPaths,
  stopStaleServer,
  thawHumanCommands,
  titleCommands,
  writeServerConfig,
} from './server.mjs'

const { values: args } = parseArgs({
  options: {
    data: { type: 'string' },
    port: { type: 'string', default: '25601' },
    'server-port': { type: 'string', default: '25599' },
    'idle-minutes': { type: 'string', default: '15' },
    // How long a live arena keeps going without hearing from the mod
    'lease-ms': { type: 'string', default: '20000' },
    // Where Prism is: from the person's own config, at start only. Never over
    // HTTP: a path the daemon launches must not come in through a request.
    launcher: { type: 'string', default: 'prism' },
    'prism-path': { type: 'string', default: '' },
    'prism-data': { type: 'string', default: '' },
    // Tests: run a fake server instead of Paper, and no real bots
    'fake-server': { type: 'string' },
    'no-bots': { type: 'boolean', default: false },
    'idle-ms': { type: 'string' },
    // How long a live arena waits for someone to join before standing down:
    // short when nothing is starting, long while Prism/Minecraft still is
    // (the very first launch downloads the whole game)
    'join-wait-ms': { type: 'string', default: '150000' },
    'launch-wait-ms': { type: 'string', default: '600000' },
  },
})

// The test switches only work with the test environment variable set, so the
// real daemon can never be pointed at another program to run as its server
if (args['fake-server'] && process.env.MC_PVP_BOTS_TESTING !== '1') {
  console.error('--fake-server needs MC_PVP_BOTS_TESTING=1')
  process.exit(2)
}

const dataDir = args.data
if (!dataDir) {
  console.error('--data is required')
  process.exit(2)
}
const controlPort = Number(args.port)
const serverPort = Number(args['server-port'])
const idleMs = args['idle-ms'] ? Number(args['idle-ms']) : Math.max(1, Number(args['idle-minutes'])) * 60_000
const leaseMs = Math.max(1000, Number(args['lease-ms']))
const joinWaitMs = Math.max(500, Number(args['join-wait-ms']))
const launchWaitMs = Math.max(joinWaitMs, Number(args['launch-wait-ms']))
const log = openLog(join(dataDir, 'daemon.log'))
const control = await readJson(join(dataDir, 'control.json'), {})
const token = control.token
if (!token) {
  console.error('control.json has no token; start the daemon through ctl.mjs')
  process.exit(2)
}

const state = {
  phase: 'booting', // booting | ready | error | stopping
  error: null,
  errorKind: null, // 'crashed' can be retried; the rest need /pvp setup
  paused: true,
  humans: new Set(),
  people: new Map(), // human name -> { mode: grace|fight|afk, until?, since?, shown? }
  kitted: new Set(),
  launchedAt: 0,
  pendingPlay: null,
  playedSincePause: false,
  handBackTimer: null,
  drop: { kills: 0, deaths: 0 },
  config: {
    bots: 8,
    difficulty: 'mixed',
    launcher: args.launcher === 'manual' ? 'manual' : 'prism',
    prismPath: args['prism-path'],
    prismData: args['prism-data'],
    graceMs: 3000,
    afkMs: 2000,
    closeGame: true,
  },
  lastRequestAt: Date.now(),
  restarts: 0,
  readyAt: 0,
  match: null, // the Claude Code session the leaderboard belongs to
  matchPending: false, // a new match waiting for the server to clear the board
  liveSince: 0,
  // Something the mod should tell the person, picked up by its next /status
  notice: null,
}

const server = new PaperServer({
  dataDir,
  command: args['fake-server'] ? [process.execPath, args['fake-server']] : null,
  log,
})
// What our own server's command line contains, to tell it from anything else
const OUR_SERVER = args['fake-server']
  ? new RegExp(escapeRegExp(args['fake-server']))
  : new RegExp(escapeRegExp(serverPaths(dataDir).jar))

let swarm = null

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function fail(message, kind = 'config') {
  state.phase = 'error'
  state.error = message
  state.errorKind = kind
  log('ERROR ' + message)
}

function isBot(name) {
  return swarm?.isBot(name) ?? false
}

function teleportRandom(name) {
  const p = arenaSpawnPoint()
  server.run(`tp ${name} ${p.x} ${p.y} ${p.z}`)
}

async function boot() {
  if (!args['no-bots']) {
    try {
      const libs = loadBotLibraries(join(dataDir, 'runtime'))
      swarm = new BotSwarm({
        libs,
        host: '127.0.0.1',
        port: serverPort,
        version: MC_VERSION,
        log,
        onBotSpawn: (name) => setTimeout(() => teleportRandom(name), 150),
      })
    } catch (err) {
      return fail(`bot libraries missing (${err.message}); run /pvp setup`)
    }
  }
  if (!args['fake-server']) {
    if (!existsSync(serverPaths(dataDir).jar)) return fail('Paper is not downloaded; run /pvp setup')
    if (!isEulaAccepted(dataDir)) return fail("Minecraft's EULA has not been accepted; run /pvp setup")
  }
  // A server orphaned by an earlier daemon would hold the port
  await stopStaleServer(dataDir, { pattern: OUR_SERVER, log })
  await writeServerConfig(dataDir, { serverPort })
  startServer()
}

function startServer() {
  state.phase = 'booting'
  server.start()
}

server.on('ready', async () => {
  server.runAll(arenaRuleCommands())
  if (!(await isArenaBuilt(dataDir))) {
    server.runAll(arenaBuildCommands())
    await markArenaBuilt(dataDir)
  }
  state.phase = 'ready'
  state.error = null
  state.errorKind = null
  state.readyAt = Date.now()
  log('arena ready')
  if (swarm) void swarm.setRoster(tierMix(state.config.bots, state.config.difficulty))
  const pending = state.pendingPlay
  state.pendingPlay = null
  // Only if the session that asked is still around: never pop Minecraft up
  // for a Claude Code that has since quit
  if (pending && Date.now() - state.lastRequestAt < leaseMs) {
    const r = await play(pending)
    // Nobody is waiting on this reply: hand any problem to the mod's next poll
    if (!r.ok) state.notice = r.error
  }
})

// ---- humans: grace countdown, fighting, AFK ------------------------------

function setPerson(name, next) {
  const prev = state.people.get(name)
  state.people.set(name, next)
  if (prev?.mode === next.mode) return
  if (next.mode === 'grace') {
    server.runAll(freezeHumanCommands(name))
  } else if (next.mode === 'fight') {
    server.runAll([...thawHumanCommands(name), ...titleCommands(name, 'FIGHT', `${swarm?.bots.size ?? 0} bots · free for all`, 'red')])
  } else if (next.mode === 'afk') {
    server.runAll([...freezeHumanCommands(name), ...titleCommands(name, 'AFK', 'Protected · move the camera to rejoin', 'gray')])
  }
  syncProtected()
  syncSwarm()
}

// Bots only fight while the arena is live AND someone is in it: nothing to
// burn CPU on, and no kills piling up while Minecraft is still loading
// ...and everything holds still during a 3-2-1: nobody, bot or human, moves
// on anyone until FIGHT
function syncSwarm() {
  if (!swarm) return
  const modes = [...state.people.values()].map((p) => p.mode)
  if (botsShouldFight({ paused: state.paused, humanCount: state.humans.size, modes })) swarm.resume()
  else swarm.pause()
}

function syncProtected() {
  const names = [...state.people].filter(([, s]) => isProtected(s)).map(([n]) => n)
  swarm?.setProtected(state.paused ? [...state.humans] : names)
}

function enterGrace(name, now = Date.now()) {
  const graceMs = state.config.graceMs
  setPerson(name, graceMs > 0 ? { mode: 'grace', until: now + graceMs } : { mode: 'fight', since: now })
}

function tickPeople(now) {
  if (state.paused || state.phase !== 'ready') return
  swarm?.observeHumans(now)
  const afkMs = state.config.afkMs > 0 ? state.config.afkMs : Infinity
  for (const name of state.humans) {
    const s = state.people.get(name)
    if (!s) {
      enterGrace(name, now)
      continue
    }
    const next = nextHumanState(s, { now, lastLookAt: swarm?.lastLookAt(name) ?? null, afkMs, graceMs: state.config.graceMs })
    if (next.mode === 'grace') {
      const left = countdownLeft(next, now)
      if (left > 0 && left !== next.shown) {
        server.runAll(titleCommands(name, String(left), 'Get ready · bots leave you alone until FIGHT', 'yellow'))
        next.shown = left
      }
    }
    if (next !== s) setPerson(name, next)
  }
}

server.on('join', ({ name }) => {
  if (!state.kitted.has(name)) {
    server.runAll(kitCommands(name))
    state.kitted.add(name)
  }
  if (isBot(name)) return
  state.humans.add(name)
  swarm?.setHumans(state.humans)
  teleportRandom(name)
  if (state.paused) {
    server.runAll(freezeHumanCommands(name))
    server.runAll(titleCommands(name, 'Paused', 'Fights start when Claude is working · or /pvp play'))
    server.runAll(statusBarCommands(...pausedBar))
    syncProtected()
  } else {
    enterGrace(name)
  }
  syncSwarm()
})

server.on('leave', ({ name }) => {
  state.people.delete(name)
  if (!state.humans.delete(name)) return
  swarm?.setHumans(state.humans)
  syncProtected()
  // They closed Minecraft: the next drop-in may launch it again right away
  state.launchedAt = 0
  // Nobody left to fight for: stop the bots instead of letting them brawl
  if (!state.paused && state.humans.size === 0) pause({ reason: 'done' })
  syncSwarm()
})

server.on('death', ({ name, killer }) => {
  const live = !state.paused
  if (state.humans.has(name)) {
    if (live) state.drop.deaths++
    // Respawn is immediate; move them off the shared spawn point
    setTimeout(() => teleportRandom(name), 300)
  }
  if (killer && state.humans.has(killer) && live) state.drop.kills++
})

server.on('error', (err) => fail(`could not start the Minecraft server: ${err.message} (is Java 21+ installed?)`))
server.on('bind-failed', () => fail(`port ${serverPort} is taken by another program; change serverPort in the mod's config`))
server.on('eula', () => fail("Minecraft's EULA has not been accepted; run /pvp setup"))

server.on('exit', ({ code, signal }) => {
  log(`server exited: code ${code} signal ${signal}`)
  // Bots would otherwise keep dialling a dead port
  swarm?.disconnectAll()
  state.humans.clear()
  state.people.clear()
  state.kitted.clear()
  if (state.phase === 'stopping') return
  // A server that ran a good while before dying gets a fresh set of restarts
  if (state.readyAt && Date.now() - state.readyAt > 120_000) state.restarts = 0
  state.readyAt = 0
  if (state.phase !== 'error' && state.restarts < 3) {
    state.restarts++
    state.phase = 'booting'
    setTimeout(() => {
      if (state.phase === 'booting' && !server.child) startServer()
    }, 3000)
  } else if (state.phase !== 'error') {
    fail('the Minecraft server keeps exiting; see server/logs/latest.log', 'crashed')
  }
})

// ---- requests ------------------------------------------------------------

function applyConfig(body) {
  const c = state.config
  if (body.bots !== undefined) c.bots = normalizeCount(body.bots)
  if (DIFFICULTIES.includes(body.difficulty)) c.difficulty = body.difficulty
  if (body.launcher === 'prism' || body.launcher === 'manual') c.launcher = body.launcher
  if (Number.isFinite(body.graceMs)) c.graceMs = Math.max(0, Math.min(10_000, body.graceMs))
  if (Number.isFinite(body.afkMs)) c.afkMs = Math.max(0, Math.min(60_000, body.afkMs))
  // Each Claude Code session is one match: a new one starts the leaderboard over
  if (typeof body.match === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(body.match) && body.match !== state.match) {
    state.match = body.match
    state.matchPending = true
  }
  if (typeof body.closeGame === 'boolean') c.closeGame = body.closeGame
}

async function play(body) {
  applyConfig(body)
  clearTimeout(state.handBackTimer) // back in before the hand-back fired
  state.handBackTimer = null
  if (state.phase === 'error' && state.errorKind === 'crashed' && !server.child) {
    log('retrying the server after a crash')
    state.restarts = 0
    startServer()
  }
  if (state.phase === 'booting') {
    state.pendingPlay = body
    return { ok: true, phase: 'booting' }
  }
  if (state.phase !== 'ready') return { ok: false, phase: state.phase, error: state.error }

  // Work out how the person gets in BEFORE anything goes live: an arena that
  // can't be joined must not start fighting for nobody
  const now = Date.now()
  let prism = null
  if (state.humans.size === 0 && state.config.launcher === 'prism' && now - state.launchedAt >= 90_000) {
    prism = findPrism({ override: state.config.prismPath, dataOverride: state.config.prismData })
    if (!prism) {
      return {
        ok: false,
        phase: 'ready',
        error: 'Prism Launcher was not found. Install it (winget install --exact PrismLauncher.PrismLauncher), add your account, then /pvp setup. Or set launcher to "manual" in /config.',
      }
    }
  }

  if (swarm) void swarm.setRoster(tierMix(state.config.bots, state.config.difficulty))
  if (state.matchPending) {
    state.matchPending = false
    server.runAll(['scoreboard players reset * kills', 'scoreboard players reset * deaths'])
  }
  state.paused = false
  state.liveSince = now
  state.playedSincePause = true
  state.drop = { kills: 0, deaths: 0 }
  for (const h of state.humans) enterGrace(h, now)
  server.runAll(hideStatusBarCommands())
  syncProtected()
  syncSwarm()

  if (state.humans.size > 0) {
    const focused = await focusGame()
    return { ok: true, phase: 'ready', inGame: true, focused }
  }
  if (state.config.launcher === 'manual') {
    return { ok: true, phase: 'ready', inGame: false, joinAddress: `127.0.0.1:${serverPort}` }
  }
  // A launch is already on its way
  if (!prism) return { ok: true, phase: 'ready', inGame: false, launching: true }
  try {
    await ensureInstance(prism.data, serverPort)
    launchClient(prism, serverPort, log)
    state.launchedAt = now
    return { ok: true, phase: 'ready', inGame: false, launching: true }
  } catch (err) {
    pause({ reason: 'done' })
    return { ok: false, phase: 'ready', error: `could not launch Minecraft: ${err.message}` }
  }
}

const PAUSE_TITLES = {
  permission: ['Claude needs your OK', 'Approve it, then you are back in'],
  question: ['Claude has a question', 'Answer it, then you are back in'],
  'needs-you': ['Claude needs you', 'Answer it, then you are back in'],
  aborted: ['Paused', 'Turn interrupted'],
  lost: ['Paused', 'Lost touch with Claude Code'],
  done: ["Claude's done", 'Back to your terminal'],
}

// What the banner says while paused, and its color
const PAUSE_BARS = {
  permission: ['⚠ Claude needs your permission · alt-tab to your terminal', 'red'],
  question: ['⚠ Claude has a question · alt-tab to your terminal', 'red'],
  'needs-you': ['⚠ Claude needs you · alt-tab to your terminal', 'red'],
  aborted: ['Paused · the turn was interrupted', 'yellow'],
  lost: ['Paused · lost touch with Claude Code', 'white'],
  done: ["✔ Claude's done · fights resume on the next long turn", 'green'],
  idle: ['Paused · fights start when Claude is working · or /pvp play', 'white'],
}
let pausedBar = PAUSE_BARS.idle

function pause(body = {}) {
  const wasLive = !state.paused
  state.paused = true
  state.pendingPlay = null
  state.people.clear()
  swarm?.pause()
  syncProtected()
  const reason = PAUSE_TITLES[body.reason] ? body.reason : 'done'
  const [title, sub] = PAUSE_TITLES[reason]
  for (const h of state.humans) server.runAll([...freezeHumanCommands(h), ...titleCommands(h, title, sub)])
  pausedBar = PAUSE_BARS[reason]
  if (state.humans.size > 0) server.runAll(statusBarCommands(...pausedBar))
  if (PAUSE_BARS[reason][1] === 'red') for (const h of state.humans) server.runAll(alertCommands(h))
  const drop = { ...state.drop }
  // Hand back only someone we pulled in, only if they're in the game, and
  // only when the mod asked (a lost lease has nobody to hand back to)
  const terminal = cleanTerminal(body.terminal)
  if (wasLive && state.playedSincePause && state.humans.size > 0 && terminal) {
    const delay = Math.max(0, Math.min(10_000, Number(body.handBackMs) || 0))
    clearTimeout(state.handBackTimer)
    state.handBackTimer = setTimeout(() => {
      state.handBackTimer = null
      if (state.paused) void focusTerminal(terminal)
    }, delay)
  }
  state.playedSincePause = false
  return { ok: true, drop, wasLive }
}

function status() {
  const notice = state.notice
  state.notice = null
  const waitingForSomeone = !state.paused && state.humans.size === 0
  return {
    ok: true,
    notice,
    launching: waitingForSomeone && state.config.launcher === 'prism' && Date.now() - state.launchedAt < 90_000,
    joinAddress: waitingForSomeone && state.config.launcher === 'manual' ? `127.0.0.1:${serverPort}` : undefined,
    phase: state.phase,
    error: state.error,
    // A drop-in queued behind the first boot is not a stand-down: report it
    // as live, or the mod gives up on it before the server is even up
    paused: state.paused && !state.pendingPlay,
    pending: !!state.pendingPlay,
    humans: [...state.humans],
    people: Object.fromEntries([...state.people].map(([n, s]) => [n, s.mode])),
    bots: swarm?.names ?? [],
    focusCap: swarm?.cap ?? 0,
    drop: state.drop,
    config: { bots: state.config.bots, difficulty: state.config.difficulty, launcher: state.config.launcher, graceMs: state.config.graceMs, afkMs: state.config.afkMs },
    serverPort,
  }
}

let shuttingDown = false
async function shutdown(why, { closeGame = state.config.closeGame } = {}) {
  if (shuttingDown) return
  shuttingDown = true
  log(`shutting down: ${why}`)
  state.phase = 'stopping'
  clearInterval(ticker)
  clearTimeout(state.handBackTimer)
  for (const h of state.humans) {
    server.run(`kick ${h} The arena closed (${why}). It reopens the next time Claude works.`)
  }
  swarm?.stop()
  // The Minecraft we launched goes too; never anyone else's
  const closing = closeGame && state.config.launcher === 'prism' ? closeOurClient().catch(() => false) : Promise.resolve(false)
  await Promise.all([server.stop(), closing])
  http.close()
  await writeFile(join(dataDir, 'control.json'), JSON.stringify({ ...control, pid: null })).catch(() => {})
  process.exit(0)
}

// Resolves the JSON body, {} when empty or not JSON, null when too big
function readBody(req) {
  return new Promise((resolve) => {
    let raw = ''
    let tooBig = false
    req.on('data', (c) => {
      if (tooBig) return
      raw += c
      if (raw.length > 16 * 1024) {
        tooBig = true
        raw = ''
        resolve(null)
      }
    })
    req.on('end', () => {
      try {
        const parsed = raw ? JSON.parse(raw) : {}
        resolve(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve(null))
  })
}

const TOKEN = Buffer.from(token)
function hasToken(req) {
  const given = Buffer.from(String(req.headers['x-arena-token'] ?? ''))
  return given.length === TOKEN.length && timingSafeEqual(given, TOKEN)
}

// A web page that rebinds its own domain to 127.0.0.1 still sends its own
// Host header; only requests addressed to us by IP or localhost get in
const HOSTS = new Set([`127.0.0.1:${controlPort}`, `localhost:${controlPort}`])

const http = createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { 'content-type': 'application/json' })
    res.end(JSON.stringify(obj))
  }
  if (!HOSTS.has(String(req.headers.host ?? '')) || !hasToken(req)) return send(403, { ok: false, error: 'forbidden' })
  if (req.method !== 'GET' && req.method !== 'POST') return send(405, { ok: false, error: 'method not allowed' })
  state.lastRequestAt = Date.now()
  const body = req.method === 'POST' ? await readBody(req) : {}
  if (body === null) {
    res.writeHead(413, { 'content-type': 'application/json', connection: 'close' })
    res.end(JSON.stringify({ ok: false, error: 'body too large' }))
    return void res.on('finish', () => req.destroy())
  }
  try {
    switch (req.url) {
      case '/health':
        return send(200, { ok: true, pid: process.pid, phase: state.phase })
      case '/status':
        return send(200, status())
      case '/play':
        return send(200, await play(body))
      case '/pause':
        return send(200, pause(body))
      case '/config':
        applyConfig(body)
        if (swarm && state.phase === 'ready') void swarm.setRoster(tierMix(state.config.bots, state.config.difficulty))
        return send(200, status())
      case '/stop':
        send(200, { ok: true })
        return void shutdown('asked to stop', { closeGame: typeof body.closeGame === 'boolean' ? body.closeGame : state.config.closeGame })
      default:
        return send(404, { ok: false, error: 'no such endpoint' })
    }
  } catch (err) {
    log(`request ${req.url} failed: ${err.stack ?? err}`)
    return send(500, { ok: false, error: String(err.message ?? err) })
  }
})

http.on('error', (err) => {
  log(`control port ${controlPort}: ${err.message}`)
  process.exit(3)
})

http.listen(controlPort, '127.0.0.1', () => {
  log(`daemon ${process.pid} listening on 127.0.0.1:${controlPort}`)
  void writeFile(join(dataDir, 'control.json'), JSON.stringify({ ...control, port: controlPort, pid: process.pid }))
  void boot()
})

let standDownCheck = null
let lastStandDownCheck = 0

// Four times a second: countdowns, AFK, the lease, idling out
const ticker = setInterval(() => {
  const now = Date.now()
  const quietFor = now - state.lastRequestAt
  if (!state.paused && quietFor > leaseMs) {
    log(`no word from Claude Code for ${Math.round(quietFor / 1000)} s; pausing`)
    pause({ reason: 'lost' })
  }
  // Minecraft never showed up (launch failed, closed at the menu): stand down,
  // unless Prism or the game is still starting (checked every 10 s at most)
  const waited = now - state.liveSince
  if (!state.paused && state.humans.size === 0 && waited > joinWaitMs && !standDownCheck && now - lastStandDownCheck > 10_000) {
    lastStandDownCheck = now
    standDownCheck = (waited < launchWaitMs ? clientStarting().catch(() => false) : Promise.resolve(false)).then((starting) => {
      standDownCheck = null
      if (starting || state.paused || state.humans.size > 0) return
      log('nobody joined; pausing')
      pause({ reason: 'done' })
    })
  }
  tickPeople(now)
  if (quietFor > idleMs) void shutdown(`idle for ${Math.round(idleMs / 60000)} min`)
}, 250)

for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => void shutdown(sig))
process.on('uncaughtException', (err) => log(`uncaught: ${err.stack ?? err}`))
process.on('unhandledRejection', (err) => log(`unhandled: ${err?.stack ?? err}`))
