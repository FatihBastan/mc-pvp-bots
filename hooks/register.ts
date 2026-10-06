// mc-pvp-bots: drops you into a local Minecraft free-for-all against bots while
// Claude works, and hands you back the moment it's done or needs you.
//
// The game side (Paper server, bots, launching Minecraft, switching windows)
// is a small Node daemon in ../arena; this module decides WHEN, and talks to
// it over HTTP on 127.0.0.1.

import type { EngineInterface, PluginOptions, Register } from 'claude-code'

type Api = EngineInterface

type Config = {
  bots: number
  difficulty: string
  dropInMs: number
  handBackMs: number
  graceMs: number
  afkMs: number
  switchWindows: boolean
  closeMinecraft: boolean
  launcher: string
  prismPath: string
  idleMinutes: number
  serverPort: number
  controlPort: number
}

type Drop = { kills: number; deaths: number }
type Terminal = { bundleId?: string; windowId?: string; termProgram?: string; pid?: string }

// What ctl.mjs and the daemon answer
type Reply = {
  ok?: boolean
  error?: string
  phase?: string
  port?: number
  token?: string
  inGame?: boolean
  launching?: boolean
  joinAddress?: string
  drop?: Drop
  wasLive?: boolean
  wasRunning?: boolean
  notice?: string | null
  paused?: boolean
  humans?: string[]
  bots?: string[]
  focusCap?: number
  done?: boolean
  step?: string
  detail?: string
  warnings?: string[]
  parent?: number
}

const USAGE = '/pvp [on | off | setup | status | play | stop | bots 4|6|8 | difficulty mixed|easy|medium|hard]'
const ASKS_USER = new Set(['AskUserQuestion', 'ExitPlanMode'])
// Notifications that mean Claude is blocked on you. Not idle_prompt: that
// one fires when Claude has simply been waiting a while, e.g. while you play
// after /pvp play, and must not pull you out of a fight
const PROMPT_NOTIFICATION = /^(permission_prompt|elicitation(_url)?_dialog|needs_input)$/

// Module state. A hot reload resets it; what must survive lives in $.store.
let config: Config
let isOn = false
let isSetUp = false
let dataDir = ''
let terminal: Terminal = {}
// idle: not in the arena · waiting: turn running, drop-in timer armed · playing
let phase: 'idle' | 'waiting' | 'playing' = 'idle'
let isTurnRunning = false
let dropTimer: { cancel(): void } | null = null
let scoreTimer: { cancel(): void } | null = null
let drop: Drop = { kills: 0, deaths: 0 }
let conn: { port: number; token: string } | null = null
let starting: Promise<boolean> | null = null
let isSettingUp = false
// Tool calls under way, newest last (a permission dialog belongs to one of
// them), and the one whose dialog pulled you out, to spot when it's answered
const running: { id: string; tool: string }[] = []
let awaitingToolUseId: string | null = null
// Pulled out of a fight to answer Claude: once answered you go straight back
// in (the arena's 3-2-1 countdown follows). The short wait absorbs a turn
// that ends right after your answer, so you aren't flicked in and out.
const RESUME_MS = 1500
let resumeOnAnswer = false

function readConfig(options: PluginOptions, overrides: { bots?: unknown; difficulty?: unknown }): Config {
  const num = (v: unknown, d: number, min: number, max: number) => {
    const n = Number(v)
    return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : d
  }
  const bots = Number(overrides.bots ?? options.bots ?? 8)
  return {
    bots: [4, 6, 8].includes(bots) ? bots : 8,
    difficulty: String(overrides.difficulty ?? options.difficulty ?? 'mixed'),
    dropInMs: num(options.dropInSeconds, 10, 0, 300) * 1000,
    handBackMs: num(options.handBackSeconds, 2, 0, 10) * 1000,
    graceMs: num(options.graceSeconds, 3, 0, 10) * 1000,
    afkMs: num(options.afkSeconds, 2, 0, 60) * 1000,
    switchWindows: options.switchWindows !== false,
    closeMinecraft: options.closeMinecraft !== false,
    launcher: options.launcher === 'manual' ? 'manual' : 'prism',
    prismPath: typeof options.prismPath === 'string' ? options.prismPath : '',
    idleMinutes: num(options.idleMinutes, 15, 1, 240),
    serverPort: num(options.serverPort, 25599, 1024, 65535),
    controlPort: num(options.controlPort, 25601, 1024, 65535),
  }
}

