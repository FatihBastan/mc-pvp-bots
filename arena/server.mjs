// The local Paper server: download, config, process, console and log parsing.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { createWriteStream, existsSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stopIfMatches } from './proc.mjs'

// Pinned on purpose: commands, gamerule names and text-component syntax all
// changed in later versions, and mineflayer + pathfinder are best tested here.
export const MC_VERSION = '1.21.4'
// PaperMC's download service asks every client to identify itself with a
// contact. A fork should put its own repo here.
export const USER_AGENT = 'mc-pvp-bots/0.1.0 (+https://github.com/FatihBastan/mc-pvp-bots)'

const PAPER_BUILDS = `https://fill.papermc.io/v3/projects/paper/versions/${MC_VERSION}/builds`

const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g
const NAME = '([A-Za-z0-9_]{3,16})'
const LINE_BODY = /^\[[^\]]*\]\s*:?\s*(.*)$/ // strips "[12:00:00 INFO]: "

// The server runs under this tiny sh watcher (macOS, Linux). It forwards the
// console, reports the server's pid, and stops the server if the daemon dies
// in any way, kill -9 included, so a JVM is never left holding the port.
//   $1 = the daemon's pid, $2... = the server's command
const GUARD = [
  'parent=$1; shift',
  'exec 3<&0', // keep the console: a background job's stdin is /dev/null otherwise
  '"$@" <&3 3<&- &',
  'srv=$!',
  'echo "@pid $srv" >&2',
  "trap 'kill -TERM $srv 2>/dev/null' TERM INT HUP",
  'while kill -0 "$srv" 2>/dev/null; do',
  '  if ! kill -0 "$parent" 2>/dev/null; then',
  '    kill -TERM "$srv" 2>/dev/null', // Paper saves and stops on SIGTERM
  '    i=0; while kill -0 "$srv" 2>/dev/null && [ $i -lt 30 ]; do sleep 1; i=$((i+1)); done',
  '    kill -KILL "$srv" 2>/dev/null',
  '    break',
  '  fi',
  '  sleep 2',
  'done',
  'wait "$srv"',
].join('\n')

export function serverPaths(dataDir) {
  const dir = join(dataDir, 'server')
  return { dir, jar: join(dir, 'paper.jar'), eula: join(dir, 'eula.txt'), marker: join(dir, 'arena-built-v1'), pid: join(dir, 'server.pid') }
}

// A server left behind by a daemon that died without stopping it (killed,
// crashed, machine slept badly) still holds the port and a gigabyte of RAM.
// Its pid file outlives it; stop it before starting a new one.
export async function stopStaleServer(dataDir, { pattern = /paper\.jar/, log = () => {} } = {}) {
  const { pid: pidFile } = serverPaths(dataDir)
  const pid = Number(await readFile(pidFile, 'utf8').catch(() => '0'))
  if (pid > 0) {
    const stopped = await stopIfMatches(pid, pattern, { graceMs: 15000 })
    log(stopped ? `stopped a leftover server (pid ${pid})` : `pid ${pid} is not our server; left alone`)
  }
  await rm(pidFile, { force: true })
}

