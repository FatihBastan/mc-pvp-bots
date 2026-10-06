import type { On } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

type Call = { path: string; body: Record<string, unknown> }

// The engine beneath the mod, answered from memory: no real process or network
function world(on: On, store: Record<string, unknown> = { isOn: true, isSetUp: true }) {
  const calls: Call[] = []
  const toasts: string[] = []
  const logs: string[] = []
  const statuses: (string | undefined)[] = []
  const argvs: string[][] = []
  const kv = new Map(Object.entries(store))
  const daemon = {
    drop: { kills: 0, deaths: 0 },
    paused: false,
    humans: ['Fatih'] as string[],
    notice: null as string | null,
    launching: false,
    play: { ok: true, phase: 'ready', inGame: true } as Record<string, unknown>,
  }
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/home/fatih', TERM_PROGRAM: 'ghostty', __CFBundleIdentifier: 'com.mitchellh.ghostty' })
  on('store.get', ($, e) => ({ value: kv.get((e as { key: string }).key) }) as never)
  on('store.set', ($, e) => {
    const { key, value } = e as { key: string; value: unknown }
    kv.set(key, value)
    return { value: undefined } as never
  })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  // A tool call stays under way while gate.wait is pending, as one waiting on its permission dialog does
  const gate: { wait: Promise<void> | null } = { wait: null }
  on('tool.call', async () => {
    if (gate.wait) await gate.wait
    return { result: 'ok' } as never
  })
  on('classic.Notification', () => ({}))
  // What the settings hooks beneath answer a permission request with ({}: nothing, so a dialog shows)
  const permission: { answer: Record<string, unknown> } = { answer: {} }
  on('classic.PermissionRequest', () => permission.answer as never)
  // What the engine itself draws for a component: nothing the mod needs
  on('ui.render', () => ({ type: 'Text', props: { children: [''] } }) as never)
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('ui.log', ($, e) => {
    logs.push(String((e as { text?: unknown }).text))
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    statuses.push((e as { text?: string }).text)
    return { value: undefined }
  })
  on('ui.toast', ($, e) => {
    toasts.push(String((e as { text?: unknown }).text))
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    argvs.push([...e.argv])
    // ensure also says who started it (parent): Claude Code's pid
    const stdout = e.argv.includes('ensure')
      ? JSON.stringify({ ok: true, port: 25601, token: 'tok', pid: 1, parent: 4242 })
      : JSON.stringify({ ok: true, wasRunning: true })
    return { value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('http.fetch', ($, e) => {
    const path = new URL(e.url).pathname
    const body = JSON.parse(e.init?.body ?? '{}') as Record<string, unknown>
    calls.push({ path, body })
    const reply =
      path === '/play' ? daemon.play
      : path === '/pause' ? { ok: true, wasLive: true, drop: daemon.drop }
      : { ok: true, phase: 'ready', paused: daemon.paused, drop: daemon.drop, bots: [], humans: daemon.humans, notice: daemon.notice, launching: daemon.launching }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify(reply) } }
  })
  const to = (path: string) => calls.filter((c) => c.path === path)
  // Starts a tool call that waits (on its permission dialog, say) until released
  const startCall = (run: (call: object) => Promise<unknown>, call: object) => {
    let release!: () => void
    gate.wait = new Promise<void>((r) => (release = r))
    const done = run(call)
    return async () => {
      gate.wait = null
      release()
      await done
    }
  }
  return { calls, toasts, logs, statuses, argvs, clock, daemon, kv, to, permission, startCall }
}

const START = { cwd: '/proj', surface: null, isInteractive: true } as const
const DONE = { answer: 'done', durationMs: 10, isAborted: false, reason: 'answer' } as const
const TYPED = { origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 160 } } as const
const PLAY = { launcher: 'prism', graceMs: 3000, afkMs: 2000, closeGame: true } as const

