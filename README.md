# ⚔ MC PvP Bots

**Fight Minecraft PvP bots while Claude works. Get handed back the moment it's done.**

You send Claude a big task. Instead of watching a spinner, you're dropped into a small arena with up to 8 bots. When Claude finishes, or needs an answer from you, the fight freezes and your terminal comes back.

It all runs on your own computer. No servers to pay for, no accounts besides your own Minecraft.

---

## 1. Before you start

You need:

- **Minecraft: Java Edition.** You need to own it.
- **[Prism Launcher](https://prismlauncher.org).** Open it once and add your Microsoft account. You don't need to create any profile; the mod makes its own.
- **Java 21** or newer
- **Node.js 20** or newer
- **Claude Code 2.1.287** or newer. Check with `claude --version`, and update with `claude update`.
- 4–6 GB of free memory while you play

On **Windows**, install the first three with:

```
winget install --exact --id PrismLauncher.PrismLauncher --source winget
winget install --exact --id EclipseAdoptium.Temurin.21.JDK --source winget
winget install --exact --id OpenJS.NodeJS.LTS --source winget
```

On **macOS**:

```
brew install --cask prismlauncher temurin@21
brew install node
```

Open a new terminal afterwards so `java` and `node` are found.

Don't want Prism? Set the launcher to `manual` in `/config` and join `127.0.0.1:25599` from your normal Minecraft launcher, using version 1.21.4.

## 2. Install

In Claude Code:

```
/plugin marketplace add FatihBastan/mc-pvp-bots
/plugin install mc-pvp-bots@mc-pvp-bots
/reload-plugins
```

Restarting Claude Code works instead of `/reload-plugins`.

## 3. First run

```
/pvp on
```

1. Accept Minecraft's EULA when asked. Setup runs once and takes a couple of minutes; watch the line under the prompt.
2. Wait for **"Arena ready"**.
3. Try it right away with `/pvp play`. Minecraft opens and joins the arena. The very first launch downloads Minecraft 1.21.4 into Prism, so give it a minute.

After that, just use Claude as usual. Any task that keeps Claude busy for more than 10 seconds drops you in.

## How it plays

- **Short questions never interrupt you.** You're only pulled in once Claude has been working for 10 seconds.
- **3… 2… 1… FIGHT.** Every time you enter, you get a countdown where nobody can hit you.
- **Only 1–2 bots chase you at once** (one more if you hit it). The rest fight each other, so you can crash their fights.
- **Need to check on Claude mid-fight?** Just alt-tab. After 2 seconds without moving the camera you're marked AFK: safe, and ignored by every bot. Move the camera when you're back and you get a fresh countdown.
- **Claude needs you** (a permission, a question, a form)? The bots freeze, a bell rings, a red banner says what it needs, and your terminal comes back. Answer it and you're straight back in the fight after a 3-2-1.
- **Claude's done?** Everything freezes, your terminal comes back, and you get your score: `Claude's done · ⚔ 3 kills, 1 death`.

The spinner shows your live score while you play, e.g. `⚔ 2K 1D`.

## The bots

| | Reacts in | Misses | Tricks |
| :- | -: | -: | :- |
| **Rookie** | 420 ms | often | mostly walks straight at you |
| **Brawler** | 260 ms | sometimes | strafes, the odd crit |
| **Duelist** | 160 ms | rarely | strafes, crits, combos |
| **Sweat** | 90 ms | almost never | all of it, all the time |

The default 8-bot lobby has 2 Rookies, 3 Brawlers, 2 Duelists and 1 Sweat. Everyone gets iron armor and a diamond sword that never breaks.

## Commands

| | |
| :- | :- |
| `/pvp` | Is it on, is the arena up, who's in it |
| `/pvp on` · `/pvp off` | Start or stop being dropped in. Off also closes everything. |
| `/pvp bots 4` · `6` · `8` | How many bots |
| `/pvp difficulty mixed` · `easy` · `medium` · `hard` | How good they are |
| `/pvp play` | Jump in right now |
| `/pvp stop` | Close the arena now |

Timings, window switching and more are in `/config`, under mc-pvp-bots.

## FAQ

**Does it slow Claude down?**
No. The game runs in its own processes. Minecraft is capped at 60 fps with low render distance, the server is a tiny empty world, and the bots do nothing while frozen.

**Does anything get sent online?**
Not from the arena. The server only accepts connections from your own computer, and it reports nothing anywhere (the server's built-in usage stats are switched off). The only downloads are the one-time setup: the Paper server, the bot library, and Minecraft itself through Prism. Minecraft talks to Microsoft as usual when you log in, like it always does. The full list is under [What it runs and sends](#what-it-runs-and-sends).

**What happens if I close something?**
Nothing is left running. Close Minecraft and the bots stop. Quit or crash Claude Code and the arena pauses by itself. When nobody's used it for 15 minutes, it shuts down and closes the Minecraft it opened. It never touches your other Minecraft instances.

**Can I play with friends?**
Not yet. It's you against bots, on your own machine.

**Does it work on Windows and Linux?**
Yes. Switching windows works best on macOS and Linux (X11). On Wayland and some Windows setups you may have to alt-tab yourself; the game tells you when.

**Why Minecraft 1.21.4?**
It's the version the bots are most reliable on. Prism installs it for you in a separate instance, so your own Minecraft is untouched.

## What it runs and sends

Everything the mod does outside Claude Code, for anyone who wants to check before installing.

**Programs it starts**

- `node arena/ctl.mjs` from the plugin folder, with `setup`, `ensure` or `stop`. `ensure` starts the arena in the background (`node arena/daemon.mjs`), and `stop` shuts it down.
- The arena runs Java with the Paper server (kept in `~/.claude-pvp`), listening on 127.0.0.1 only, and the bots inside its own Node process.
- Prism Launcher, to start Minecraft in its own "Claude PvP" instance.
- Setup, once: `npm ci --omit=dev --ignore-scripts` in `arena/runtime`, which installs the bot library exactly as the lockfile pins it and runs no install scripts.
- To switch between the game and your terminal: PowerShell on Windows, `open` and `osascript` on macOS, `xdotool` or `wmctrl` on Linux.
- To find and close only its own processes: `ps` or PowerShell, and `taskkill` on Windows. It checks a process's command line before closing it, so it never touches your other Minecraft.

**What goes over the network**

- Setup downloads, once: the Paper server from papermc.io over https (its sha256 is checked before it's used), the bot library from the npm registry (pinned by the lockfile), and Minecraft 1.21.4 through Prism.
- After that, the mod only talks to the arena on your own computer, at `http://127.0.0.1:25601` (the control port in `/config`). It sends: the number of bots, the difficulty, your timing settings, the Claude Code session id (so each session gets a fresh leaderboard), and which terminal window to bring back (its app id, window id, `TERM_PROGRAM`, and Claude Code's process id). It never sends your prompts, Claude's answers, files or tool inputs, there or anywhere else.
- Each of those requests carries a random token that setup creates in `~/.claude-pvp/control.json` (readable only by you), so other programs on your computer can't control the arena. It isn't a login for any online service and never leaves your computer.
- No telemetry, and Paper's usage stats are switched off.

**What it reads**

- Environment: `HOME` or `USERPROFILE` (where to keep `~/.claude-pvp`), and `TERM_PROGRAM`, `WINDOWID` and `__CFBundleIdentifier` (which window to switch back to).
- Prism's settings, to find its instances folder. It never opens Prism's accounts file; it only checks the file isn't empty, to remind you to add your account.

**What each hook does**

| Hook | Why |
| :- | :- |
| `turn.start`, `turn.complete` | Start the 10-second drop-in timer, and hand you back when Claude is done |
| `tool.call` | Notice when Claude asks you something (AskUserQuestion, ExitPlanMode) and when a call ends, to put you back in. Every call and its result pass through unchanged. |
| `classic.PermissionRequest` | Notice that a permission dialog is about to show, so the fight freezes and your terminal comes back. It decides nothing: the request goes on unchanged, and Claude Code, your settings and you answer it. The mod never approves, denies or changes a permission. |
| `classic.Notification`, `classic.ElicitationResult` | Notice other "Claude needs you" prompts, and forms you've filled in |
| `ui.render` (Spinner, ToolProgress) | Show your score next to the spinner, and spot when an approved command starts running |
| `command.run` (`/pvp` only) | The `/pvp` command |
| `session.start`, `session.end` | Load your settings, and freeze the arena when you quit Claude Code |

## Uninstall

```
/pvp off
/plugin uninstall mc-pvp-bots@mc-pvp-bots
```

Then delete the `~/.claude-pvp` folder, and the "Claude PvP" instance in Prism if you like.

---

Curious how it works, or want to hack on it? See [HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md).

Made by Fatih Baştan · MIT License · Bots by [mineflayer](https://github.com/PrismarineJS/mineflayer), server by [Paper](https://papermc.io)

*NOT AN OFFICIAL MINECRAFT PRODUCT. NOT APPROVED BY OR ASSOCIATED WITH MOJANG OR MICROSOFT.*
