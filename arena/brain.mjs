// Pure decision logic for the bots: tiers, the roster mix, and who to fight.
// No Minecraft or network code here, so it can be unit-tested on its own.

// What separates the tiers. reactionMs is how stale the bot's view of its
// target is (it aims where the target WAS), aimJitter is the chance a swing
// whiffs against a moving target, reach is kept at or under vanilla's 3.0.
export const TIERS = {
  easy: { label: 'Rookie', reactionMs: 420, aimJitter: 0.35, reach: 2.6, cooldownSlackTicks: 7, strafe: 0.15, crit: 0.0, wtap: 0.0, retargetMs: 1600 },
  medium: { label: 'Brawler', reactionMs: 260, aimJitter: 0.2, reach: 2.85, cooldownSlackTicks: 3, strafe: 0.4, crit: 0.25, wtap: 0.2, retargetMs: 1200 },
  hard: { label: 'Duelist', reactionMs: 160, aimJitter: 0.1, reach: 3.0, cooldownSlackTicks: 1, strafe: 0.65, crit: 0.5, wtap: 0.5, retargetMs: 900 },
  sweat: { label: 'Sweat', reactionMs: 90, aimJitter: 0.04, reach: 3.0, cooldownSlackTicks: 0, strafe: 0.85, crit: 0.75, wtap: 0.8, retargetMs: 700 },
}

export const BOT_COUNTS = [4, 6, 8]
export const DIFFICULTIES = ['mixed', 'easy', 'medium', 'hard']

// Mixed rosters skew easy so most bots are third-party food, with one or two
// that can actually beat you.
const MIXED = {
  4: ['easy', 'medium', 'medium', 'hard'],
  6: ['easy', 'easy', 'medium', 'medium', 'hard', 'sweat'],
  8: ['easy', 'easy', 'medium', 'medium', 'medium', 'hard', 'hard', 'sweat'],
}

export function normalizeCount(count) {
  const n = Number(count)
  return BOT_COUNTS.includes(n) ? n : 8
}

export function tierMix(count, difficulty = 'mixed') {
  const n = normalizeCount(count)
  if (difficulty === 'mixed' || !TIERS[difficulty]) return [...MIXED[n]]
  return Array.from({ length: n }, () => difficulty)
}

// Usernames are stable per slot so the scoreboard keeps each bot's kills
export function botNames(tiers) {
  const seen = {}
  return tiers.map((tier) => {
    seen[tier] = (seen[tier] ?? 0) + 1
    return `${TIERS[tier].label}_${seen[tier]}`
  })
}

// How many bots may chase the human at once. Without a cap, 8 bots in an FFA
// all pick the nearest juicy target and you die in two seconds.
export function humanFocusCap(botCount) {
  return Math.max(1, Math.round(botCount / 4))
}

function distance(a, b) {
  const dx = a.x - b.x
  const dy = a.y - b.y
  const dz = a.z - b.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

/**
 * Picks the name of the player this bot should fight, or null.
 *   self        { name, pos }
 *   current     name of the current target or null
 *   candidates  [{ name, pos, isHuman }] every other living player
 *   targets     Map botName -> targetName for the OTHER bots
 *   cap         max bots on the human at once
 *   attacker    { name, at } who last hit this bot, or null
 *   now         ms
 */
export function chooseTarget({ self, current, candidates, targets, cap, attacker, now }) {
  const onHuman = (name) => {
    let count = 0
    for (const [bot, target] of targets) if (bot !== self.name && target === name) count++
    return count
  }
  const isRecentAttacker = (name) => attacker && attacker.name === name && now - attacker.at < 3000
  let best = null
  let bestScore = Infinity
  for (const c of candidates) {
    if (c.name === self.name) continue
    if (c.isHuman) {
      const limit = isRecentAttacker(c.name) ? cap + 1 : cap
      if (onHuman(c.name) >= limit) continue
    }
    let score = distance(self.pos, c.pos)
    if (c.name === current) score -= 3 // stickiness: don't flip-flop between equal targets
    if (isRecentAttacker(c.name)) score -= 5 // hit back whoever hit you
    if (score < bestScore) {
      bestScore = score
      best = c.name
    }
  }
  return best
}

/**
 * Where to aim given a position history of { t, x, y, z } (oldest first):
 * the position reactionMs ago, linearly interpolated.
 */
export function laggedPosition(history, now, reactionMs) {
  if (history.length === 0) return null
  const t = now - reactionMs
  if (t <= history[0].t) return history[0]
  for (let i = history.length - 1; i > 0; i--) {
    const a = history[i - 1]
    const b = history[i]
    if (a.t <= t && t <= b.t) {
      const k = b.t === a.t ? 0 : (t - a.t) / (b.t - a.t)
      return { t, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z + (b.z - a.z) * k }
    }
  }
  return history[history.length - 1]
}

/**
 * Whether a swing lands. A bot sees its target reactionMs late, so against a
 * target that moved since then it can whiff; aimJitter scales how often.
 */
export function swingLands({ tier, realDistance, laggedDistance, drift, rand = Math.random }) {
  const t = TIERS[tier]
  if (realDistance > t.reach) return false // the server would reject it anyway
  if (laggedDistance > t.reach + 0.6) return false // it thinks you're out of range
  const missChance = Math.min(0.9, t.aimJitter * (1 + drift))
  return rand() >= missChance
}

// Full-charge sword swing in 1.9+ combat is 12.5 ticks (attack speed 1.6)
export function cooldownTicks(tier) {
  return 13 + TIERS[tier].cooldownSlackTicks
}

export function arenaSpawnPoint(rand = Math.random, half = 17) {
  const corner = () => (rand() < 0.5 ? -1 : 1) * (6 + Math.floor(rand() * (half - 6)))
  return { x: corner() + 0.5, y: 100, z: corner() + 0.5 }
}

// What each human is doing while the arena is live (not paused):
//   grace  protected and ignored by bots until `until`; a countdown shows
//   fight  normal play
//   afk    no mouse movement for afkMs (alt-tabbed to Claude, most likely):
//          protected and ignored until they move again, then grace
// `lastLookAt` is when their camera last turned, or null when no bot can see
// them (then they count as active, so a blind spot never parks anyone).
export function nextHumanState(s, { now, lastLookAt, afkMs, graceMs }) {
  const looked = lastLookAt ?? now
  if (s.mode === 'grace') return now >= s.until ? { mode: 'fight', since: now } : s
  if (s.mode === 'fight') return now - Math.max(looked, s.since) > afkMs ? { mode: 'afk', since: now } : s
  if (s.mode === 'afk') return looked > s.since ? { mode: 'grace', until: now + graceMs } : s
  return s
}

export function isProtected(s) {
  return s.mode === 'grace' || s.mode === 'afk'
}

// Whole seconds left on a grace countdown, for the title (3, 2, 1)
export function countdownLeft(s, now) {
  return s.mode === 'grace' ? Math.max(0, Math.ceil((s.until - now) / 1000)) : 0
}

// Bots fight only while the arena is live, someone is in it, and nobody is
// on a 3-2-1 countdown (everything holds still until FIGHT)
export function botsShouldFight({ paused, humanCount, modes }) {
  if (paused || humanCount === 0) return false
  return !modes.some((m) => m === 'grace')
}
