# How MC PvP Bots works

This is the technical side: what runs where, how it cleans up after itself, and how it's kept safe. For what the mod does and how to install it, see the [README](../README.md).

## The pieces

```
hooks/register.ts    the mod: when to drop in / pull out, /pvp, status line, spinner
arena/ctl.mjs        setup, and starting/stopping the daemon (the mod runs it with node)
arena/daemon.mjs     one per machine: control API on 127.0.0.1:25601 (token-protected)
arena/server.mjs     Paper download, config, console, arena build, kits, titles
arena/bots.mjs       mineflayer bots and their fighting
arena/brain.mjs      targeting, focus cap, tiers, grace/AFK (pure, unit-tested)
arena/client.mjs     Prism instance, options.txt, servers.dat, launch
arena/focus.mjs      bringing Minecraft or the terminal to the front; closing our Minecraft
arena/proc.mjs       finding and stopping only our own processes
arena/runtime/       the bots' package.json and lockfile
```

The mod itself only decides *when*: it listens to Claude Code's turn, tool and permission events and talks to the daemon over HTTP. The daemon owns the Paper server and the bots, and outlives a single Claude Code session, so several sessions share one arena.

Everything lives in `~/.claude-pvp`:

- `runtime/` holds the bots' packages.
- `server/` holds Paper and its world.
- `daemon.log` is the arena's own log.
- `server/logs/latest.log` is the server's log.

## A turn, step by step

1. **`turn.start`:** the mod makes sure the daemon is up (starting it is cheap if it already is) and arms a 10 s timer.
2. **Timer fires:** `POST /play`.
   - The daemon unfreezes the bots and gives every human a grace countdown.
   - If Minecraft isn't connected, it launches the Prism instance with `--server 127.0.0.1:25599`.
3. **While you play:** the mod polls `/status` every 4 s for the spinner score. That poll is also the arena's lease.
4. **Claude needs you:** a permission dialog (`classic.PermissionRequest` with no settings hook answering it), `AskUserQuestion`/`ExitPlanMode`, or a "needs input" notification sends `POST /pause` with reason `permission` or `question`: red banner, bell, terminal to the front. The mod only watches these events and passes them on unchanged.
   - Once you answer (the tool call ends, or an approved command starts running), you go back in after 1.5 s and the 3-2-1 countdown, during which the bots are frozen too.
5. **`turn.complete`:** `POST /pause`.
   - The bots freeze, and you get Resistance V and Weakness so nobody can score while you're away.
   - The daemon switches you to the terminal after the hand-back delay.

**Grace and AFK.** Each human is in one of three states: `grace`, `fight` or `afk`.
- AFK means no camera rotation for `afkSeconds`, as any bot sees it.
- Rotation is the signal because alt-tabbing releases the mouse and every key, while knockback still moves you.
- Protected players are invisible to bot targeting.

**Focus cap.** At most `round(bots / 4)` bots target a human at once. A bot the human just hit may go one over.

## Built to stay light

**Client** (only its own Prism instance):
- 60 fps cap, vsync off, render distance 4, fast graphics, no clouds, minimal particles, no music
- `pauseOnLostFocus:false`, so alt-tabbing never opens the menu
- First-launch screens skipped so the auto-join isn't blocked

**Server:**
- A void world with one 41×41 arena, view and simulation distance 4
- No mob spawning, no network compression, async chunk writes

**Bots:**
- All bots run in one Node process.
- They do nothing while frozen.

**Lifecycle:** everything stays up between turns, and shuts down after 15 idle minutes.

## When you leave, nothing keeps running

| You… | What happens |
| :- | :- |
| `/exit` or Ctrl+C mid-fight | The arena freezes on the way out, then idles out after 15 minutes, closing the Minecraft it launched. |
| Close the terminal, or Claude Code crashes or is killed | The 4 s check-ins stop. The arena pauses within 20 s, then idles out. |
| Close Minecraft mid-fight | The bots stop at once. The next long turn relaunches it. |
| Minecraft never connects | The arena stands down after 2.5 min. |
| `/pvp off` or `/pvp stop` | The server, bots and our Minecraft close now. |
| The daemon is killed (even `kill -9`) or crashes | On macOS/Linux, a small `sh` watcher stops the server within seconds. On every OS, a leftover server is stopped through its pid file before the next one starts. |
| The server crashes | Bots disconnect at once. The server restarts up to 3 times; after that, the next drop-in retries. |
| Claude Code quits while the arena boots | The pending drop-in is dropped, so Minecraft won't pop up for a session that's gone. |
| Setup is cut off halfway | The half-finished install is redone, never half-used. |

## Security

**Network:**
- Nothing listens beyond this machine. The game server and the control port both bind to `127.0.0.1`.
- Paper's bStats metrics are switched off.
- The bots ignore chat and log in offline, to localhost only.

**The control API:**
- Every request needs a random token from `~/.claude-pvp/control.json`. The folder is `0700` and the file `0600`.
- It refuses any Host header but `127.0.0.1`/`localhost`, so a DNS-rebinding web page can't use it.
- It sends no CORS headers, and request bodies are capped at 16 KB.

**Inputs:**
- Requests can't make the daemon run or write anything you didn't configure. The Prism path comes only from your own settings, at start.
- Window-switching inputs are checked against strict patterns before they reach `open`, `xdotool` or PowerShell.
- Player names must match Minecraft's name rules before they go into server commands.
- No shell is used, except npm on Windows, with fixed arguments.

**Stopping processes:** every kill re-checks the target's command line first. It must be our server's jar path, or Prism launching the `claude-pvp` instance.

**Downloads:**
- Paper comes over HTTPS and must match its published SHA-256.
- The bots' packages are installed with `npm ci` from the shipped lockfile (hash-checked), with install scripts disabled. `npm audit` is clean.

**Known trade-off:** the server runs in offline mode so the bots need no accounts. On a shared computer, another local user could join the arena under any name. They'd only be another player, with no commands or ops.

## Platform notes

- **macOS:** switching windows uses System Events. The first time, macOS asks to let your terminal control your computer (Privacy & Security → Accessibility).
- **Linux:** needs `xdotool` or `wmctrl` on X11. Wayland doesn't let programs raise other windows.
- **Windows:** PowerShell brings windows to the front with `SetForegroundWindow`, walking up from Claude Code's process to its terminal window (Windows Terminal, VS Code, Cursor and others by name as a fallback). Leftover servers are cleaned up through the pid file (there's no `sh` watcher).
- **Minecraft 1.21.4 is pinned:** later versions renamed gamerules and changed command syntax, and mineflayer's pathfinding is best tested there.

## Developing

```
npm test                          # arena tests, then `claude plugin test .`
claude plugin validate .          # manifest + hooks module
claude --plugin-dir .             # run your working copy
```

The arena tests run the real daemon against a fake server: the play flow, every exit above, and attacks on the control API. They don't cover the bots fighting on a real Paper server, which needs Minecraft's download servers.

Before publishing a fork, change `USER_AGENT` in `arena/server.mjs`. PaperMC's download API asks clients to identify themselves with a contact URL.
