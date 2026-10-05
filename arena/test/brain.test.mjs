import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  botNames,
  chooseTarget,
  cooldownTicks,
  humanFocusCap,
  laggedPosition,
  swingLands,
  tierMix,
} from '../brain.mjs'
import { mergeOptions, serversDat } from '../client.mjs'
import { arenaBuildCommands, kitCommands, parseLine } from '../server.mjs'

test('roster sizes and mixes', () => {
  assert.equal(tierMix(4).length, 4)
  assert.equal(tierMix(6).length, 6)
  assert.equal(tierMix(8).length, 8)
  assert.equal(tierMix(7).length, 8, 'unknown counts fall back to 8')
  assert.deepEqual(tierMix(4, 'hard'), ['hard', 'hard', 'hard', 'hard'])
  assert.ok(tierMix(8).includes('sweat'))
  const names = botNames(tierMix(8))
  assert.equal(new Set(names).size, 8)
  assert.ok(names.every((n) => /^[A-Za-z0-9_]{3,16}$/.test(n)), 'valid Minecraft usernames')
})

test('focus cap', () => {
  assert.equal(humanFocusCap(4), 1)
  assert.equal(humanFocusCap(6), 2)
  assert.equal(humanFocusCap(8), 2)
})

const at = (x, z) => ({ x, y: 100, z })

test('bots spread out instead of all diving the human', () => {
  const human = { name: 'Fatih', pos: at(0, 0), isHuman: true }
  const far = { name: 'Rookie_1', pos: at(20, 20), isHuman: false }
  // Two bots already on the human, cap 2: the third must pick someone else
  const targets = new Map([['Brawler_1', 'Fatih'], ['Brawler_2', 'Fatih']])
  const pick = chooseTarget({ self: { name: 'Sweat_1', pos: at(1, 1) }, current: null, candidates: [human, far], targets, cap: 2, attacker: null, now: 0 })
  assert.equal(pick, 'Rookie_1')
  // Under the cap, nearest wins
  const pick2 = chooseTarget({ self: { name: 'Sweat_1', pos: at(1, 1) }, current: null, candidates: [human, far], targets: new Map([['Brawler_1', 'Fatih']]), cap: 2, attacker: null, now: 0 })
  assert.equal(pick2, 'Fatih')
})

test('a bot you hit may hit back, one over the cap', () => {
  const human = { name: 'Fatih', pos: at(5, 0), isHuman: true }
  const bot = { name: 'Rookie_1', pos: at(2, 0), isHuman: false }
  const targets = new Map([['Brawler_1', 'Fatih'], ['Brawler_2', 'Fatih']])
  const pick = chooseTarget({ self: { name: 'Sweat_1', pos: at(0, 0) }, current: null, candidates: [human, bot], targets, cap: 2, attacker: { name: 'Fatih', at: 1000 }, now: 1500 })
  assert.equal(pick, 'Fatih')
  const later = chooseTarget({ self: { name: 'Sweat_1', pos: at(0, 0) }, current: null, candidates: [human, bot], targets, cap: 2, attacker: { name: 'Fatih', at: 1000 }, now: 9000 })
  assert.equal(later, 'Rookie_1', 'grudges expire')
})

test('aim lags by the reaction time', () => {
  const h = [{ t: 0, x: 0, y: 0, z: 0 }, { t: 100, x: 10, y: 0, z: 0 }]
  assert.equal(laggedPosition(h, 150, 100).x, 5)
  assert.equal(laggedPosition(h, 500, 100).x, 10)
  assert.equal(laggedPosition(h, 50, 100).x, 0)
})

test('swings never land beyond reach, and sweats whiff less than rookies', () => {
  assert.equal(swingLands({ tier: 'sweat', realDistance: 3.2, laggedDistance: 2, drift: 0, rand: () => 0.99 }), false)
  const rate = (tier) => {
    let hits = 0
    let seed = 1
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647)
    for (let i = 0; i < 2000; i++) if (swingLands({ tier, realDistance: 2.4, laggedDistance: 2.5, drift: 0.5, rand })) hits++
    return hits / 2000
  }
  assert.ok(rate('sweat') > rate('easy') + 0.3)
  assert.ok(cooldownTicks('sweat') < cooldownTicks('easy'))
})

