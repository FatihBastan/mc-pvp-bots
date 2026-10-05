// The bots: one Node process runs all of them, so the coordinator sees every
// target and can cap how many go after the human at once.

import { createRequire } from 'node:module'
import { join } from 'node:path'
import {
  TIERS,
  botNames,
  chooseTarget,
  cooldownTicks,
  humanFocusCap,
  laggedPosition,
  swingLands,
} from './brain.mjs'

const MELEE_ENTER = 4.0 // switch from pathfinding to hand-driven fighting
const MELEE_EXIT = 5.5 // and back, with a gap so it doesn't flicker
const HISTORY_MS = 700

export function loadBotLibraries(runtimeDir) {
  const require = createRequire(join(runtimeDir, 'package.json'))
  return {
    mineflayer: require('mineflayer'),
    pathfinder: require('mineflayer-pathfinder'),
  }
}

export class BotSwarm {
  constructor({ libs, host, port, version, log = () => {}, onBotSpawn = () => {}, rand = Math.random }) {
    this.libs = libs
    this.host = host
    this.port = port
    this.version = version
    this.log = log
    this.onBotSpawn = onBotSpawn
    this.rand = rand
    this.bots = new Map() // name -> BotController
    this.targets = new Map() // name -> target name
    this.humans = new Set()
    this.paused = true
    this.stopped = false
    this.protected = new Set()
    this.lookAt = new Map() // human name -> { look, at }
    this.generation = 0
  }

  get names() {
    return [...this.bots.keys()]
  }

  isBot(name) {
    return this.bots.has(name)
  }

  get cap() {
    return humanFocusCap(this.bots.size)
  }

  // Makes the live roster match `tiers`, joining one bot at a time
  async setRoster(tiers) {
    const names = botNames(tiers)
    const wanted = new Map(names.map((n, i) => [n, tiers[i]]))
    for (const [name, ctl] of this.bots) {
      if (wanted.get(name) !== ctl.tier) {
        ctl.quit()
        this.bots.delete(name)
        this.targets.delete(name)
      }
    }
    const generation = this.generation
    for (const [name, tier] of wanted) {
      if (this.stopped || generation !== this.generation) return
      if (this.bots.has(name)) continue
      const ctl = new BotController(this, name, tier)
      this.bots.set(name, ctl)
      ctl.connect()
      await new Promise((r) => setTimeout(r, 350))
    }
  }

  pause() {
    this.paused = true
    for (const ctl of this.bots.values()) ctl.halt()
    this.targets.clear()
  }

  resume() {
    this.paused = false
  }

  setHumans(names) {
    this.humans = new Set(names)
  }

  // Humans the bots must leave alone right now (grace countdown or AFK)
  setProtected(names) {
    this.protected = new Set(names)
    for (const [bot, target] of this.targets) if (this.protected.has(target)) this.targets.delete(bot)
  }

  // When each human's camera last turned, as any connected bot sees it.
  // Turning is the tell: alt-tabbing releases every key and the mouse, while
  // knockback still moves you, so position alone would lie.
  observeHumans(now = Date.now()) {
    for (const name of this.humans) {
      let entity = null
      for (const ctl of this.bots.values()) {
        entity = ctl.bot?.entity ? ctl.bot.players?.[name]?.entity : null
        if (entity) break
      }
      if (!entity) {
        this.lookAt.delete(name)
        continue
      }
      const look = `${entity.yaw?.toFixed(3)}:${entity.pitch?.toFixed(3)}:${entity.headYaw?.toFixed(3)}`
      const seen = this.lookAt.get(name)
      if (!seen || seen.look !== look) this.lookAt.set(name, { look, at: now })
    }
  }

  // ms timestamp of the last camera turn, or null when no bot can see them
  lastLookAt(name) {
    return this.lookAt.get(name)?.at ?? null
  }

  // The server went away: drop every bot now instead of letting each retry
  // against a dead port. setRoster brings them back when it is up again.
  disconnectAll() {
    this.generation++
    for (const ctl of this.bots.values()) ctl.quit()
    this.bots.clear()
    this.targets.clear()
  }

  stop() {
    this.stopped = true
    this.disconnectAll()
  }