describe('dropping in', () => {
  test('a short turn never pulls you in', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'quick question', turnId: 't1' })
    await w.clock.advance(6_000)
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await w.clock.advance(20_000)
    expect(w.to('/play').length).toBe(0)
    expect(w.to('/pause').length).toBe(0)
  })

  test('a long turn drops you in after 10 s and hands you back when Claude is done', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'refactor everything', turnId: 't1' })
    await w.clock.advance(10_500)
    expect(w.to('/play').length).toBe(1)
    expect(w.to('/play')[0]!.body).toEqual({ bots: 8, difficulty: 'mixed', ...PLAY, match: 'sess-1' })
    w.daemon.drop = { kills: 3, deaths: 1 }
    await $.turn.complete({ ...DONE, turnId: 't1' })
    const pause = w.to('/pause')[0]!
    expect(pause.body.reason).toBe('done')
    expect(pause.body.handBackMs).toBe(2000)
    expect(pause.body.terminal).toEqual({ bundleId: 'com.mitchellh.ghostty', termProgram: 'ghostty', pid: '4242' })
    expect(w.toasts.some((t) => t.includes('3 kills, 1 death'))).toBe(true)
  })

  test('a permission prompt pulls you out at once, and you go back in after answering', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'deploy', turnId: 't1' })
    await w.clock.advance(11_000)
    expect(w.to('/play').length).toBe(1)
    // The call waits on its dialog; a call alone pulls nobody out (auto mode may answer it)
    const finish = w.startCall((c) => $.tool.call(c as never), { tool: 'Bash', command: 'rm -rf build', tool_use_id: 'u1' })
    await w.clock.advance(10)
    expect(w.to('/pause').length).toBe(0)
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'rm -rf build' } } as never)
    expect(w.to('/pause').at(-1)!.body.reason).toBe('permission')
    // The person answers; the tool runs; Claude carries on
    await finish()
    await w.clock.advance(11_000)
    expect(w.to('/play').length).toBe(2)
    await $.turn.complete({ ...DONE, turnId: 't1' })
    expect(w.to('/pause').length).toBe(2)
  })

  test('nothing happens while off', async ($, on) => {
    const w = world(on, { isOn: false, isSetUp: true })
    await $.session.start(START)
    await $.turn.start({ text: 'long one', turnId: 't1' })
    await w.clock.advance(60_000)
    await $.turn.complete({ ...DONE, turnId: 't1' })
    expect(w.calls.length).toBe(0)
  })
})

describe('the /pvp command', () => {
  test('bots and difficulty stick and reach the next drop-in', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    const set = await $.command.run({ command: 'pvp', args: 'bots 6', ...TYPED })
    expect(set.text).toContain('6 bots')
    await $.command.run({ command: 'pvp', args: 'difficulty hard', ...TYPED })
    expect(w.kv.get('bots')).toBe(6)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await w.clock.advance(10_500)
    expect(w.to('/play')[0]!.body).toEqual({ bots: 6, difficulty: 'hard', ...PLAY, match: 'sess-1' })
  })

  test('rejects bot counts other than 4, 6 or 8', async ($, on) => {
    world(on)
    await $.session.start(START)
    const res = await $.command.run({ command: 'pvp', args: 'bots 5', ...TYPED })
    expect(res.text).toBe('Bots: 4, 6 or 8.')
  })

  test('daemon starts with the configured ports and data folder', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await w.clock.advance(10_500)
    const ensure = w.argvs.find((a) => a.includes('ensure'))!
    expect(ensure[0]).toBe('node')
    expect(ensure).toContain('/home/fatih/.claude-pvp')
    expect(ensure).toContain('25599')
  })
})

