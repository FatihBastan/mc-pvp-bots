// Runs the real daemon against the fake server: the play/pause flow, and every
// way of leaving it, checking nothing is left running afterwards.
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// The daemon refuses its test switches without this
process.env.MC_PVP_BOTS_TESTING = '1'

const root = fileURLToPath(new URL('..', import.meta.url))
const ctl = join(root, 'ctl.mjs')
const fake = join(root, 'test/fake-server.mjs')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function alive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function until(fn, ms = 5000, every = 100) {
  const end = Date.now() + ms
  for (;;) {
    const v = await fn()
    if (v) return v
    if (Date.now() > end) return v
    await sleep(every)
  }
}

async function arena(extra = [], env = {}) {
  const data = await mkdtemp(join(tmpdir(), 'mc-pvp-bots-'))
  const port = 30000 + Math.floor(Math.random() * 20000)
  const fakeLog = join(data, 'commands.log')
  // A test that fails before /stop leaves its daemon idling out in 30 s
  const idle = extra.includes('--idle-ms') ? [] : ['--idle-ms', '30000']
  const argv = ['--data', data, '--port', String(port), '--server-port', String(port + 1), '--fake-server', fake, '--no-bots', ...idle, ...extra]
  const fullEnv = { ...process.env, FAKE_LOG: fakeLog, FAKE_HUMAN: 'Steve', ...env }
  const runCtl = (cmd, more = []) =>
    new Promise((resolve, reject) => {
      execFile(process.execPath, [ctl, cmd, ...argv, ...more], { env: fullEnv }, (err, stdout) => {
        if (err) return reject(err)
        resolve(JSON.parse(stdout.trim().split('\n').pop()))
      })
    })
  const started = await runCtl('ensure')
  assert.equal(started.ok, true, JSON.stringify(started))
  const call = async (path, body) => {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { 'x-arena-token': started.token, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    }).catch(() => null)
    return res ? { status: res.status, json: await res.json() } : null
  }
  const serverPid = () => until(async () => Number(await readFile(join(data, 'server', 'server.pid'), 'utf8').catch(() => 0)) || null, 3000)
  const commands = () => readFile(fakeLog, 'utf8').catch(() => '')
  const ready = () => until(async () => (await call('/status'))?.json?.humans?.length === 1, 5000)
  return { data, port, started, call, runCtl, serverPid, commands, ready }
}

test('play, grace countdown, fight, pause, stop', async () => {
  const a = await arena()
  const again = await a.runCtl('ensure')
  assert.equal(again.already, true, 'a second ensure reuses the running daemon')

  const denied = await fetch(`http://127.0.0.1:${a.port}/status`, { headers: { 'x-arena-token': 'nope' } })
  assert.equal(denied.status, 403)

  assert.ok(await a.ready())
  const played = (await a.call('/play', { bots: 6, launcher: 'manual', graceMs: 1200 })).json
  assert.equal(played.ok, true)
  // Grace first: protected, countdown on screen, no FIGHT yet
  assert.equal((await a.call('/status')).json.people.Steve, 'grace')
  await sleep(1600)
  assert.equal((await a.call('/status')).json.people.Steve, 'fight')
  await sleep(200)
  const paused = (await a.call('/pause', { reason: 'done', handBackMs: 0 })).json
  assert.deepEqual(paused.drop, { kills: 1, deaths: 1 })

  const log = await a.commands()
  for (const expected of [
    'gamerule keepInventory true',
    'item replace entity Steve hotbar.0 with minecraft:diamond_sword[minecraft:unbreakable={}]',
    'title Steve title {"text":"2","color":"yellow","bold":true}',
    'title Steve title {"text":"FIGHT","color":"red","bold":true}',
    'effect clear Steve minecraft:weakness',
    'bossbar set mcpvp:status visible false',
    'bossbar set mcpvp:status name {"text":"Paused · fights start when Claude is working · or /pvp play","color":"white"}',
    'bossbar set mcpvp:status name {"text":"✔ Claude\'s done · fights resume on the next long turn","color":"green"}',
    'title Steve title {"text":"Paused","color":"gold","bold":true}',
    'effect give Steve minecraft:resistance infinite 4 true',
  ]) {
    assert.ok(log.includes(expected), `server got: ${expected}`)
  }
  assert.ok(log.indexOf('"text":"FIGHT"') > log.indexOf('"text":"1"'), 'FIGHT comes after the countdown')

  const server = await a.serverPid()
  await a.call('/stop', {})
  assert.ok(await until(() => !alive(server) && !alive(a.started.pid), 8000), 'daemon and server both gone after /stop')
})