  // Everyone alive that a bot could fight, with positions from its own view
  candidatesFor(bot) {
    const out = []
    for (const player of Object.values(bot.players)) {
      const ent = player.entity
      if (!ent || player.username === bot.username) continue
      if (!this.humans.has(player.username) && !this.bots.has(player.username)) continue
      if (this.protected.has(player.username)) continue
      if (ent.metadata && ent.health === 0) continue
      out.push({ name: player.username, pos: ent.position, isHuman: this.humans.has(player.username), entity: ent })
    }
    return out
  }
}

export class BotController {
  constructor(swarm, name, tier) {
    this.swarm = swarm
    this.name = name
    this.tier = tier
    this.t = TIERS[tier]
    this.bot = null
    this.mode = 'idle' // idle | chase | melee
    this.ticks = 0
    this.lastAttackTick = -100
    this.nextRetargetAt = 0
    this.attacker = null
    this.history = new Map() // target name -> [{t,x,y,z}]
    this.strafeDir = null
    this.strafeUntil = 0
    this.critPendingUntilTick = -1
    this.critPlanned = false
    this.sprintResumeTick = -1
    this.reconnectTimer = null
  }

  connect() {
    const { mineflayer, pathfinder } = this.swarm.libs
    const bot = mineflayer.createBot({
      host: this.swarm.host,
      port: this.swarm.port,
      username: this.name,
      version: this.swarm.version,
      auth: 'offline',
      hideErrors: true,
      viewDistance: 'tiny',
      checkTimeoutInterval: 60_000,
    })
    this.bot = bot
    bot.loadPlugin(pathfinder.pathfinder)

    bot.once('spawn', () => {
      const moves = new pathfinder.Movements(bot)
      moves.canDig = false
      moves.allow1by1towers = false
      moves.allowParkour = true
      moves.allowSprinting = true
      moves.scafoldingBlocks = []
      bot.pathfinder.setMovements(moves)
      bot.pathfinder.thinkTimeout = 200 // tiny arena: never think long
    })
    bot.on('spawn', () => {
      this.retries = 0
      this.halt()
      this.swarm.onBotSpawn(this.name)
    })
    bot.on('physicsTick', () => this.tick())
    bot.on('entityHurt', (entity, source) => {
      if (entity === bot.entity && source?.username) this.attacker = { name: source.username, at: Date.now() }
    })
    bot.on('kicked', (reason) => this.swarm.log(`[bot ${this.name}] kicked: ${JSON.stringify(reason).slice(0, 200)}`))
    bot.on('error', (err) => this.swarm.log(`[bot ${this.name}] error: ${err.message}`))
    bot.on('end', () => {
      if (this.swarm.stopped || this.swarm.bots.get(this.name) !== this) return
      // The server restarted or dropped us: try again, backing off to 30 s so a
      // dead server doesn't get hammered for as long as the daemon lives
      this.retries = (this.retries ?? 0) + 1
      const delay = Math.min(30_000, 3000 * 2 ** (this.retries - 1))
      this.reconnectTimer = setTimeout(() => this.connect(), delay)
    })
  }

  quit() {
    clearTimeout(this.reconnectTimer)
    try {
      this.bot?.quit()
    } catch {}
  }

  halt() {
    const bot = this.bot
    if (!bot) return
    this.mode = 'idle'
    this.strafeDir = null
    try {
      bot.pathfinder?.setGoal(null)
      bot.clearControlStates()
    } catch {}
  }

  remember(candidates, now) {
    for (const c of candidates) {
      let h = this.history.get(c.name)
      if (!h) this.history.set(c.name, (h = []))
      h.push({ t: now, x: c.pos.x, y: c.pos.y, z: c.pos.z })
      while (h.length > 2 && now - h[0].t > HISTORY_MS) h.shift()
    }
  }

