// The Minecraft client side: a Prism Launcher instance of our own, tuned for
// speed, that joins the local arena on launch.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'
import { MC_VERSION } from './server.mjs'

export const INSTANCE_ID = 'claude-pvp'
const DATA_VERSION_1_21_4 = 4189

// Ours alone: written every launch so the arena always runs light
const FAST_OPTIONS = {
  version: String(DATA_VERSION_1_21_4),
  maxFps: '60',
  enableVsync: 'false',
  renderDistance: '4',
  simulationDistance: '5',
  graphicsMode: '0',
  renderClouds: '"false"',
  particles: '2',
  entityShadows: 'false',
  biomeBlendRadius: '0',
  mipmapLevels: '0',
  // Alt-tabbing back to Claude must not open the pause menu
  pauseOnLostFocus: 'false',
  fullscreen: 'false',
  // First-launch screens that would stall the auto-join
  onboardAccessibility: 'false',
  skipMultiplayerWarning: 'true',
  tutorialStep: 'none',
  joinedFirstServer: 'true',
  realmsNotifications: 'false',
  soundCategory_music: '0.0',
  autoJump: 'false',
}

export function prismCandidates(platform = process.platform, env = process.env, home = homedir()) {
  const out = []
  if (platform === 'darwin') {
    out.push({
      exe: ['/Applications/Prism Launcher.app/Contents/MacOS/prismlauncher'],
      data: join(home, 'Library/Application Support/PrismLauncher'),
    })
    out.push({
      exe: [join(home, 'Applications/Prism Launcher.app/Contents/MacOS/prismlauncher')],
      data: join(home, 'Library/Application Support/PrismLauncher'),
    })
  } else if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? join(home, 'AppData/Local')
    const roaming = env.APPDATA ?? join(home, 'AppData/Roaming')
    const data = join(roaming, 'PrismLauncher')
    // The installer (per user, then for everyone), winget (same installer), scoop, then PATH
    out.push({ exe: [join(local, 'Programs/PrismLauncher/prismlauncher.exe')], data })
    out.push({ exe: [join(env.ProgramFiles ?? 'C:/Program Files', 'PrismLauncher/prismlauncher.exe')], data })
    out.push({ exe: [join(env.SCOOP ?? join(home, 'scoop'), 'apps/prismlauncher/current/prismlauncher.exe')], data })
    for (const dir of (env.PATH ?? '').split(';')) {
      if (dir && existsSync(join(dir, 'prismlauncher.exe'))) {
        out.push({ exe: [join(dir, 'prismlauncher.exe')], data })
        break
      }
    }
  } else {
    const xdg = env.XDG_DATA_HOME ?? join(home, '.local/share')
    for (const dir of (env.PATH ?? '').split(':')) {
      if (dir && existsSync(join(dir, 'prismlauncher'))) {
        out.push({ exe: [join(dir, 'prismlauncher')], data: join(xdg, 'PrismLauncher') })
        break
      }
    }
    if (existsSync('/var/lib/flatpak/app/org.prismlauncher.PrismLauncher') || existsSync(join(home, '.local/share/flatpak/app/org.prismlauncher.PrismLauncher'))) {
      out.push({
        exe: ['flatpak', 'run', 'org.prismlauncher.PrismLauncher'],
        data: join(home, '.var/app/org.prismlauncher.PrismLauncher/data/PrismLauncher'),
        isFlatpak: true,
      })
    }
  }
  return out
}

// { exe: string[], data: string } or null. `override` is a path to the
// executable; its data folder is guessed from the platform.
export function findPrism({ override = '', dataOverride = '' } = {}) {
  const candidates = prismCandidates()
  const withData = (c) => ({ ...c, data: dataOverride || portableData(c.exe[0]) || c.data })
  if (override) return withData({ exe: [override], data: candidates[0]?.data || '' })
  for (const c of candidates) {
    if (c.isFlatpak || existsSync(c.exe[0])) return withData(c)
  }
  return null
}

// A portable Prism (a portable.txt beside the executable; scoop installs
// often are) keeps its instances and accounts in its own folder
function portableData(exe) {
  if (!exe || !isAbsolute(exe)) return null
  const dir = dirname(exe)
  return existsSync(join(dir, 'portable.txt')) ? dir : null
}