test('console lines parse', () => {
  assert.deepEqual(parseLine('[12:01:02 INFO]: Done (4.512s)! For help, type "help"'), { type: 'ready' })
  assert.deepEqual(parseLine('\x1b[0m[12:01:02 INFO]: Rookie_1 joined the game'), { type: 'join', name: 'Rookie_1' })
  assert.deepEqual(parseLine('[12:01:02 INFO]: Fatih was slain by Sweat_1'), { type: 'death', name: 'Fatih', killer: 'Sweat_1' })
  assert.deepEqual(parseLine('[12:01:02 INFO]: Fatih fell from a high place'), { type: 'death', name: 'Fatih', killer: null })
  assert.deepEqual(parseLine('[12:01:02 INFO]: Fatih has 3 [Kills]'), { type: 'score', name: 'Fatih', value: 3, objective: 'Kills' })
  assert.equal(parseLine('[12:01:02 INFO]: <Fatih> gg'), null)
  assert.equal(parseLine('[12:01:02 INFO]: Fatih[/127.0.0.1:5555] logged in with entity id 7'), null)
})

test('arena commands stay inside vanilla limits', () => {
  for (const c of arenaBuildCommands()) {
    const m = /^fill (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+) (-?\d+)/.exec(c)
    assert.ok(m, c)
    const [x1, y1, z1, x2, y2, z2] = m.slice(1).map(Number)
    const volume = (Math.abs(x2 - x1) + 1) * (Math.abs(y2 - y1) + 1) * (Math.abs(z2 - z1) + 1)
    assert.ok(volume <= 32768, `${c} fills ${volume} blocks`)
  }
  assert.ok(kitCommands('Fatih').some((c) => c.includes('diamond_sword[minecraft:unbreakable={}]')))
})

test('options.txt merge keeps the player\'s own keys', () => {
  const merged = mergeOptions('fov:0.5\nmaxFps:260\n', { maxFps: '60', pauseOnLostFocus: 'false' })
  assert.equal(merged, 'fov:0.5\nmaxFps:60\npauseOnLostFocus:false\n')
})

test('servers.dat is valid NBT', () => {
  const buf = serversDat([{ name: 'Claude PvP', ip: '127.0.0.1:25599' }])
  let i = 0
  const u8 = () => buf[i++]
  const u16 = () => ((i += 2), buf.readUInt16BE(i - 2))
  const i32 = () => ((i += 4), buf.readInt32BE(i - 4))
  const str = () => {
    const n = u16()
    i += n
    return buf.subarray(i - n, i).toString('utf8')
  }
  assert.equal(u8(), 10)
  assert.equal(str(), '')
  assert.equal(u8(), 9)
  assert.equal(str(), 'servers')
  assert.equal(u8(), 10)
  assert.equal(i32(), 1)
  const entry = {}
  for (;;) {
    const type = u8()
    if (type === 0) break
    const key = str()
    entry[key] = type === 8 ? str() : u8()
  }
  assert.deepEqual(entry, { name: 'Claude PvP', ip: '127.0.0.1:25599', hidden: 0 })
  assert.equal(u8(), 0)
  assert.equal(i, buf.length)
})

import { countdownLeft, isProtected, nextHumanState } from '../brain.mjs'

test('grace counts down to fight', () => {
  let s = { mode: 'grace', until: 3000 }
  assert.equal(countdownLeft(s, 0), 3)
  assert.equal(countdownLeft(s, 1500), 2)
  assert.equal(countdownLeft(s, 2500), 1)
  assert.ok(isProtected(s))
  s = nextHumanState(s, { now: 3000, lastLookAt: 0, afkMs: 2000, graceMs: 3000 })
  assert.equal(s.mode, 'fight')
  assert.ok(!isProtected(s))
})