function ctlPath($: Api) {
  return `${$.plugin.root}/arena/ctl.mjs`
}

function ctlArgs() {
  return [
    '--data', dataDir,
    '--port', String(config.controlPort),
    '--server-port', String(config.serverPort),
    '--idle-minutes', String(config.idleMinutes),
    '--launcher', config.launcher,
    '--prism-path', config.prismPath,
  ]
}

function lastJson(text: string): Reply | null {
  const lines = text.trim().split('\n').filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(lines[i]!) as Reply
    } catch {}
  }
  return null
}

// Starts the daemon if it isn't running. Cheap when it is.
function ensureDaemon($: Api): Promise<boolean> {
  if (!dataDir) return Promise.resolve(false)
  starting ??= (async () => {
    try {
      const ran = await $.process.run(['node', ctlPath($), 'ensure', ...ctlArgs()], { timeoutMs: 20_000 })
      const reply = lastJson(ran.stdout)
      if (!reply?.ok || !reply.token || !reply.port) {
        $.ui.log(reply?.error ?? (ran.stderr.trim() || 'the arena did not start'), { to: 'debug' })
        conn = null
        return false
      }
      conn = { port: reply.port, token: reply.token }
      // ctl's parent is Claude Code itself: the arena walks up from it to the
      // window to hand you back to
      const parent = String(reply.parent ?? '')
      if (/^[1-9]\d{0,9}$/.test(parent)) terminal = { ...terminal, pid: parent }
      return true
    } catch (error) {
      $.ui.log(`could not run node (${String(error)})`, { to: 'debug' })
      conn = null
      return false
    } finally {
      starting = null
    }
  })()
  return starting
}

