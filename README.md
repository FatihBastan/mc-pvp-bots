# ⚔ MC PvP Bots

**Fight Minecraft PvP bots while Claude works. Get handed back the moment it's done.**

You send Claude a big task. Instead of watching a spinner, you're dropped into a small arena with up to 8 bots. When Claude finishes, or needs an answer from you, the fight freezes and your terminal comes back.

It all runs on your own computer. No servers to pay for, no accounts besides your own Minecraft.

<!-- Add a short GIF here: drop-in → fight → "Claude's done" → back in the terminal -->

---

## Install

In Claude Code:

```
/plugin marketplace add FatihBastan/mc-pvp-bots
/plugin install mc-pvp-bots@mc-pvp-bots
/pvp on
```

The first `/pvp on` asks you to accept Minecraft's EULA, then sets everything up. It takes a couple of minutes, once. Progress shows under the prompt. The first time you're dropped in, Prism also downloads Minecraft 1.21.4 for its own instance, so that first launch is slower.

## What you need

- **Minecraft: Java Edition** (you need to own it)
- **[Prism Launcher](https://prismlauncher.org)**, with your Microsoft account added once. On Windows: `winget install --exact PrismLauncher.PrismLauncher`
- **Java 21** or newer, e.g. [Temurin 21](https://adoptium.net)
- **Node.js 20** or newer
- **Claude Code 2.1.287** or newer
- 4–6 GB of free memory while you play

Don't want Prism? Set the launcher to `manual` and join `127.0.0.1:25599` from your normal Minecraft launcher.

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
Not from the arena. The server only accepts connections from your own computer, and it reports nothing anywhere (the server's built-in usage stats are switched off). The only downloads are the one-time setup: the Paper server, the bot library, and Minecraft itself through Prism. Minecraft talks to Microsoft as usual when you log in, like it always does.

**What happens if I close something?**
Nothing is left running. Close Minecraft and the bots stop. Quit or crash Claude Code and the arena pauses by itself. When nobody's used it for 15 minutes, it shuts down and closes the Minecraft it opened. It never touches your other Minecraft instances.

**Can I play with friends?**
Not yet. It's you against bots, on your own machine.

**Does it work on Windows and Linux?**
Yes. Switching windows works best on macOS and Linux (X11). On Wayland and some Windows setups you may have to alt-tab yourself; the game tells you when.

**Why Minecraft 1.21.4?**
It's the version the bots are most reliable on. Prism installs it for you in a separate instance, so your own Minecraft is untouched.

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
