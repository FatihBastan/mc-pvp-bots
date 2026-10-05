// Drives one BotController against a stand-in mineflayer bot, tick by tick.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BotController, BotSwarm } from '../bots.mjs'

class V {
  constructor(x, y, z) {
    Object.assign(this, { x, y, z })
  }
  distanceTo(o) {
    return Math.hypot(this.x - o.x, this.y - o.y, this.z - o.z)
  }
  offset(dx, dy, dz) {
    return new V(this.x + dx, this.y + dy, this.z + dz)
  }
}

class GoalFollow {
  constructor(entity, range) {
    Object.assign(this, { entity, range })
  }
}

function fakeBot(name, pos, players) {
  const calls = { attack: 0, swing: 0, goals: [], look: 0 }
  const controls = {}
  return {
    calls,
    controls,
    username: name,
    health: 20,
    entity: { position: pos, onGround: true, velocity: new V(0, 0, 0) },
    players,
    pathfinder: { setGoal: (g) => calls.goals.push(g) },
    setControlState: (k, v) => (controls[k] = v),
    clearControlStates: () => Object.keys(controls).forEach((k) => (controls[k] = false)),
    lookAt: () => calls.look++,
    attack: () => calls.attack++,
    swingArm: () => calls.swing++,
    // Just enough vanilla jump physics for crit timing
    step() {
      const e = this.entity
      if (controls.jump && e.onGround) {
        e.onGround = false
        e.velocity = new V(0, 0.42, 0)
      } else if (!e.onGround) {
        const y = e.position.y + e.velocity.y
        e.velocity = new V(0, (e.velocity.y - 0.08) * 0.98, 0)
        e.position = new V(e.position.x, Math.max(100, y), e.position.z)
        if (y <= 100) {
          e.onGround = true
          e.velocity = new V(0, 0, 0)
        }
      }
    },
  }
}

function setup(tier, foePos, humans = []) {
  const players = {
    Target: { username: 'Target', entity: { id: 7, position: foePos } },
  }
  const swarm = new BotSwarm({ libs: { pathfinder: { goals: { GoalFollow } } }, host: '', port: 0, version: '', rand: mulberry(42) })
  swarm.setHumans(humans)
  swarm.bots.set('Target', { tier: 'easy', halt() {}, quit() {} }) // so the bot counts it as a fighter
  const ctl = new BotController(swarm, `${tier}_bot`, tier)
  swarm.bots.set(ctl.name, ctl)
  ctl.bot = fakeBot(ctl.name, new V(0, 100, 0), players)
  players[ctl.name] = { username: ctl.name, entity: ctl.bot.entity }
  return { swarm, ctl }
}

function mulberry(seed) {
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

test('paused bots do nothing', () => {
  const { ctl } = setup('hard', new V(2, 100, 0))
  for (let i = 0; i < 40; i++) ctl.tick()
  assert.equal(ctl.bot.calls.attack + ctl.bot.calls.swing, 0)
})

test('far targets are chased with the pathfinder, near ones fought by hand', () => {
  const { swarm, ctl } = setup('medium', new V(15, 100, 0))
  swarm.resume()
  ctl.tick()
  assert.ok(ctl.bot.calls.goals.at(-1) instanceof GoalFollow)
  assert.equal(ctl.mode, 'chase')
  // Target walks up close
  ctl.bot.players.Target.entity.position = new V(2.5, 100, 0)
  for (let i = 0; i < 3; i++) ctl.tick()
  assert.equal(ctl.mode, 'melee')
  assert.equal(ctl.bot.calls.goals.at(-1), null)
})

test('swing rate respects the tier cooldown', () => {
  const swings = (tier) => {
    const { swarm, ctl } = setup(tier, new V(2.2, 100, 0))
    swarm.resume()
    for (let i = 0; i < 200; i++) {
      ctl.bot.step()
      ctl.tick()
    } // 10 seconds
    return ctl.bot.calls.attack + ctl.bot.calls.swing
  }
  const sweat = swings('sweat')
  const easy = swings('easy')
  if (process.env.SHOW_RATES) console.log('swings in 10 s', { sweat, hard: swings('hard'), medium: swings('medium'), easy })
  // Full-charge swords: at most ~15 swings in 10 s (crit jumps eat some ticks)
  assert.ok(sweat <= 16 && sweat >= 8, `sweat swung ${sweat}`)
  assert.ok(easy < sweat, `easy ${easy} vs sweat ${sweat}`)
})

test('pausing mid-fight stops movement and clears targets', () => {
  const { swarm, ctl } = setup('hard', new V(2, 100, 0))
  swarm.resume()
  for (let i = 0; i < 20; i++) ctl.tick()
  swarm.pause()
  assert.equal(swarm.targets.size, 0)
  assert.ok(Object.values(ctl.bot.controls).every((v) => v === false))
})

test('protected humans (grace, AFK) are never targeted', () => {
  const { swarm, ctl } = setup('sweat', new V(2, 100, 0), ['Target'])
  swarm.bots.delete('Target') // a human now, not a bot
  swarm.setProtected(['Target'])
  swarm.resume()
  for (let i = 0; i < 60; i++) {
    ctl.bot.step()
    ctl.tick()
  }
  assert.equal(ctl.bot.calls.attack + ctl.bot.calls.swing, 0)
  swarm.setProtected([])
  for (let i = 0; i < 60; i++) {
    ctl.bot.step()
    ctl.tick()
  }
  assert.ok(ctl.bot.calls.attack + ctl.bot.calls.swing > 0, 'fair game once protection ends')
})

test('camera tracking: a still camera ages, a turn refreshes it', () => {
  const { swarm, ctl } = setup('easy', new V(2, 100, 0), ['Target'])
  const target = ctl.bot.players.Target.entity
  target.yaw = 1
  target.pitch = 0
  swarm.observeHumans(1000)
  swarm.observeHumans(5000)
  assert.equal(swarm.lastLookAt('Target'), 1000)
  target.yaw = 1.2
  swarm.observeHumans(6000)
  assert.equal(swarm.lastLookAt('Target'), 6000)
})
