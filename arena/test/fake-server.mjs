// Stands in for Paper in tests: prints the lines the daemon parses and records
// every console command it receives.
//   FAKE_LOG        file to append received commands to
//   FAKE_HUMAN      the human who joins after boot (default Steve)
//   FAKE_BOOT_MS    how long "booting" takes (default 150)
//   FAKE_LEAVE_MS   if set, the human leaves this long after the first FIGHT
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const logPath = process.env.FAKE_LOG
const human = process.env.FAKE_HUMAN ?? 'Steve'
const bootMs = Number(process.env.FAKE_BOOT_MS ?? 150)
const leaveMs = process.env.FAKE_LEAVE_MS ? Number(process.env.FAKE_LEAVE_MS) : null
const say = (s) => process.stdout.write(`[12:00:00 INFO]: ${s}\n`)

setTimeout(() => {
  say('Done (0.123s)! For help, type "help"')
  setTimeout(() => say(`${human} joined the game`), 100)
}, bootMs)

// Like Paper: losing the console (stdin closed) does NOT stop the server
setInterval(() => {}, 60_000)
process.on('SIGTERM', () => {
  if (logPath) appendFileSync(logPath, '#SIGTERM\n')
  process.exit(0)
})

let fought = false
createInterface({ input: process.stdin }).on('line', (line) => {
  if (logPath) appendFileSync(logPath, line + '\n')
  if (line === 'stop') {
    say('Stopping server')
    process.exit(0)
  }
  // When the daemon announces a fight, stage one kill and one death
  if (line.startsWith(`title ${human} title`) && line.includes('FIGHT') && !fought) {
    fought = true
    setTimeout(() => {
      say(`Rookie_1 was slain by ${human}`)
      say(`${human} was slain by Sweat_1`)
    }, 50)
    if (leaveMs !== null) setTimeout(() => say(`${human} left the game`), leaveMs)
  }
})