test('alt-tabbing mid-fight goes AFK, moving the camera brings grace back', () => {
  let s = { mode: 'fight', since: 0 }
  // Camera moving: stays in the fight
  s = nextHumanState(s, { now: 1900, lastLookAt: 1800, afkMs: 2000, graceMs: 3000 })
  assert.equal(s.mode, 'fight')
  // Camera still for over 2 s: AFK, protected
  s = nextHumanState(s, { now: 4000, lastLookAt: 1800, afkMs: 2000, graceMs: 3000 })
  assert.equal(s.mode, 'afk')
  assert.ok(isProtected(s))
  // Still away
  s = nextHumanState(s, { now: 9000, lastLookAt: 1800, afkMs: 2000, graceMs: 3000 })
  assert.equal(s.mode, 'afk')
  // Back: a fresh countdown, not straight into the fight
  s = nextHumanState(s, { now: 9500, lastLookAt: 9400, afkMs: 2000, graceMs: 3000 })
  assert.deepEqual(s, { mode: 'grace', until: 12500 })
})

test('watching the countdown without touching the mouse is not AFK', () => {
  // Grace ends at 3000 with the camera untouched since 0
  let s = nextHumanState({ mode: 'grace', until: 3000 }, { now: 3000, lastLookAt: 0, afkMs: 2000, graceMs: 3000 })
  assert.equal(s.mode, 'fight')
  s = nextHumanState(s, { now: 4000, lastLookAt: 0, afkMs: 2000, graceMs: 3000 })
  assert.equal(s.mode, 'fight', 'the fight clock starts when the fight does')
})

test('a human no bot can see is never parked as AFK', () => {
  const s = nextHumanState({ mode: 'fight', since: 0 }, { now: 60_000, lastLookAt: null, afkMs: 2000, graceMs: 3000 })
  assert.equal(s.mode, 'fight')
})

import { pickClient } from '../focus.mjs'

test('only our own Minecraft is ever closed', () => {
  const ours = { pid: 11, cmd: '/usr/bin/java -Xmx2048m -Djava.library.path=/home/f/.local/share/PrismLauncher/instances/claude-pvp/natives -cp x.jar org.prismlauncher.EntryPoint' }
  const theirs = { pid: 22, cmd: '/usr/bin/java -Djava.library.path=/home/f/.local/share/PrismLauncher/instances/Hypixel/natives -cp x.jar org.prismlauncher.EntryPoint' }
  const server = { pid: 33, cmd: '/usr/bin/java -Xmx1024M -jar /home/f/.claude-pvp/server/paper.jar --nogui' }
  const win = { pid: 44, cmd: 'C:\\Java\\bin\\javaw.exe -Djava.library.path=C:\\Users\\f\\AppData\\Roaming\\PrismLauncher\\instances\\claude-pvp\\natives org.prismlauncher.EntryPoint' }
  assert.equal(pickClient([theirs, server, ours], { onlyOurs: true }), 11)
  assert.equal(pickClient([theirs, server], { onlyOurs: true }), null, 'never their own instance')
  assert.equal(pickClient([theirs, server]), 22, 'focus may fall back to any client')
  assert.equal(pickClient([win], { onlyOurs: true }), 44)
  assert.equal(pickClient([server]), null, 'the server is not a client')
  const lookalike = { pid: 55, cmd: '/usr/bin/java -jar /home/f/code/claude-pvp/tools/formatter.jar' }
  assert.equal(pickClient([lookalike], { onlyOurs: true }), null, 'a folder name alone is not enough')
  const shell = { pid: 66, cmd: 'bash -c echo ' + ours.cmd }
  assert.equal(pickClient([shell], { onlyOurs: true }), null, 'a shell quoting the command line is not the game')
})

import { cleanTerminal } from '../focus.mjs'

test('security: terminal info from a request is reduced to safe shapes', () => {
  assert.deepEqual(cleanTerminal({ bundleId: 'com.mitchellh.ghostty', windowId: '12345', termProgram: 'iTerm.app' }), {
    bundleId: 'com.mitchellh.ghostty',
    windowId: '12345',
    termProgram: 'iTerm.app',
  })
  assert.deepEqual(cleanTerminal({ bundleId: '-a Calculator', windowId: '1; rm -rf ~', termProgram: "x'); evil" }), {})
  assert.equal(cleanTerminal('nope'), null)
  assert.equal(cleanTerminal(null), null)
})