test('kill -9 of the daemon takes the server down too', { skip: process.platform === 'win32' }, async () => {
  const a = await arena()
  assert.ok(await a.ready())
  const server = await a.serverPid()
  assert.ok(alive(server))
  process.kill(a.started.pid, 'SIGKILL')
  assert.ok(await until(() => !alive(server), 8000), 'the watcher stopped the orphaned server')
  assert.ok((await a.commands()).includes('#SIGTERM'), 'stopped gracefully (SIGTERM), not killed')
})

test('a server left behind is stopped before a new one starts', async () => {
  const data = await mkdtemp(join(tmpdir(), 'mc-pvp-bots-stale-'))
  await mkdir(join(data, 'server'), { recursive: true })
  // An orphan from an earlier daemon: our fake server, detached, with a pid file
  const orphan = spawn(process.execPath, [fake], { detached: true, stdio: 'ignore', env: { ...process.env, FAKE_BOOT_MS: '999999' } })
  orphan.unref()
  await writeFile(join(data, 'server', 'server.pid'), String(orphan.pid))
  // And an unrelated process whose pid must never be touched
  const port = 30000 + Math.floor(Math.random() * 20000)
  const started = await new Promise((resolve) =>
    execFile(process.execPath, [ctl, 'ensure', '--data', data, '--port', String(port), '--server-port', String(port + 1), '--fake-server', fake, '--no-bots'], (e, out) => resolve(JSON.parse(out.trim()))),
  )
  assert.equal(started.ok, true)
  assert.ok(await until(() => !alive(orphan.pid), 8000), 'orphan stopped')
  await fetch(`http://127.0.0.1:${port}/stop`, { method: 'POST', headers: { 'x-arena-token': started.token } })
  await until(() => !alive(started.pid), 8000)
})

test('a pid file pointing at someone else\'s process is left alone', async () => {
  const data = await mkdtemp(join(tmpdir(), 'mc-pvp-bots-other-'))
  await mkdir(join(data, 'server'), { recursive: true })
  const other = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' })
  await writeFile(join(data, 'server', 'server.pid'), String(other.pid))
  const port = 30000 + Math.floor(Math.random() * 20000)
  const started = await new Promise((resolve) =>
    execFile(process.execPath, [ctl, 'ensure', '--data', data, '--port', String(port), '--server-port', String(port + 1), '--fake-server', fake, '--no-bots'], (e, out) => resolve(JSON.parse(out.trim()))),
  )
  await sleep(1000)
  assert.ok(alive(other.pid), 'not ours, not killed')
  other.kill()
  await fetch(`http://127.0.0.1:${port}/stop`, { method: 'POST', headers: { 'x-arena-token': started.token } })
  await until(() => !alive(started.pid), 8000)
})

test('Claude Code going quiet mid-fight pauses the arena, then it idles out', async () => {
  const a = await arena(['--lease-ms', '1500', '--idle-ms', '4000'])
  assert.ok(await a.ready())
  await a.call('/play', { launcher: 'manual', graceMs: 0 })
  const server = await a.serverPid()
  // No more check-ins: Claude Code is gone
  await sleep(2500)
  const log = await a.commands()
  assert.ok(log.includes('Lost touch with Claude Code'), 'paused with a reason on screen')
  // Then nothing asks for anything: everything shuts down
  assert.ok(await until(() => !alive(a.started.pid) && !alive(server), 10_000), 'daemon and server gone after idling')
})

test('closing Minecraft mid-fight stops the bots instead of letting them brawl', async () => {
  const a = await arena([], { FAKE_LEAVE_MS: '300' })
  assert.ok(await a.ready())
  await a.call('/play', { launcher: 'manual', graceMs: 0 })
  assert.ok(await until(async () => (await a.call('/status')).json.paused === true, 3000), 'paused once the human left')
  await a.call('/stop', {})
})

test('a drop-in asked for while booting is dropped if Claude Code quit meanwhile', async () => {
  const a = await arena(['--lease-ms', '800'], { FAKE_BOOT_MS: '2000' })
  const r = (await a.call('/play', { launcher: 'manual' })).json
  assert.equal(r.phase, 'booting')
  await sleep(3000) // boot finishes long after the last word from the mod
  const s = (await a.call('/status')).json
  assert.equal(s.phase, 'ready')
  assert.equal(s.paused, true, 'never went live for a session that is gone')
  await a.call('/stop', {})
})