async function api($: Api, path: string, body?: object): Promise<Reply | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!conn && !(await ensureDaemon($))) return null
    try {
      const res = await $.http.fetch(`http://127.0.0.1:${conn!.port}${path}`, { method: body ? 'POST' : 'GET', headers: { 'x-arena-token': conn!.token, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
      return JSON.parse(res.text) as Reply
    } catch {
      // The daemon idled out or crashed: start it again once
      conn = null
    }
  }
  return null
}

// On the way out of the session: one direct call, no restart of the daemon
async function sendPause($: Api, to: { port: number; token: string }) {
  try {
    await $.http.fetch(`http://127.0.0.1:${to.port}/pause`, { method: 'POST', headers: { 'x-arena-token': to.token, 'content-type': 'application/json' }, body: JSON.stringify({ reason: 'lost' }) })
  } catch {
    // The arena is already gone; it pauses by itself once check-ins stop
  }
}

const ON_STATUS = '⚔ pvp on'

// What the arena is doing, in the status line until you're in the game
function showProgress($: Api, s: Reply | null) {
  if (!s) return
  if (s.humans && s.humans.length > 0) $.ui.status('⚔ in the arena')
  else if (s.phase === 'booting') $.ui.status('⚔ arena warming up (the first boot takes a minute)…')
  else if (s.launching) $.ui.status('⚔ starting Minecraft…')
  else if (s.joinAddress) $.ui.status(`⚔ join ${s.joinAddress} in Minecraft 1.21.4`)
  else if (s.inGame) $.ui.status('⚔ in the arena')
  else if (s.phase === 'ready') $.ui.status('⚔ waiting for Minecraft to join…')
}

function playBody() {
  return {
    bots: config.bots,
    difficulty: config.difficulty,
    launcher: config.launcher,
    graceMs: config.graceMs,
    afkMs: config.afkMs,
    closeGame: config.closeMinecraft,
  }
}

function scoreText(d: Drop) {
  return `${d.kills} ${d.kills === 1 ? 'kill' : 'kills'}, ${d.deaths} ${d.deaths === 1 ? 'death' : 'deaths'}`
}

function redraw($: Api) {
  $.ui.invalidate('ui.render')
}

function cancelTimers() {
  dropTimer?.cancel()
  dropTimer = null
  scoreTimer?.cancel()
  scoreTimer = null
}

// The call a permission dialog is for: the newest one under way with that tool
function callFor(tool: string): string | null {
  for (let i = running.length - 1; i >= 0; i--) {
    if (running[i]!.tool === tool) return running[i]!.id || null
  }
  return null
}

// Claude carries on after a dialog you answered (or any tool call ended)
function resumeAfterAnswer($: Api) {
  if (!resumeOnAnswer) return armDropIn($)
  resumeOnAnswer = false
  armDropIn($, RESUME_MS)
}

function armDropIn($: Api, delayMs = config.dropInMs) {
  if (!isOn || !isSetUp || !isTurnRunning || phase !== 'idle') return
  phase = 'waiting'
  dropTimer = $.clock.after(delayMs, () => void dropIn($))
}

async function dropIn($: Api) {
  if (phase !== 'waiting') return
  dropTimer = null
  phase = 'playing'
  drop = { kills: 0, deaths: 0 }
  redraw($)
  // The session's id names the match: a new Claude Code session gets a fresh leaderboard
  const match = await $.session.id().catch(() => '')
  const reply = await api($, '/play', { ...playBody(), ...(match ? { match } : {}) })
  // Claude may have finished while we waited on the daemon
  if (phase !== 'playing') return
  if (!reply?.ok) {
    phase = 'idle'
    redraw($)
    $.ui.status(isOn ? ON_STATUS : undefined)
    $.ui.log(`⚔ ${reply?.error ?? "couldn't reach the arena"}`)
    return
  }
  showProgress($, reply)
  // Every 4 s: the live score for the spinner, and the arena's lease. If
  // these stop (Claude Code quit or crashed), the arena pauses by itself.
  scoreTimer = $.clock.every(4000, async () => {
    if (phase !== 'playing') return
    const s = await api($, '/status')
    // Something went wrong after /play answered (a launch that needed the
    // arena to finish booting first): say so where it stays visible
    if (s?.notice) $.ui.log(`⚔ ${s.notice}`)
    if (s?.paused) {
      // It stood down on its own: you closed Minecraft, or it never came up.
      // Back to waiting; the next tool call drops you in again.
      cancelTimers()
      phase = 'idle'
      $.ui.status(isOn ? ON_STATUS : undefined)
      redraw($)
      return
    }
    showProgress($, s)
    if (s?.drop && (s.drop.kills !== drop.kills || s.drop.deaths !== drop.deaths)) {
      drop = s.drop
      redraw($)
    }
  })
}

// Claude is done, was interrupted, or needs the person
type PullReason = 'done' | 'aborted' | 'permission' | 'question' | 'needs-you'
const NEEDS_YOU = new Set<PullReason>(['permission', 'question', 'needs-you'])

async function pullOut($: Api, reason: PullReason) {
  const was = phase
  cancelTimers()
  phase = 'idle'
  // Only someone taken out of a fight gets put straight back after answering;
  // before the first drop-in the usual delay still applies
  if (NEEDS_YOU.has(reason)) resumeOnAnswer = resumeOnAnswer || was === 'playing'
  if (was !== 'playing') return
  $.ui.status(isOn ? ON_STATUS : undefined)
  redraw($)
  const reply = await api($, '/pause', {
    reason,
    handBackMs: config.handBackMs,
    terminal: config.switchWindows ? terminal : null,
  })
  const d = reply?.drop ?? drop
  if (reply?.wasLive && (d.kills > 0 || d.deaths > 0)) {
    $.ui.toast(`${NEEDS_YOU.has(reason) ? 'Claude needs you' : "Claude's done"} · ⚔ ${scoreText(d)}`)
  }
}

// Stops the daemon, its server and bots, and (if set) the Minecraft it launched
async function stopArena($: Api): Promise<boolean> {
  const ran = await $.process.run(['node', ctlPath($), 'stop', ...ctlArgs(), ...(config.closeMinecraft ? [] : ['--keep-game'])]).catch(() => null)
  conn = null
  return lastJson(ran?.stdout ?? '')?.wasRunning === true
}

async function runSetup($: Api, acceptEula: boolean) {
  if (isSettingUp) return
  if (!dataDir) {
    $.ui.log('⚔ needs HOME (or USERPROFILE) set to know where to keep its files.')
    return
  }
  isSettingUp = true
  $.ui.status('⚔ setting up the arena…')
  let final: Reply | null = null
  let errText = ''
  try {
    const stream = $.process.spawn({
      argv: ['node', ctlPath($), 'setup', ...ctlArgs(), ...(acceptEula ? ['--accept-eula'] : [])],
    })
    let pending = ''
    for await (const { stream: pipe, text } of stream) {
      if (pipe === 'stderr') {
        errText = (errText + text).slice(-600)
        continue
      }
      const lines = (pending + text).split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) {
        const msg = lastJson(line)
        if (!msg) continue
        if (msg.done) final = msg
        else if (msg.detail) $.ui.status(`⚔ setup: ${msg.detail}`)
      }
    }
    if (!final && pending) final = lastJson(pending)
  } catch (error) {
    errText = `could not run node: ${String(error)}. The arena needs Node 20+ on your PATH.`
  } finally {
    isSettingUp = false
  }

  if (!final?.ok) {
    $.ui.status(undefined)
    const why = final?.error ?? (errText.trim() || 'setup stopped')
    $.ui.log(`setup failed: ${why}`)
    $.ui.toast(`⚔ Setup failed: ${why}`, { timeoutMs: 10_000 })
    return
  }
  isSetUp = true
  await $.store.set('isSetUp', true)
  for (const w of final.warnings ?? []) $.ui.log(`⚔ ${w}`)
  $.ui.status('⚔ first boot of the arena (about a minute, once)…')
  // First boot builds the world: do it now, not during your first fight
  const finish = (error?: string) => {
    $.ui.status(isOn ? '⚔ pvp on' : undefined)
    if (error) $.ui.toast(`⚔ The arena didn't start: ${error}`, { timeoutMs: 10_000 })
    else $.ui.toast(isOn ? '⚔ Arena ready. You drop in once Claude has worked for a bit.' : '⚔ Arena ready. /pvp on to start dropping in.', { timeoutMs: 6000 })
  }
  if (!(await ensureDaemon($))) return finish(`see ${dataDir}/daemon.out`)
  let polls = 0
  const poll = $.clock.every(1500, async () => {
    const s = await api($, '/status')
    if (s?.phase === 'ready' || s?.phase === 'error' || ++polls > 120) {
      poll.cancel()
      finish(s?.phase === 'ready' ? undefined : (s?.error ?? 'it is still booting; check /pvp status'))
    }
  })
}