  tick() {
    const bot = this.bot
    const swarm = this.swarm
    if (!bot?.entity || swarm.paused || bot.health <= 0) return
    this.ticks++
    const now = Date.now()
    const candidates = swarm.candidatesFor(bot)
    this.remember(candidates, now)

    // Retarget on this tier's rhythm, or at once when the target is gone
    let target = swarm.targets.get(this.name)
    const targetAlive = candidates.find((c) => c.name === target)
    if (!targetAlive || now >= this.nextRetargetAt) {
      const others = new Map([...swarm.targets].filter(([n]) => n !== this.name))
      target = chooseTarget({
        self: { name: this.name, pos: bot.entity.position },
        current: targetAlive ? target : null,
        candidates,
        targets: others,
        cap: swarm.cap,
        attacker: this.attacker,
        now,
      })
      this.nextRetargetAt = now + this.t.retargetMs * (0.75 + swarm.rand() * 0.5)
      if (target) swarm.targets.set(this.name, target)
      else swarm.targets.delete(this.name)
    }
    const foe = candidates.find((c) => c.name === target)
    if (!foe) return this.halt()

    const real = bot.entity.position.distanceTo(foe.pos)
    if (this.mode !== 'melee' && real <= MELEE_ENTER && Math.abs(foe.pos.y - bot.entity.position.y) < 1.5) {
      this.mode = 'melee'
      bot.pathfinder.setGoal(null)
    } else if (this.mode === 'melee' && real > MELEE_EXIT) {
      this.mode = 'idle'
      bot.clearControlStates()
    }

    if (this.mode !== 'melee') {
      // A respawned player is a new entity, so compare ids, not names
      if (this.mode !== 'chase' || this.chasingId !== foe.entity.id) {
        const { goals } = swarm.libs.pathfinder
        bot.pathfinder.setGoal(new goals.GoalFollow(foe.entity, 2), true)
        this.mode = 'chase'
        this.chasingId = foe.entity.id
      }
      return
    }
    this.chasingId = null
    this.fight(bot, foe, real, now)
  }

  fight(bot, foe, real, now) {
    const t = this.t
    const rand = this.swarm.rand
    const lagged = laggedPosition(this.history.get(foe.name) ?? [], now, t.reactionMs) ?? foe.pos
    const laggedDist = bot.entity.position.distanceTo(lagged)
    const drift = Math.hypot(foe.pos.x - lagged.x, foe.pos.z - lagged.z)

    // Look where we think they are (a beat late), at chest height
    bot.lookAt(foe.pos.offset(lagged.x - foe.pos.x, 1.2 + (lagged.y - foe.pos.y), lagged.z - foe.pos.z), true)

    // Close in to just inside reach, back off if hugging
    bot.setControlState('forward', laggedDist > t.reach - 0.4)
    bot.setControlState('back', laggedDist < 1.1)
    if (this.ticks >= this.sprintResumeTick) bot.setControlState('sprint', laggedDist > t.reach - 0.4)

    // Strafe in bursts
    if (now >= this.strafeUntil) {
      this.strafeDir = rand() < t.strafe ? (rand() < 0.5 ? 'left' : 'right') : null
      this.strafeUntil = now + 500 + rand() * 900
    }
    bot.setControlState('left', this.strafeDir === 'left')
    bot.setControlState('right', this.strafeDir === 'right')

    const since = this.ticks - this.lastAttackTick
    const cooldown = cooldownTicks(this.tier)

    // Crit: jump about six ticks before the sword is charged, so the way down
    // lines up with a full charge, like a player timing it
    if (this.critPlanned && this.critPendingUntilTick < 0 && since >= cooldown - 6 && bot.entity.onGround) {
      bot.setControlState('jump', true)
      this.critPendingUntilTick = this.ticks + 12
    } else if (this.critPendingUntilTick >= 0 && !bot.entity.onGround) {
      bot.setControlState('jump', false)
    }
    if (since < cooldown) return
    if (this.critPendingUntilTick >= 0) {
      const falling = !bot.entity.onGround && bot.entity.velocity.y < -0.08
      if (!falling && this.ticks < this.critPendingUntilTick) return
      bot.setControlState('jump', false)
      this.critPendingUntilTick = -1
    }

    this.lastAttackTick = this.ticks
    this.critPlanned = rand() < t.crit
    if (swingLands({ tier: this.tier, realDistance: real, laggedDistance: laggedDist, drift, rand })) {
      bot.attack(foe.entity)
      // W-tap: drop sprint for two ticks so the next hit knocks back again
      if (rand() < t.wtap) {
        bot.setControlState('sprint', false)
        this.sprintResumeTick = this.ticks + 2
      }
    } else {
      bot.swingArm('right')
    }
  }
}