test('security: the control port only answers us', async () => {
  const a = await arena()
  const raw = (path, { method = 'GET', headers = {}, body } = {}) =>
    new Promise((resolve) => {
      // node:http so the Host header can be set the way a rebinding page would
      import('node:http').then(({ request }) => {
        const req = request({ host: '127.0.0.1', port: a.port, path, method, headers }, (res) => {
          let text = ''
          res.on('data', (c) => (text += c))
          res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }))
        })
        req.on('error', () => resolve({ status: 0, headers: {}, text: '' }))
        if (body) req.write(body)
        req.end()
      })
    })
  const tok = { 'x-arena-token': a.started.token }
  // DNS rebinding: right token would never be known, but even with it, a
  // foreign Host header is refused
  assert.equal((await raw('/status', { headers: { ...tok, host: `evil.example:${a.port}` } })).status, 403)
  // Wrong and missing tokens
  assert.equal((await raw('/status', { headers: { 'x-arena-token': a.started.token.slice(0, -1) + 'x' } })).status, 403)
  assert.equal((await raw('/status')).status, 403)
  // A browser preflight gets no CORS approval
  const pre = await raw('/play', { method: 'OPTIONS', headers: { origin: 'https://evil.example', 'access-control-request-method': 'POST' } })
  assert.equal(pre.status, 403)
  assert.equal(pre.headers['access-control-allow-origin'], undefined)
  // Oversized bodies are refused, not buffered
  const big = await raw('/config', { method: 'POST', headers: { ...tok, 'content-type': 'application/json' }, body: JSON.stringify({ x: 'a'.repeat(20000) }) })
  assert.equal(big.status, 413)
  await a.call('/stop', {})
})

test('security: a program path in a request is ignored', async () => {
  // Nobody joins, so /play goes on to launch Minecraft
  const a = await arena([], { FAKE_HUMAN: '' })
  assert.ok(await until(async () => (await a.call('/status'))?.json?.phase === 'ready', 5000))
  const canary = join(a.data, 'canary')
  const played = (await a.call('/play', { launcher: 'prism', prismPath: process.execPath, prismData: canary })).json
  // With no Prism configured at start, there is nothing to launch: the path
  // in the request was not used
  assert.equal(played.ok, false)
  assert.match(played.error, /Prism Launcher was not found/)
  assert.equal((await a.call('/status')).json.paused, true, 'no way in, so it never went live')
  assert.equal(await readFile(join(canary, 'instances', 'claude-pvp', 'instance.cfg'), 'utf8').catch(() => null), null, 'nothing written where a request pointed')
  assert.equal((await a.call('/status')).json.config.prismPath, undefined, 'status never echoes paths')
  await a.call('/stop', {})
})

test('security: test switches are refused outside tests', async () => {
  const data = await mkdtemp(join(tmpdir(), 'mc-pvp-bots-sw-'))
  const env = { ...process.env }
  delete env.MC_PVP_BOTS_TESTING
  const reply = await new Promise((resolve) =>
    execFile(process.execPath, [ctl, 'ensure', '--data', data, '--port', '31999', '--fake-server', fake], { env }, (e, out) => resolve(JSON.parse(out.trim()))),
  )
  assert.equal(reply.ok, false)
  assert.match(reply.error, /MC_PVP_BOTS_TESTING/)
})

test('security: the data folder and token are private', { skip: process.platform === 'win32' }, async () => {
  const a = await arena()
  const { stat } = await import('node:fs/promises')
  assert.equal((await stat(a.data)).mode & 0o777, 0o700)
  assert.equal((await stat(join(a.data, 'control.json'))).mode & 0o777, 0o600)
  assert.ok(a.started.token.length >= 32)
  await a.call('/stop', {})
})

test('a launch problem found after boot reaches the mod on its next poll', async () => {
  // /play arrives while booting; the launch is tried once the server is up
  const a = await arena([], { FAKE_HUMAN: '', FAKE_BOOT_MS: '1200' })
  const r = (await a.call('/play', { launcher: 'prism' })).json
  assert.equal(r.phase, 'booting')
  const seen = await until(async () => {
    const s = (await a.call('/status')).json
    return s.notice ? s : null
  }, 6000, 300)
  assert.ok(seen, 'a notice arrived')
  assert.match(seen.notice, /Prism Launcher was not found/)
  assert.equal(seen.paused, true)
  assert.equal((await a.call('/status')).json.notice, null, 'told once')
  await a.call('/stop', {})
})

