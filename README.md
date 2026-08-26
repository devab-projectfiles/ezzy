# Ezzy

A floating dot that switches windows and launches apps, for Windows.

When a lot is open, the taskbar overflows and hides the thing you want. Switching means
minimising, hunting, or going out to the desktop and back. Ezzy is a small always-on-top dot
that sits over everything: click it, press **Alt+Space**, or hold Alt+Space and say what you
want. Every open window and every installed app is one keystroke away, and you never leave
the app you were in.

- **Window switcher** — every real open window, most-recently-used first. Type two letters,
  press Enter.
- **Launcher** — everything in your Start Menu, including Store apps. Not running? It starts.
- **Voice** — hold the hotkey, say "switch to chrome", let go. Runs locally, on your machine.
  Labelled beta on purpose: the keyboard path is the one that has to be flawless.
- **Always there** — over fullscreen apps, on every virtual desktop, through sleep and
  reboot. Never in the taskbar or Alt-Tab.

## Install

### Scoop (recommended)

No SmartScreen warning, and `scoop update` keeps it current.

```powershell
scoop install https://raw.githubusercontent.com/devab-projectfiles/ezzy/main/scoop/ezzy.json
```

Update later with `scoop update ezzy`.

### Installer

Download `Ezzy-Setup-x.y.z.exe` from
[Releases](https://github.com/devab-projectfiles/ezzy/releases) and run it. It installs for
your user only, so there is no UAC prompt, and it updates itself from then on.

**Windows will show a blue "Windows protected your PC" screen.** Ezzy is not code-signed — a
certificate costs a few hundred dollars a year and needs a hardware token, and this is a free
MIT-licensed app. To get past it:

> Click **More info**, then **Run anyway**.

If that makes you uncomfortable, use Scoop instead, or build it yourself from source — the
instructions are below and the whole thing is in this repo.

Antivirus software occasionally flags it for the same reason it flags every launcher: a
global keyboard hook and window enumeration look like a keylogger to a heuristic scanner.
Nothing here sends anything anywhere; see [Privacy](#privacy).

## Using it

| | |
|---|---|
| **Alt+Space** (or click the dot) | Open the panel |
| Type | Filters open windows and installed apps together |
| ↑ ↓, Enter | Move and pick — Enter focuses a window or launches an app |
| Esc | Close |
| **Hold Alt+Space** | Listen. Speak, then let go |
| Drag the dot | Move it. Each monitor remembers where you put it |
| Right-click the tray icon | Settings, log file, quit |

The hotkey is configurable — **Settings → Shortcut** — because Alt+Space is the Windows system
menu and other launchers want it too. If something else already owns it when Ezzy starts, it
takes the next free shortcut and tells you which.

### Voice

Hold the hotkey, speak, let go:

| Say | What happens |
|-----|--------------|
| "switch to chrome" / "open chrome" | Focuses the window if it is open, launches the app if it is not |
| "chrome" | The same — a bare name works when the verb gets clipped |
| "close this window" | Closes the window you were last in |
| "close chrome" | Closes that window |
| "close all windows" | Asks every open window to close |
| "open github.com" | Opens the URL, or a path that exists |
| "play" / "pause" / "next" / "previous" | Media keys, for whatever is playing |
| "sleep the pc" / "hibernate" / "shut down" | Exactly that, immediately and with no confirmation |

A tap of the same key still opens the panel and never touches speech recognition.

The speech model (`ggml-base.en.bin`, ~141MB) downloads the first time you hold the hotkey,
with progress shown on the dot. Voice can be turned off entirely in Settings, and off means
off: no microphone, no download, and the speech engine is shut down.

### Three-finger tap

Windows can map a touchpad gesture to a shortcut, which is the nicest way to open Ezzy:

**Settings → Bluetooth & devices → Touchpad → Three-finger gestures → Tap → Custom shortcut**,
then record **Alt+Space**.

## Settings

Right-click the tray icon → **Settings…**

- **Shortcut** — click the field and press the keys you want. (Alt+Space cannot be *recorded*,
  because Windows opens its own system menu on that combination — use **Reset** to go back to
  it.)
- **Voice commands** — the whole voice feature, on or off.
- **Show the panel while listening** — off by default, so a spoken command does not throw a
  window list over what you were reading. The dot itself reports what it heard.
- **Speak confirmations** — says what it did, and why a command missed.
- **Start Ezzy when Windows starts** — on by default.

Everything is stored in `%APPDATA%\Ezzy\config.json`, which you can also edit by hand.

## When something goes wrong

Ezzy writes a log to `%APPDATA%\Ezzy\logs\ezzy.log` — tray menu → **Open log file**. Attach
it to a [bug report](https://github.com/devab-projectfiles/ezzy/issues); it is the difference
between a fix and a guessing game.

- **The dot is gone.** Tray menu → Show, or → Reset dot position if it ended up off-screen
  after a monitor changed.
- **The hotkey does nothing.** Something else owns it. The tray tooltip shows the shortcut
  actually in force; change it in Settings.
- **Voice says the microphone is blocked.** Windows Settings → Privacy & security →
  Microphone. Ezzy's own error links straight there.
- **A game covers the dot.** Fullscreen-exclusive apps cover everything. That is Windows, not
  Ezzy.

## Privacy

Everything runs on your machine. Audio never leaves it — speech recognition is whisper.cpp
running as a local process, not a cloud API. There is no telemetry, no account, and no
analytics. Ezzy makes exactly two kinds of network request: the update check against GitHub
Releases, and the one-time speech model download. Turn voice off and the second never happens.

## Development

```bash
npm install
npm run fetch:whisper   # whisper.cpp binaries, not committed to git
npm run dev             # or: npm run dev:verbose, for the timing instrumentation
```

`PLAN.md` is the spec — it explains what is built, what was deliberately cut, and the Win32
gotchas that are already solved. Read it before changing anything.

```bash
npm run typecheck
npm run lint
npm run build:win       # dist/Ezzy-Setup-x.y.z.exe + dist/Ezzy-x.y.z-portable.zip
```

### Cutting a release

1. Bump `version` in `package.json`.
2. `npm run build:win` — produces the installer, the portable zip, and `latest.yml`, which is
   the auto-update feed.
3. `npm run scoop:manifest` — rewrites `scoop/ezzy.json` with the new version and the zip's
   hash. Commit it.
4. Publish a GitHub release tagged `vx.y.z` with **all** of `Ezzy-Setup-x.y.z.exe`,
   `Ezzy-Setup-x.y.z.exe.blockmap`, `Ezzy-x.y.z-portable.zip` and `latest.yml` attached.
   The blockmap is what lets the *next* release download as a delta instead of another
   100MB — leave it off and every update is a full download.
   (`GH_TOKEN=... npm run publish:win` does the upload for you, as a draft.)
5. Installed copies pick it up within six hours, or immediately from Settings → Check.

Installer copies update themselves. Scoop copies update through `scoop update ezzy` — Ezzy
knows which one it is and says so in Settings rather than downloading an installer that would
sit beside your Scoop install instead of replacing it.

## License

MIT.
