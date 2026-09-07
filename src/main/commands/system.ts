/** Windows settings pages and saved WiFi networks (FEATURE-system-commands.md).
 *
 *  Two commands, registry data like everything else. No new dependencies, no
 *  elevation, and nothing here that the user could not do themselves in the Settings app —
 *  which is the whole scope: Ezzy gets you to the page or joins a network Windows already
 *  knows. It never handles a password, adds a profile, or touches a radio.
 *
 *  **On not shadowing `open X`.** The feature note's worry is that a settings command sitting
 *  in front of the launcher eats "open chrome", and its answer is to register afterwards and
 *  fall through on a miss. The registry has no fall-through — the first pattern to match owns
 *  the utterance — so that answer is not available, and a settings command registered after
 *  `open` would simply never run.
 *
 *  The fix is to make shadowing impossible rather than recoverable: the pattern carries the
 *  page names inside it, so "open bluetooth" matches and "open chrome" is not even a candidate.
 *  A closed list of eleven pages does the job a fuzzy match was meant to do, without a
 *  threshold that could one day decide "Notion" is close enough to "networks". The cost is that
 *  a name outside the list is not recognised, which is why the list carries the ways people
 *  actually say these — including the two-word spellings whisper produces. */

import { openShellTarget } from '../launcher'
import { log } from '../verbose'
import { hidePanel } from '../windows'
import { connectTo, currentNetwork, matchProfile, refreshProfiles, savedProfiles } from '../wifi'
import { CommandContext, register } from './registry'

/** Windows exposes a URI for every Settings page. One lookup table, and `ms-availablenetworks:`
 *  which is the WiFi flyout rather than a page. */
const SETTINGS_PAGES: Record<string, string> = {
  wifi: 'ms-settings:network-wifi',
  bluetooth: 'ms-settings:bluetooth',
  display: 'ms-settings:display',
  sound: 'ms-settings:sound',
  battery: 'ms-settings:batterysaver',
  touchpad: 'ms-settings:devices-touchpad',
  printers: 'ms-settings:printers',
  apps: 'ms-settings:appsfeatures',
  update: 'ms-settings:windowsupdate',
  privacy: 'ms-settings:privacy-microphone',
  networks: 'ms-availablenetworks:'
}

/** What people say, mapped to the page they mean. The spoken form is what matters here, not
 *  the name Microsoft gave the page: nobody asks for "batterysaver", and whisper writes
 *  "bluetooth" as two words often enough to be worth a line. */
const ALIASES: Record<string, keyof typeof SETTINGS_PAGES> = {
  wifi: 'wifi',
  'wi fi': 'wifi',
  'wi-fi': 'wifi',
  wireless: 'wifi',
  bluetooth: 'bluetooth',
  'blue tooth': 'bluetooth',
  display: 'display',
  screen: 'display',
  monitor: 'display',
  brightness: 'display',
  sound: 'sound',
  audio: 'sound',
  volume: 'sound',
  battery: 'battery',
  power: 'battery',
  touchpad: 'touchpad',
  trackpad: 'touchpad',
  'touch pad': 'touchpad',
  gestures: 'touchpad',
  printer: 'printers',
  printers: 'printers',
  apps: 'apps',
  applications: 'apps',
  'installed apps': 'apps',
  update: 'update',
  updates: 'update',
  'windows update': 'update',
  privacy: 'privacy',
  microphone: 'privacy',
  'mic settings': 'privacy',
  networks: 'networks',
  'available networks': 'networks',
  'network list': 'networks',
  'wifi list': 'networks'
}

/** Built from the alias table so the two cannot drift: a name that is not in there cannot
 *  match, and one that is cannot be missed. Longest first, so "windows update" wins over
 *  "update" rather than leaving " windows" stranded in front of it. */
const SETTINGS_NAMES = Object.keys(ALIASES)
  .sort((a, b) => b.length - a.length)
  .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|')

/** "open bluetooth", "open the wifi settings", "show me display settings", "go to updates". */
const OPEN_SETTINGS = new RegExp(
  `^(?:open|show|show me|go to|take me to|launch)\\s+(?:the\\s+)?(?:settings\\s+)?(${SETTINGS_NAMES})(?:\\s+(?:settings?|page|panel))?$`
)

/** "connect to wifi", "connect wi-fi", "join a network", "connect me to the internet".
 *
 *  A request to connect that names no network. It has to be its own pattern and it has to come
 *  first, because WIFI_CONNECT's `(.+?)` happily takes "wifi" as the name of a network and
 *  answers a perfectly reasonable request with "I don't have a saved network called wifi" —
 *  which is true, and useless. The answer to "connect to wifi" is the list. */
