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
| "play daft punk" | Opens Spotify on those search results — see the note below |
| "search spotify for daft punk" | The same, said the other way round |
| "listen to miles davis on spotify" | The same again — naming Spotify always means a search |
| "play rust tutorial on youtube" | Plays the first result, in your default browser |
| "search youtube for rust tutorial" | Opens the results and plays nothing — the verb decides |
| "play one more time by daft punk on youtube" | Naming the artist with **by** pins the exact video |
| "open bluetooth" / "open wifi" / "open display" | Opens that Windows settings page |
| "open networks" | The WiFi flyout, to pick a network by hand |
| "connect to home" | Joins a WiFi network Windows has already saved |
| "sleep the pc" / "hibernate" / "shut down" | Exactly that, immediately and with no confirmation |

A tap of the same key still opens the panel and never touches speech recognition.

**Or click the microphone** at the right of the search bar. The panel gets out of the way and
Ezzy listens — then notices when you stop talking and runs the command itself, with nothing to
press at the end. Say nothing and it gives the microphone back after a few seconds.

**The verb decides, and the service decides what is possible.**

Say **play** (or "watch", "listen to") and Ezzy reads the first video's id out of YouTube's own
results page and opens that video, which starts it playing. Say **search** (or "find", "look
up") and it opens the results list and plays nothing — which is also the faster of the two,
since finding the first video is what costs the extra second.

Spotify only ever shows results, whatever verb you use, and that is not a preference either. Spotify's search page carries no track
ids at all — they arrive later over an authenticated call — so there is nothing to open, and
"play daft punk" puts Spotify on the results for you to pick from.

If the id cannot be had in a moment — a slow connection, a consent page, a change to YouTube's
markup — Ezzy opens the results page instead. That is the same thing it always did, so the
worst case is a search rather than an error. It costs about a second before the browser opens,
which is the price of knowing what to open.

**Why Spotify cannot do the same.** Ezzy puts Spotify on the results for what you named
and stops there, and that is a limit rather than an oversight. Starting a *named* track needs
a playable id (`spotify:track:…`), and turning "daft punk" into an id means the Spotify Web
API — an explicit non-goal (see `PLAN.md` §1), and Premium-only for playback besides. The
obvious shortcut, firing a play key after the search, was built and removed: a media key is
not addressed to anything, so Windows hands it to whatever owns the current media session. It
resumes — or pauses — the track that was already there, and never the artist you just asked
for.

"play spotify" still opens Spotify itself, and "play" on its own is still the media key. A
name that matches something on this machine wins over a search for that name; naming the
service ("… on spotify") always means the search.

The speech model (`ggml-base.en.bin`, ~141MB) downloads the first time you hold the hotkey,
with progress shown on the dot. Voice can be turned off entirely in Settings, and off means
off: no microphone, no download, and the speech engine is shut down.

### Three-finger tap

Windows can map a touchpad gesture to a shortcut, which is the nicest way to open Ezzy:

**Settings → Bluetooth & devices → Touchpad → Three-finger gestures → Tap → Custom shortcut**,
then record **Alt+Space**. Ezzy's own Settings window has a **Set up** button that opens that
page for you.

Ezzy reads no gestures itself and never will (`PLAN.md` §1) — Windows turns the tap into the
shortcut, and Ezzy only ever sees the shortcut.

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
- **"connect to X" opens the network list instead of connecting.** It only joins networks
  Windows has already saved, and only when the name matches one of them unambiguously — six
  networks starting "AAU-" are not a match for "AAU". It never handles passwords, adds
  profiles, or turns the radio on, and it never guesses: joining a neighbour's saved network
  by accident is a worse outcome than showing you the list.

## Privacy

Everything runs on your machine. Audio never leaves it — speech recognition is whisper.cpp
running as a local process, not a cloud API. There is no telemetry, no account, and no
analytics.

Ezzy makes exactly three kinds of network request, and nothing else ever leaves the machine:

1. The update check against GitHub Releases.
2. The one-time speech model download. Turn voice off and this never happens.
3. **A YouTube search, only when you ask to play one.** "play X on youtube" fetches that
   search's results page to find the first video, so it can open it directly. "search youtube
   for X" makes no request at all — it just opens the results in your browser. It is the same page your
   browser would load, with no key and no account; the query goes to YouTube and nowhere else,
   and nothing about it is stored. No other command makes a request — Spotify, app launching
   and window switching are entirely local.

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