const EULA_QUESTION = "The arena runs a Minecraft server on your machine, which needs you to accept Minecraft's EULA (aka.ms/MinecraftEULA). Do you accept it?"

async function askEula($: Api): Promise<boolean> {
  let answer = 'Cancel'
  try {
    answer = await $.ui.ask(EULA_QUESTION, ['I accept the EULA', 'Cancel'])
  } catch {
    // Dismissed, or nobody there to ask: nothing is accepted
  }
  return answer === 'I accept the EULA'
}

export const register: Register = (on, options) => {
  // Overrides from /pvp bots and /pvp difficulty are read in session.start
  config = readConfig(options, {})

  on('session.start', async ($, e, next) => {
    isOn = (await $.store.get('isOn')) === true
    isSetUp = (await $.store.get('isSetUp')) === true
    config = readConfig(options, { bots: await $.store.get('bots'), difficulty: await $.store.get('difficulty') })
    // Never fall back to a relative folder: that would put a server and its
    // world inside whatever project Claude Code was opened in
    const home = (await $.env.get('HOME')) || (await $.env.get('USERPROFILE')) || ''
    dataDir = home ? `${home}/.claude-pvp` : ''
    terminal = {
      bundleId: await $.env.get('__CFBundleIdentifier'),
      windowId: await $.env.get('WINDOWID'),
      termProgram: await $.env.get('TERM_PROGRAM'),
    }
    await $.command.register({
      name: 'pvp',
      description: 'Minecraft PvP vs bots while Claude works',
      argumentHint: '[on|off|setup|status|play|stop|bots N|difficulty D]',
    })
    if (isOn && e.isInteractive) $.ui.status('⚔ pvp on')
    return next(e)
  })

  on('command.run', { command: 'pvp' }, async ($, e) => {
    const [word = '', value = ''] = e.args.trim().toLowerCase().split(/\s+/)
    switch (word) {
      case 'on': {
        isOn = true
        await $.store.set('isOn', true)
        if (!isSetUp) {
          const accepted = await askEula($)
          if (!accepted) return { text: 'The EULA needs accepting to run a server. Nothing was installed.' }
          void runSetup($, true)
          return { text: 'On. Setting up first (Node packages, Paper server, Prism instance); progress is in the status line.' }
        }
        $.ui.status('⚔ pvp on')
        $.clock.after(0, () => void ensureDaemon($))
        return { text: `On: ${config.bots} bots, ${config.difficulty}. You drop in after ${config.dropInMs / 1000}s of Claude working.` }
      }
      case 'off': {
        isOn = false
        await $.store.set('isOn', false)
        cancelTimers()
        phase = 'idle'
        $.ui.status(undefined)
        // Off means nothing keeps running: server, bots, and our Minecraft
        const stopped = await stopArena($)
        return { text: `Off${stopped ? '; the arena and its Minecraft are closed' : ''}.` }
      }
      case 'setup': {
        const accepted = await askEula($)
        if (!accepted) return { text: 'Setup cancelled; nothing was installed.' }
        void runSetup($, true)
        return { text: 'Setting up the arena; progress is in the status line.' }
      }
      case 'play': {
        if (!isSetUp) return { text: 'Run /pvp setup first.' }
        cancelTimers()
        phase = 'waiting'
        void dropIn($)
        return { text: 'Dropping you in.' }
      }
      case 'stop': {
        cancelTimers()
        phase = 'idle'
        return { text: (await stopArena($)) ? 'Arena stopped.' : 'The arena was not running.' }
      }
      case 'bots': {
        const n = Number(value)
        if (![4, 6, 8].includes(n)) return { text: 'Bots: 4, 6 or 8.' }
        await $.store.set('bots', n)
        config = { ...config, bots: n }
        if (conn) await api($, '/config', { bots: n })
        return { text: `${n} bots from the next drop-in.` }
      }
      case 'difficulty': {
        if (!['mixed', 'easy', 'medium', 'hard'].includes(value)) return { text: 'Difficulty: mixed, easy, medium or hard.' }
        await $.store.set('difficulty', value)
        config = { ...config, difficulty: value }
        if (conn) await api($, '/config', { difficulty: value })
        return { text: `Bots are ${value} from the next drop-in.` }
      }
      case '':
      case 'status': {
        const lines = [
          `${isOn ? 'On' : 'Off'}${isSetUp ? '' : ' (not set up: /pvp setup)'}.`,
          `${config.bots} bots, ${config.difficulty} · drop in after ${config.dropInMs / 1000}s · launcher ${config.launcher}`,
        ]
        if (conn || isSetUp) {
          const s = conn ? await api($, '/status') : null
          if (s?.ok) {
            const state = s.error ? `: ${s.error}` : s.phase !== 'ready' ? '' : s.paused ? ', paused (fights start when Claude works, or /pvp play)' : ', live'
            lines.push(`Arena ${s.phase}${state} · bots online ${s.bots?.length ?? 0} · max ${s.focusCap} on you at once · in game: ${s.humans?.join(', ') || 'nobody'}`)
          } else {
            lines.push('Arena not running (it starts on the next long turn).')
          }
        }
        lines.push(USAGE)
        return { text: lines.join('\n') }
      }
      default:
        return { text: USAGE }
    }
  })

  on('turn.start', async ($, e, next) => {
    isTurnRunning = true
    resumeOnAnswer = false
    if (isOn && isSetUp) {
      // Warm the arena now so the drop-in is instant; off the turn's path
      if (!conn) $.clock.after(0, () => void ensureDaemon($))
      armDropIn($)
    }
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) return next(e)
    isTurnRunning = false
    resumeOnAnswer = false
    await pullOut($, e.isAborted ? 'aborted' : 'done')
    return next(e)
  })

  // A permission dialog is about to show, so Claude is waiting on you: the
  // fight freezes (in the background, so the dialog isn't held up). Decides
  // nothing: the request goes on unchanged, and Claude Code, your settings
  // and you answer it. If a settings hook of yours answers instead, the call
  // simply carries on and you're back in a moment later.
  on('classic.PermissionRequest', async ($, e, next) => {
    awaitingToolUseId = callFor(e.tool_name)
    pullOut($, 'permission').catch(() => undefined)
    return next(e)
  })

  // You approved and the command is still running: Claude Code shows its
  // "ctrl+b to run in background" hint under long-running calls. That's the
  // first sign the dialog is answered, so go back in right away, not only
  // when the command finishes.
  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) => {
    if (e.props.tool_use_id === awaitingToolUseId) {
      awaitingToolUseId = null
      resumeAfterAnswer($)
    }
    return next(e)
  })

  // Only watches: every call goes on to Claude Code unchanged and its result
  // comes back unchanged. A question to you freezes the fight first, and a
  // call that ends (answered, or just finished) puts you back in.
  on('tool.call', async ($, e, next) => {
    // Our own EULA question is not Claude needing you
    if (next.origin.plugin === 'mc-pvp-bots') return next(e)
    if (ASKS_USER.has(e.tool)) await pullOut($, 'question')
    const call = { id: e.tool_use_id ?? '', tool: e.tool }
    running.push(call)
    try {
      return await next(e)
    } finally {
      running.splice(running.indexOf(call), 1)
      if (call.id && call.id === awaitingToolUseId) awaitingToolUseId = null
      resumeAfterAnswer($)
    }
  })

  // An MCP form you filled in: Claude carries on
  on('classic.ElicitationResult', async ($, e, next) => {
    const result = await next(e)
    resumeAfterAnswer($)
    return result
  })

  on('classic.Notification', async ($, e, next) => {
    if (PROMPT_NOTIFICATION.test(e.notification_type)) {
      await pullOut($, e.notification_type === 'permission_prompt' ? 'permission' : 'question')
    }
    return next(e)
  })

  // Leaving Claude Code mid-fight (/exit, Ctrl+C, closing the terminal):
  // freeze the arena now. If this never runs (a crash, kill -9), the arena
  // still pauses once the 4-second check-ins stop.
  on('session.end', async ($, e, next) => {
    if (phase === 'playing' && conn) {
      cancelTimers()
      phase = 'idle'
      await sendPause($, conn)
    }
    return next(e)
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    if (phase !== 'playing') return next(e)
    const score = drop.kills || drop.deaths ? ` · ⚔ ${drop.kills}K ${drop.deaths}D` : ' · ⚔ in the arena'
    return next({ ...e, props: { ...e.props, suffix: score } })
  })
}