export async function ensurePaper(dataDir, log = () => {}) {
  const { dir, jar } = serverPaths(dataDir)
  if (existsSync(jar)) return jar
  await mkdir(dir, { recursive: true })
  log(`fetching Paper ${MC_VERSION} build list`)
  const res = await fetch(PAPER_BUILDS, { headers: { 'User-Agent': USER_AGENT } })
  if (!res.ok) throw new Error(`Paper build list: HTTP ${res.status}`)
  const builds = await res.json()
  const build = builds.find((b) => b.channel === 'STABLE') ?? builds[0]
  const download = build?.downloads?.['server:default']
  if (!download?.url) throw new Error('Paper build list had no download')
  log(`downloading Paper build ${build.id}`)
  const jarRes = await fetch(download.url, { headers: { 'User-Agent': USER_AGENT } })
  if (!jarRes.ok) throw new Error(`Paper download: HTTP ${jarRes.status}`)
  const bytes = Buffer.from(await jarRes.arrayBuffer())
  const sha = createHash('sha256').update(bytes).digest('hex')
  // No published checksum, no install: never run a jar we can't check
  const expected = download.checksums?.sha256
  if (typeof expected !== 'string' || !/^[0-9a-f]{64}$/i.test(expected)) throw new Error('Paper build list had no checksum')
  if (expected.toLowerCase() !== sha) throw new Error('Paper download failed its checksum')
  if (!/^https:\/\//.test(download.url)) throw new Error('Paper download is not https')
  await writeFile(jar + '.part', bytes)
  await rename(jar + '.part', jar)
  return jar
}

export async function writeServerConfig(dataDir, { serverPort }) {
  const { dir } = serverPaths(dataDir)
  await mkdir(dir, { recursive: true })
  // A void world: the only blocks are the arena we build
  const props = {
    'server-ip': '127.0.0.1', // nobody but this machine can join
    'server-port': String(serverPort),
    'online-mode': 'false', // bots have no Mojang accounts; safe because it only listens on localhost
    'enforce-secure-profile': 'false',
    'level-name': 'arena',
    'level-type': 'minecraft\\:flat',
    'generator-settings': '{"layers":[{"block":"minecraft:air","height":1}],"biome":"minecraft:the_void"}',
    'generate-structures': 'false',
    'allow-nether': 'false',
    'spawn-monsters': 'false',
    'spawn-protection': '0',
    'max-players': '24',
    'view-distance': '4',
    'simulation-distance': '4',
    'network-compression-threshold': '-1', // localhost: compressing just burns CPU
    'sync-chunk-writes': 'false',
    difficulty: 'normal',
    gamemode: 'survival',
    'force-gamemode': 'true',
    pvp: 'true',
    'enable-command-block': 'false',
    'enable-rcon': 'false',
    'enable-query': 'false',
    motd: 'Claude PvP arena',
  }
  const text = Object.entries(props).map(([k, v]) => `${k}=${v}`).join('\n') + '\n'
  await writeFile(join(dir, 'server.properties'), text)
  // Bukkit refuses a second login from one IP within 4 s by default, and all
  // the bots log in from 127.0.0.1. Bukkit fills in every other default.
  const bukkit = join(dir, 'bukkit.yml')
  if (!existsSync(bukkit)) await writeFile(bukkit, 'settings:\n  connection-throttle: -1\n')
  // Paper reports server stats (a server id, OS, Java version, player
  // counts) to bStats.org unless this file says not to. Nothing here should
  // leave the machine.
  await mkdir(join(dir, 'plugins', 'bStats'), { recursive: true })
  await writeFile(
    join(dir, 'plugins', 'bStats', 'config.yml'),
    'enabled: false\nserverUuid: 00000000-0000-0000-0000-000000000000\nlogFailedRequests: false\n',
  )
}

export async function acceptEula(dataDir) {
  const { dir, eula } = serverPaths(dataDir)
  await mkdir(dir, { recursive: true })
  await writeFile(eula, `# Accepted by the user through /pvp setup (https://aka.ms/MinecraftEULA)\neula=true\n`)
}

export function isEulaAccepted(dataDir) {
  const { eula } = serverPaths(dataDir)
  return existsSync(eula)
}

// Parses one console line into an event, or null
export function parseLine(raw) {
  const line = raw.replace(ANSI, '').replace(/\r$/, '').replace(/^>\s*/, '')
  const body = (LINE_BODY.exec(line)?.[1] ?? line).trim()
  if (/^Done \([\d.,]+s\)!/.test(body)) return { type: 'ready' }
  let m = new RegExp(`^${NAME} joined the game$`).exec(body)
  if (m) return { type: 'join', name: m[1] }
  m = new RegExp(`^${NAME} left the game$`).exec(body)
  if (m) return { type: 'leave', name: m[1] }
  m = new RegExp(`^${NAME} has (-?\\d+) \\[(\\w+)\\]$`).exec(body)
  if (m) return { type: 'score', name: m[1], value: Number(m[2]), objective: m[3] }
  m = new RegExp(`^${NAME} (was slain by|was shot by|was killed by|was knocked into the void by|didn't want to live in the same world as) ${NAME}`).exec(body)
  if (m) return { type: 'death', name: m[1], killer: m[3] }
  m = new RegExp(`^${NAME} (died|fell|was|drowned|burned|went|tried|walked|suffocated|starved|blew|hit|experienced|froze|withered)\\b`).exec(body)
  if (m) return { type: 'death', name: m[1], killer: null }
  if (/Failed to bind to port|\*\*\*\* FAILED TO BIND/.test(body)) return { type: 'bind-failed' }
  if (/You need to agree to the EULA/.test(body)) return { type: 'eula' }
  return null
}

export class PaperServer extends EventEmitter {
  constructor({ dataDir, javaPath = 'java', memoryMb = 1024, command = null, log = () => {} }) {
    super()
    this.dataDir = dataDir
    this.javaPath = javaPath
    this.memoryMb = memoryMb
    // Tests swap in a fake server: [executable, ...args]
    this.command = command
    this.log = log
    this.child = null
    this.ready = false
    this.pending = []
  }

  start() {
    const { dir, jar } = serverPaths(this.dataDir)
    const argv = this.command ?? [
      this.javaPath,
      `-Xms${Math.min(512, this.memoryMb)}M`,
      `-Xmx${this.memoryMb}M`,
      '-XX:+UseG1GC',
      '-jar',
      jar,
      '--nogui',
    ]
    const pidFile = serverPaths(this.dataDir).pid
    this.serverPid = null
    const recordPid = (pid) => {
      this.serverPid = pid
      try {
        writeFileSync(pidFile, String(pid))
      } catch {}
    }
    if (process.platform === 'win32') {
      // No watcher on Windows: a server orphaned by a killed daemon is
      // stopped through its pid file the next time the daemon starts
      this.child = spawn(argv[0], argv.slice(1), { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
      if (this.child.pid) recordPid(this.child.pid)
    } else {
      this.child = spawn('/bin/sh', ['-c', GUARD, 'mc-pvp-bots-guard', String(process.pid), ...argv], { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] })
    }
    let buffered = ''
    const onData = (chunk) => {
      buffered += chunk.toString('utf8')
      const lines = buffered.split('\n')
      buffered = lines.pop() ?? ''
      for (const line of lines) this.#handle(line)
    }
    this.child.stdout.on('data', onData)
    this.child.stderr.on('data', (c) => {
      for (const line of c.toString('utf8').split('\n')) {
        const m = /^@pid (\d+)$/.exec(line.trim())
        if (m) recordPid(Number(m[1]))
        else if (line.trim()) this.log('[server stderr] ' + line.trimEnd())
      }
    })
    this.child.on('exit', (code, signal) => {
      try {
        unlinkSync(pidFile)
      } catch {}
      this.ready = false
      this.child = null
      this.serverPid = null
      this.emit('exit', { code, signal })
    })
    this.child.on('error', (err) => this.emit('error', err))
  }

  #handle(line) {
    const event = parseLine(line)
    // Paper keeps its own full log in server/logs; ours keeps what matters
    if (event || /WARN|ERROR|Exception/.test(line)) this.log('[server] ' + line)
    if (!event) return
    if (event.type === 'ready') this.ready = true
    // Answer queries waiting on this kind of line
    for (const q of [...this.pending]) {
      if (q.match(event)) {
        this.pending.splice(this.pending.indexOf(q), 1)
        clearTimeout(q.timer)
        q.resolve(event)
      }
    }
    this.emit(event.type, event)
  }

  run(command) {
    if (!this.child?.stdin.writable) return false
    this.child.stdin.write(command + '\n')
    return true
  }

  runAll(commands) {
    for (const c of commands) this.run(c)
  }

  // Runs a command and resolves the first event `match` accepts, or null
  query(command, match, timeoutMs = 1500) {
    return new Promise((resolve) => {
      const q = { match, resolve, timer: setTimeout(() => {
        this.pending.splice(this.pending.indexOf(q), 1)
        resolve(null)
      }, timeoutMs) }
      this.pending.push(q)
      if (!this.run(command)) {
        clearTimeout(q.timer)
        this.pending.splice(this.pending.indexOf(q), 1)
        resolve(null)
      }
    })
  }

  async score(name, objective) {
    const ev = await this.query(
      `scoreboard players get ${name} ${objective}`,
      (e) => e.type === 'score' && e.name === name && e.objective.toLowerCase() === objective.toLowerCase(),
    )
    return ev ? ev.value : 0
  }

  stop(timeoutMs = 20000) {
    return new Promise((resolve) => {
      if (!this.child) return resolve()
      const child = this.child
      const timer = setTimeout(() => {
        // The server itself, then its watcher: killing only the watcher
        // would orphan the JVM
        if (this.serverPid) {
          try {
            process.kill(this.serverPid, 'SIGKILL')
          } catch {}
        }
        child.kill('SIGKILL')
        resolve()
      }, timeoutMs)
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
      if (!this.run('stop')) child.kill('SIGTERM')
    })
  }
}

// The arena, built once per world: a 41x41 floor at y=99 with barrier walls
// and a little cover. No ceiling, so respawns never land on top of it.
export function arenaBuildCommands() {
  const cmds = [
    'fill -21 98 -21 21 106 -21 minecraft:barrier',
    'fill -21 98 21 21 106 21 minecraft:barrier',
    'fill -21 98 -21 -21 106 21 minecraft:barrier',
    'fill 21 98 -21 21 106 21 minecraft:barrier',
    'fill -20 98 -20 20 98 20 minecraft:barrier',
    'fill -20 99 -20 20 99 20 minecraft:smooth_stone',
  ]
  // Four pillars to break line of sight, and four low walls you can hop
  for (const [x, z] of [[8, 8], [-9, 8], [8, -9], [-9, -9]]) {
    cmds.push(`fill ${x} 100 ${z} ${x + 1} 102 ${z + 1} minecraft:stone_bricks`)
  }
  cmds.push('fill -3 100 13 3 100 13 minecraft:mossy_stone_bricks')
  cmds.push('fill -3 100 -13 3 100 -13 minecraft:mossy_stone_bricks')
  cmds.push('fill 13 100 -3 13 100 3 minecraft:mossy_stone_bricks')
  cmds.push('fill -13 100 -3 -13 100 3 minecraft:mossy_stone_bricks')
  return cmds
}

// Run on every boot: cheap, and repairs anything changed by hand
export function arenaRuleCommands() {
  const rules = {
    doMobSpawning: false,
    doDaylightCycle: false,
    doWeatherCycle: false,
    keepInventory: true,
    doImmediateRespawn: true,
    announceAdvancements: false,
    doFireTick: false,
    spawnRadius: 0,
    doInsomnia: false,
    doPatrolSpawning: false,
    doTraderSpawning: false,
    doWardenSpawning: false,
    disableRaids: true,
    doEntityDrops: false,
    doTileDrops: false,
    sendCommandFeedback: false,
    commandBlockOutput: false,
    logAdminCommands: false,
    showDeathMessages: true,
    naturalRegeneration: true,
    spectatorsGenerateChunks: false,
  }
  return [
    ...Object.entries(rules).map(([k, v]) => `gamerule ${k} ${v}`),
    'setworldspawn 0 100 0',
    'time set 6000',
    'weather clear',
    'worldborder center 0 0',
    'worldborder set 64',
    'difficulty normal',
    'scoreboard objectives add kills playerKillCount {"text":"Kills","color":"gold"}',
    'scoreboard objectives add deaths deathCount',
    'scoreboard objectives setdisplay sidebar kills',
    // The banner at the top of the screen while the arena is paused
    `bossbar add ${BAR} {"text":""}`,
    `bossbar set ${BAR} visible false`,
  ]
}

const BAR = 'mcpvp:status'

// A banner that stays at the top of the screen until the fight resumes:
// titles fade in two seconds, this doesn't
export function statusBarCommands(text, color = 'white') {
  return [
    `bossbar set ${BAR} name ${JSON.stringify({ text, color })}`,
    `bossbar set ${BAR} color ${color}`,
    `bossbar set ${BAR} players @a`, // the selector is read now: run again after every join
    `bossbar set ${BAR} visible true`,
  ]
}

export function hideStatusBarCommands() {
  return [`bossbar set ${BAR} visible false`]
}

// A bell, played at the player so they hear it wherever they stand
export function alertCommands(name) {
  return [`execute at ${name} run playsound minecraft:block.note_block.bell master ${name} ~ ~ ~ 1 1.2`]
}

const UNBREAKABLE = '[minecraft:unbreakable={}]'

export function kitCommands(name) {
  return [
    `clear ${name}`,
    `gamemode survival ${name}`,
    `item replace entity ${name} armor.head with minecraft:iron_helmet${UNBREAKABLE}`,
    `item replace entity ${name} armor.chest with minecraft:iron_chestplate${UNBREAKABLE}`,
    `item replace entity ${name} armor.legs with minecraft:iron_leggings${UNBREAKABLE}`,
    `item replace entity ${name} armor.feet with minecraft:iron_boots${UNBREAKABLE}`,
    `item replace entity ${name} hotbar.0 with minecraft:diamond_sword${UNBREAKABLE}`,
  ]
}

const text = (s, color, bold = false) => JSON.stringify({ text: s, color, bold })

export function titleCommands(name, title, subtitle = '', color = 'gold') {
  return [
    `title ${name} times 4 30 8`,
    `title ${name} subtitle ${text(subtitle, 'gray')}`,
    `title ${name} title ${text(title, color, true)}`,
  ]
}

// While Claude has you: you can't be hurt and can't farm frozen bots
export function freezeHumanCommands(name) {
  return [
    `effect give ${name} minecraft:resistance infinite 4 true`,
    `effect give ${name} minecraft:weakness infinite 255 true`,
  ]
}

export function thawHumanCommands(name) {
  return [`effect clear ${name} minecraft:resistance`, `effect clear ${name} minecraft:weakness`]
}

export async function isArenaBuilt(dataDir) {
  return existsSync(serverPaths(dataDir).marker)
}

export async function markArenaBuilt(dataDir) {
  await writeFile(serverPaths(dataDir).marker, new Date().toISOString() + '\n')
}

export async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch {
    return fallback
  }
}

// A fresh log each daemon start, so it never grows without bound
export function openLog(path) {
  const stream = createWriteStream(path, { flags: 'w' })
  return (line) => stream.write(`${new Date().toISOString()} ${line}\n`)
}