const WIFI_LIST =
  /^(?:connect|reconnect|join)(?:\s+(?:to|me\s+to))?\s+(?:the\s+|a\s+|my\s+)?(?:wifi|wi\s?-?\s?fi|wireless|internet|network|networks)$/

/** "connect to home", "connect to the office wifi", "join AAU-SFA-Student". */
const WIFI_CONNECT =
  /^(?:connect|reconnect|join)(?:\s+(?:to|me\s+to))?\s+(?:the\s+)?(.+?)(?:\s+(?:wifi|wi-fi|network))?$/

export function registerSystemCommands(): void {
  register({
    id: 'open-settings',
    title: 'Windows settings pages',
    group: 'system',
    summary:
      'Opens a Windows settings page directly. It knows a closed list of pages, so it can never mistake an application for one.',
    examples: ['open bluetooth', 'show me display settings', 'go to windows update'],
    match: OPEN_SETTINGS,
    describe: (groups) => `Opening ${groups[1]} settings`,
    run: async (groups, ctx) => {
      const page = ALIASES[groups[1]]
      const uri = SETTINGS_PAGES[page]
      // Through Explorer, which is exactly what an `ms-settings:` URI is for — a shell
      // namespace target. openMicrophoneSettings has done this since chunk D.
      if (!(await openShellTarget(uri, `${page} settings`))) {
        ctx.failed(`I couldn’t open ${page} settings`)
        return
      }
      hidePanel()
    }
  })

  // Before `wifi-connect`, which would read "wifi" as the name of a network to look for. The
  // registry has no fall-through, so the pattern that means something more specific has to be
  // registered ahead of the one that would swallow it.
  register({
    id: 'wifi-list',
    title: 'Show the networks',
    group: 'system',
    summary: 'Opens the list of networks in range, for when you want to pick one yourself.',
    examples: ['connect to wifi', 'join a network'],
    match: WIFI_LIST,
    describe: () => 'Here are the networks',
    run: async (_groups, ctx) => {
      // The saved names go in the log rather than into the sentence: the flyout this opens is
      // already showing them, along with the ones in range, which is more than Ezzy knows.
      const saved = await savedProfiles()
      log(`wifi: showing the network list (${saved.length} saved)`)
      if (!(await openShellTarget(SETTINGS_PAGES.networks, 'the network list'))) {
        ctx.failed('I couldn’t open the network list')
        return
      }
      hidePanel()
    }
  })

  register({
    id: 'wifi-connect',
    title: 'Join a network',
    group: 'system',
    summary:
      'Connects to a network Windows has already saved. It never handles a password and never adds a profile. If the name matches nothing, it shows you the list instead of guessing.',
    examples: ['connect to home', 'join the office wifi'],
    match: WIFI_CONNECT,
    describe: (groups) => `Connecting to ${groups[1]}`,
    run: (groups, ctx) => joinNetwork(groups[1], ctx)
  })
}

async function joinNetwork(spoken: string, ctx: CommandContext): Promise<void> {
  let saved = await savedProfiles()
  let target = matchProfile(spoken, saved)

  // A name that does not match is most often one saved since Ezzy last looked.
  if (target === null) {
    await refreshProfiles()
    saved = await savedProfiles()
    target = matchProfile(spoken, saved)
  }

  if (target === null) {
    // Not a failure with an apology: the user asked to join something, and the list of what
    // they can join is one keystroke away. the rule about the blocked microphone applies to
    // every dead end — it has to lead somewhere. Guessing instead would risk joining a
    // neighbour's saved network, which is a worse answer than a list.
    log(`wifi: nothing saved matches "${spoken}" (${saved.length} profiles)`)
    await openShellTarget(SETTINGS_PAGES.networks, 'the network list')
    hidePanel()
    ctx.failed(`I don’t have a saved network called ${spoken} — here’s the list`)
    return
  }

  if ((await currentNetwork()) === target) {
    hidePanel()
    ctx.failed(`You’re already on ${target}`)
    return
  }

  hidePanel()
  if (!(await connectTo(target))) {
    // The radio is off, the network is out of range, or the saved key no longer works. Which
    // of those it is cannot be read without parsing translated status text, and the answer is
    // the same either way: show them the networks so they can see what the adapter can.
    await openShellTarget(SETTINGS_PAGES.networks, 'the network list')
    ctx.failed(`I couldn’t connect to ${target}`)
  }
}