async function instancesDir(prismData) {
  // Respect a custom instance folder set in Prism's settings
  try {
    const cfg = await readFile(join(prismData, 'prismlauncher.cfg'), 'utf8')
    const m = /^InstanceDir=(.+)$/m.exec(cfg)
    if (m) {
      const dir = m[1].trim()
      return isAbsolute(dir) ? dir : join(prismData, dir)
    }
  } catch {}
  return join(prismData, 'instances')
}

// Only a hint for setup ("add your account in Prism"). accounts.json holds
// sign-in tokens, so it is never opened: an empty list is a few dozen bytes,
// one account is well over a kilobyte.
export async function hasPrismAccount(prismData) {
  try {
    return (await stat(join(prismData, 'accounts.json'))).size > 200
  } catch {
    return false
  }
}

export function mergeOptions(existing, wanted) {
  const lines = existing.split(/\r?\n/).filter((l) => l.length > 0)
  const seen = new Set()
  const out = lines.map((line) => {
    const i = line.indexOf(':')
    const key = i < 0 ? line : line.slice(0, i)
    if (key in wanted) {
      seen.add(key)
      return `${key}:${wanted[key]}`
    }
    return line
  })
  for (const [k, v] of Object.entries(wanted)) if (!seen.has(k)) out.push(`${k}:${v}`)
  return out.join('\n') + '\n'
}

// servers.dat is uncompressed NBT: { servers: [ { name, ip } ] }
export function serversDat(entries) {
  const parts = []
  const u8 = (n) => parts.push(Buffer.from([n]))
  const u16 = (n) => {
    const b = Buffer.alloc(2)
    b.writeUInt16BE(n)
    parts.push(b)
  }
  const i32 = (n) => {
    const b = Buffer.alloc(4)
    b.writeInt32BE(n)
    parts.push(b)
  }
  const str = (s) => {
    const b = Buffer.from(s, 'utf8')
    u16(b.length)
    parts.push(b)
  }
  u8(10)
  str('') // root compound
  u8(9)
  str('servers')
  u8(10) // list of compounds
  i32(entries.length)
  for (const e of entries) {
    u8(8)
    str('name')
    str(e.name)
    u8(8)
    str('ip')
    str(e.ip)
    u8(1)
    str('hidden')
    u8(0)
    u8(0) // end of entry
  }
  u8(0) // end of root
  return Buffer.concat(parts)
}

export async function ensureInstance(prismData, serverPort) {
  const dir = join(await instancesDir(prismData), INSTANCE_ID)
  const mc = join(dir, 'minecraft')
  await mkdir(mc, { recursive: true })
  const cfg = join(dir, 'instance.cfg')
  if (!existsSync(cfg)) {
    await writeFile(
      cfg,
      ['[General]', 'InstanceType=OneSix', 'name=Claude PvP', 'iconKey=default', 'OverrideMemory=true', 'MinMemAlloc=512', 'MaxMemAlloc=2048', ''].join('\n'),
    )
  }
  const pack = join(dir, 'mmc-pack.json')
  if (!existsSync(pack)) {
    await writeFile(
      pack,
      JSON.stringify({ components: [{ uid: 'net.minecraft', version: MC_VERSION, important: true }], formatVersion: 1 }, null, 2),
    )
  }
  const optionsPath = join(mc, 'options.txt')
  const existing = existsSync(optionsPath) ? await readFile(optionsPath, 'utf8') : ''
  await writeFile(optionsPath, mergeOptions(existing, FAST_OPTIONS))
  await writeFile(join(mc, 'servers.dat'), serversDat([{ name: 'Claude PvP', ip: `127.0.0.1:${serverPort}` }]))
  return dir
}

// Starts Minecraft through Prism, joining the arena; returns at once
export function launchClient(prism, serverPort, log = () => {}) {
  const [cmd, ...pre] = prism.exe
  const args = [...pre, '--launch', INSTANCE_ID, '--server', `127.0.0.1:${serverPort}`]
  log(`launching: ${cmd} ${args.join(' ')}`)
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false })
  child.on('error', (err) => log(`launch failed: ${err.message}`))
  child.unref()
  return child.pid
}