describe('leaving', () => {
  test('quitting Claude Code mid-fight freezes the arena on the way out', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'long job', turnId: 't1' })
    await w.clock.advance(10_500)
    expect(w.to('/play').length).toBe(1)
    await $.session.end({ sessionId: 's1', reason: 'prompt_input_exit' } as never)
    expect(w.to('/pause').at(-1)!.body).toEqual({ reason: 'lost' })
  })

  test('quitting while not in the arena sends nothing', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.session.end({ sessionId: 's1', reason: 'prompt_input_exit' } as never)
    expect(w.calls.length).toBe(0)
  })

  test('/pvp off stops the arena and our Minecraft', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    const res = await $.command.run({ command: 'pvp', args: 'off', ...TYPED })
    const stop = w.argvs.find((a) => a.includes('stop'))!
    expect(stop).toBeDefined()
    expect(stop.includes('--keep-game')).toBe(false)
    expect(res.text).toContain('closed')
    expect(w.kv.get('isOn')).toBe(false)
  })

  test('when the arena stands down on its own, the next tool call drops you back in', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'long job', turnId: 't1' })
    await w.clock.advance(10_500)
    expect(w.to('/play').length).toBe(1)
    // You closed Minecraft; the arena paused itself
    w.daemon.paused = true
    await w.clock.advance(4_500)
    w.daemon.paused = false
    await $.tool.call({ tool: 'Read', file_path: '/proj/a.ts', tool_use_id: 'u2' } as never)
    await w.clock.advance(10_500)
    expect(w.to('/play').length).toBe(2)
  })

  test('check-ins keep coming while you play (the arena pauses if they stop)', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'long job', turnId: 't1' })
    await w.clock.advance(10_500)
    const before = w.to('/status').length
    await w.clock.advance(20_000)
    expect(w.to('/status').length - before).toBeGreaterThanOrEqual(4)
    await $.turn.complete({ ...DONE, turnId: 't1' })
    const after = w.to('/status').length
    await w.clock.advance(20_000)
    expect(w.to('/status').length).toBe(after)
  })
})

describe('telling you what is going on', () => {
  test('a failed drop-in says why in the transcript, not a toast that vanishes', async ($, on) => {
    const w = world(on)
    w.daemon.play = { ok: false, phase: 'ready', error: 'Prism Launcher was not found.' }
    await $.session.start(START)
    await $.command.run({ command: 'pvp', args: 'play', ...TYPED })
    await w.clock.advance(100)
    expect(w.logs.some((l) => l.includes('Prism Launcher was not found'))).toBe(true)
  })

  test('while the arena boots and Minecraft starts, the status line follows along', async ($, on) => {
    const w = world(on)
    w.daemon.play = { ok: true, phase: 'booting' }
    w.daemon.humans = []
    await $.session.start(START)
    await $.command.run({ command: 'pvp', args: 'play', ...TYPED })
    await w.clock.advance(100)
    expect(w.statuses.at(-1)).toContain('warming up')
    w.daemon.launching = true
    await w.clock.advance(4_100)
    expect(w.statuses.at(-1)).toContain('starting Minecraft')
    w.daemon.humans = ['Fatih']
    w.daemon.launching = false
    await w.clock.advance(4_100)
    expect(w.statuses.at(-1)).toBe('⚔ in the arena')
  })

  test('a problem found later (after boot) shows up on the next poll', async ($, on) => {
    const w = world(on)
    w.daemon.play = { ok: true, phase: 'booting' }
    w.daemon.humans = []
    await $.session.start(START)
    await $.command.run({ command: 'pvp', args: 'play', ...TYPED })
    w.daemon.notice = 'Prism Launcher was not found.'
    w.daemon.paused = true
    await w.clock.advance(4_100)
    expect(w.logs.some((l) => l.includes('Prism Launcher was not found'))).toBe(true)
    expect(w.statuses.at(-1)).toBe('⚔ pvp on')
  })
})

describe('only real blockers pull you out', () => {
  test("Claude idling while you play after /pvp play doesn't pull you out", async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.command.run({ command: 'pvp', args: 'play', ...TYPED })
    await w.clock.advance(100)
    expect(w.to('/play').length).toBe(1)
    await w.clock.advance(60_000)
    await $.classic.Notification({ message: 'Claude is waiting for your input', notification_type: 'idle_prompt' } as never)
    expect(w.to('/pause').length).toBe(0)
  })

  test('a permission prompt notification does pull you out', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.command.run({ command: 'pvp', args: 'play', ...TYPED })
    await w.clock.advance(100)
    await $.classic.Notification({ message: 'Claude needs your permission', notification_type: 'permission_prompt' } as never)
    expect(w.to('/pause').at(-1)!.body.reason).toBe('permission')
  })
})