test('manual launcher: /status tells the mod where to join', async () => {
  const a = await arena([], { FAKE_HUMAN: '' })
  assert.ok(await until(async () => (await a.call('/status'))?.json?.phase === 'ready', 5000))
  const r = (await a.call('/play', { launcher: 'manual' })).json
  assert.equal(r.ok, true)
  const s = (await a.call('/status')).json
  assert.match(s.joinAddress, /^127\.0\.0\.1:\d+$/)
  assert.equal(s.launching, false)
  await a.call('/stop', {})
})

test('the first launch can take minutes: no standing down while Prism is still running', async () => {
  const a = await arena(['--join-wait-ms', '600', '--launch-wait-ms', '120000'], { FAKE_HUMAN: '' })
  // Something that looks like Prism on the process list
  const prism = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', 'prismlauncher'], { stdio: 'ignore' })
  try {
    assert.ok(await until(async () => (await a.call('/status'))?.json?.phase === 'ready', 5000))
    assert.equal((await a.call('/play', { launcher: 'manual', graceMs: 0 })).json.ok, true)
    // Well past the join wait, but Prism is "downloading": still live
    await sleep(2500)
    assert.equal((await a.call('/status')).json.paused, false)
    // Prism gone and still nobody: it stands down at the next check
    prism.kill()
    assert.ok(await until(async () => (await a.call('/status')).json.paused === true, 14_000, 500), 'stood down once nothing was starting')
  } finally {
    prism.kill()
    await a.call('/stop', {})
  }
})

test('a drop-in queued during the first boot goes live once the server is up', async () => {
  const a = await arena([], { FAKE_BOOT_MS: '1500' })
  const r = (await a.call('/play', { launcher: 'manual', graceMs: 0 })).json
  assert.equal(r.phase, 'booting')
  // While booting, the mod polls every few seconds: it must not read this as paused
  const during = (await a.call('/status')).json
  assert.equal(during.paused, false)
  assert.equal(during.pending, true)
  const live = await until(async () => {
    const s = (await a.call('/status')).json
    return s.phase === 'ready' && s.humans.length === 1 && s.people.Steve === 'fight' ? s : null
  }, 6000, 400)
  assert.ok(live, 'went live and the player is fighting')
  assert.equal(live.paused, false)
  await a.call('/stop', {})
})

test('"Claude needs you" stays on screen and rings a bell', async () => {
  const a = await arena()
  assert.ok(await a.ready())
  await a.call('/play', { launcher: 'manual', graceMs: 0 })
  await sleep(200)
  await a.call('/pause', { reason: 'needs-you', handBackMs: 0 })
  await sleep(200)
  const log = await a.commands()
  assert.ok(log.includes('bossbar set mcpvp:status name {"text":"⚠ Claude needs you · alt-tab to your terminal","color":"red"}'))
  assert.ok(log.includes('bossbar set mcpvp:status visible true'))
  assert.ok(log.includes('execute at Steve run playsound minecraft:block.note_block.bell master Steve ~ ~ ~ 1 1.2'))
  // Back in: the banner goes away
  const before = log.split('\n').length
  await a.call('/play', { launcher: 'manual', graceMs: 0 })
  await sleep(200)
  const after = (await a.commands()).split('\n').slice(before - 1).join('\n')
  assert.ok(after.includes('bossbar set mcpvp:status visible false'))
  await a.call('/stop', {})
})

test('one leaderboard per Claude Code session', async () => {
  const a = await arena()
  assert.ok(await a.ready())
  const resets = async () => ((await a.commands()).match(/scoreboard players reset \* kills/g) ?? []).length
  await a.call('/play', { launcher: 'manual', graceMs: 0, match: 'session-A' })
  await a.call('/pause', { reason: 'done' })
  await a.call('/play', { launcher: 'manual', graceMs: 0, match: 'session-A' })
  await a.call('/pause', { reason: 'done' })
  await sleep(100)
  assert.equal(await resets(), 1, 'same session: the board carries on')
  await a.call('/play', { launcher: 'manual', graceMs: 0, match: 'session-B' })
  await sleep(100)
  assert.equal(await resets(), 2, 'new session: fresh board')
  await a.call('/stop', {})
})