import { prismCandidates } from '../client.mjs'

test('Prism is looked for in every usual Windows spot', () => {
  const env = { LOCALAPPDATA: 'C:/Users/f/AppData/Local', APPDATA: 'C:/Users/f/AppData/Roaming', ProgramFiles: 'C:/Program Files', PATH: '' }
  const exes = prismCandidates('win32', env, 'C:/Users/f').map((c) => c.exe[0].replace(/\\/g, '/'))
  assert.ok(exes.some((e) => e.endsWith('AppData/Local/Programs/PrismLauncher/prismlauncher.exe')), 'installer / winget')
  assert.ok(exes.some((e) => e.endsWith('Program Files/PrismLauncher/prismlauncher.exe')), 'all-users install')
  assert.ok(exes.some((e) => e.endsWith('scoop/apps/prismlauncher/current/prismlauncher.exe')), 'scoop')
})

import { isClientStarting } from '../focus.mjs'

test('Prism or our client on the process list counts as Minecraft still starting', () => {
  const win = [{ pid: 1, cmd: '"C:\\Users\\f\\AppData\\Local\\Programs\\PrismLauncher\\prismlauncher.exe" --launch claude-pvp --server 127.0.0.1:25599' }]
  const mac = [{ pid: 2, cmd: '/Applications/Prism Launcher.app/Contents/MacOS/prismlauncher --launch claude-pvp' }]
  const linux = [{ pid: 3, cmd: '/usr/bin/prismlauncher' }]
  const client = [{ pid: 4, cmd: 'java -Djava.library.path=/x/instances/claude-pvp/natives -cp a.jar org.prismlauncher.EntryPoint' }]
  const none = [{ pid: 5, cmd: 'node /home/f/mc-pvp-bots/arena/daemon.mjs --launcher prism --prism-path ' }]
  for (const list of [win, mac, linux, client]) assert.equal(isClientStarting(list), true, list[0].cmd)
  assert.equal(isClientStarting(none), false)
})

import { windowsForegroundScript } from '../focus.mjs'

test('Windows window switching: only a real pid gets into the script', () => {
  const script = windowsForegroundScript(4242, { fallbackApps: ['WindowsTerminal'] })
  assert.match(script, /\$p = 4242/)
  assert.match(script, /Get-Process -Name 'WindowsTerminal'/)
  assert.match(script, /IsWindowVisible/)
  for (const bad of ['4242; Remove-Item x', -1, 0, 1.5, 'abc', 2 ** 40]) {
    assert.throws(() => windowsForegroundScript(bad), /bad pid/, String(bad))
  }
  assert.throws(() => windowsForegroundScript(1, { fallbackApps: ["x'; evil"] }), /bad app name/)
})

test('the pid of Claude Code passes cleanTerminal only as digits', () => {
  assert.deepEqual(cleanTerminal({ pid: '4242' }), { pid: '4242' })
  assert.deepEqual(cleanTerminal({ pid: '42; rm' }), {})
  assert.deepEqual(cleanTerminal({ pid: 4242 }), {})
})

import { botsShouldFight } from '../brain.mjs'

test('bots hold still during a countdown, while paused, and with nobody in', () => {
  assert.equal(botsShouldFight({ paused: false, humanCount: 1, modes: ['fight'] }), true)
  assert.equal(botsShouldFight({ paused: false, humanCount: 1, modes: ['grace'] }), false, '3-2-1: everyone frozen')
  assert.equal(botsShouldFight({ paused: false, humanCount: 1, modes: ['afk'] }), true, 'AFK: they carry on without you')
  assert.equal(botsShouldFight({ paused: true, humanCount: 1, modes: ['fight'] }), false)
  assert.equal(botsShouldFight({ paused: false, humanCount: 0, modes: [] }), false)
})