describe('the question step', () => {
  test('approving a long command puts you back in while it runs, not after', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'wait then ask me', turnId: 't1' })
    await w.clock.advance(11_000)
    expect(w.to('/play').length).toBe(1)
    const finish = w.startCall((c) => $.tool.call(c as never), { tool: 'Bash', command: 'sleep 25', tool_use_id: 'u7' })
    await w.clock.advance(10)
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'sleep 25' } } as never)
    expect(w.to('/pause').at(-1)!.body.reason).toBe('permission')
    // Approved: the command runs, and Claude Code shows its background hint
    await $.ui.render({
      surface: 'terminal',
      component: 'ToolProgress',
      requestId: 'u7',
      props: { tool_use_id: 'u7', kind: 'background_hint', hint: '(ctrl+b to run in background)' },
    } as never)
    await w.clock.advance(2_500)
    // Back in while the command still runs
    expect(w.to('/play').length).toBe(2)
    await finish()
  })

  test("Claude's question pulls you out as a question", async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'ask me', turnId: 't1' })
    await w.clock.advance(11_000)
    await $.tool.call({ tool: 'AskUserQuestion', questions: [], tool_use_id: 'u8' } as never)
    expect(w.to('/pause').at(-1)!.body.reason).toBe('question')
  })

  test('permission answers and tool results pass through unchanged', async ($, on) => {
    const w = world(on)
    w.permission.answer = { decision: { behavior: 'deny', message: 'not here' } }
    await $.session.start(START)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await w.clock.advance(11_000)
    const answer = await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } } as never)
    expect(answer).toEqual({ decision: { behavior: 'deny', message: 'not here' } })
    const result = await $.tool.call({ tool: 'Read', file_path: '/proj/a.ts', tool_use_id: 'r1' } as never)
    expect(result).toEqual({ result: 'ok' })
  })

  test('a permission request a settings hook answers never pulls you out', async ($, on) => {
    const w = world(on)
    w.permission.answer = { decision: { behavior: 'allow' } }
    await $.session.start(START)
    await $.turn.start({ text: 'go', turnId: 't1' })
    await w.clock.advance(11_000)
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'ls' } } as never)
    expect(w.to('/pause').length).toBe(0)
  })
})

describe('back in right after you answer', () => {
  test('answering a permission prompt mid-fight puts you back in about 1.5 s later', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'deploy', turnId: 't1' })
    await w.clock.advance(11_000)
    expect(w.to('/play').length).toBe(1)
    const finish = w.startCall((c) => $.tool.call(c as never), { tool: 'Bash', command: 'npm publish', tool_use_id: 'p1' })
    await w.clock.advance(10)
    await $.classic.PermissionRequest({ tool_name: 'Bash', tool_input: { command: 'npm publish' } } as never)
    expect(w.to('/pause').at(-1)!.body.reason).toBe('permission')
    // Approved; a quick command runs and returns
    await finish()
    await w.clock.advance(1_600)
    expect(w.to('/play').length).toBe(2)
  })

  test('answering a question mid-fight puts you back in too', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'ask me', turnId: 't1' })
    await w.clock.advance(11_000)
    await $.tool.call({ tool: 'AskUserQuestion', questions: [], tool_use_id: 'q1' } as never)
    expect(w.to('/pause').at(-1)!.body.reason).toBe('question')
    await w.clock.advance(1_600)
    expect(w.to('/play').length).toBe(2)
  })

  test('if Claude finishes right after your answer, you are not flicked back in', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'ask me', turnId: 't1' })
    await w.clock.advance(11_000)
    await $.tool.call({ tool: 'AskUserQuestion', questions: [], tool_use_id: 'q2' } as never)
    await w.clock.advance(500)
    await $.turn.complete({ ...DONE, turnId: 't1' })
    await w.clock.advance(5_000)
    expect(w.to('/play').length).toBe(1)
  })

  test('a question before you were ever dropped in keeps the normal 10 s rule', async ($, on) => {
    const w = world(on)
    await $.session.start(START)
    await $.turn.start({ text: 'ask me first', turnId: 't1' })
    await w.clock.advance(3_000)
    await $.tool.call({ tool: 'AskUserQuestion', questions: [], tool_use_id: 'q3' } as never)
    await w.clock.advance(5_000)
    expect(w.to('/play').length).toBe(0)
    await w.clock.advance(6_000)
    expect(w.to('/play').length).toBe(1)
  })
})
