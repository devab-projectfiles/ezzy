/** Windows settings pages and saved WiFi networks. Two commands, registry data like
 *  everything else — no new dependencies, no elevation, nothing here the user could not
 *  do themselves in the Settings app.
 *
 *  On not shadowing `open X`: the registry has no fall-through, so a settings command
 *  registered after `open` would simply never run. The fix is to make shadowing
 *  impossible rather than recoverable — the pattern carries the page names inside it, so
 *  "open bluetooth" matches and "open chrome" is not even a candidate. A closed list of
 *  eleven pages does the job a fuzzy match was meant to do, without a threshold that
 *  could one day decide "Notion" is close enough to "networks". */

import { openShellTarget } from '../launcher'
import { log } from '../verbose'
import { hidePanel } from '../windows'
import { connectTo, currentNetwork, matchProfile, refreshProfiles, savedProfiles } from '../wifi'
import { CommandContext, register } from './registry'

/** Windows exposes a URI for every Settings page — one lookup table, plus
 *  `ms-availablenetworks:`, the WiFi flyout rather than a page. */
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

/** What people say, mapped to the page they mean — the spoken form, not the name
 *  Microsoft gave it (nobody asks for "batterysaver"), including the two-word spellings
 *  whisper writes for "bluetooth" often enough to be worth a line. */
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

/** Built from the alias table so the two cannot drift. Longest first, so "windows
 *  update" wins over "update" rather than leaving " windows" stranded in front of it. */
const SETTINGS_NAMES = Object.keys(ALIASES)
  .sort((a, b) => b.length - a.length)
  .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|')

/** "open bluetooth", "open the wifi settings", "show me display settings", "go to updates". */
const OPEN_SETTINGS = new RegExp(
  `^(?:open|show|show me|go to|take me to|launch)\\s+(?:the\\s+)?(?:settings\\s+)?(${SETTINGS_NAMES})(?:\\s+(?:settings?|page|panel))?$`
)

/** "connect to wifi", "connect wi-fi", "join a network", "connect me to the internet" — a
 *  request naming no network. Registered before WIFI_CONNECT, whose `(.+?)` would
 *  otherwise take "wifi" as a network name and answer "I don't have a saved network
 *  called wifi", which is true and useless — the real answer here is the list. */
const WIFI_LIST =
  /^(?:connect|reconnect|join)(?:\s+(?:to|me\s+to))?\s+(?:the\s+|a\s+|my\s+)?(?:wifi|wi\s?-?\s?fi|wireless|internet|network|networks)$/

/** "connect to home", "connect to the office wifi", "join AAU-SFA-Student". */
const WIFI_CONNECT =
  /^(?:connect|reconnect|join)(?:\s+(?:to|me\s+to))?\s+(?:the\s+)?(.+?)(?:\s+(?:wifi|wi-fi|network))?$/

export function registerSystemCommands(): void {
  register({
    id: 'open-settings',
    takesTarget: false,
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
      // Through Explorer, exactly what an `ms-settings:` URI is for.
      if (!(await openShellTarget(uri, `${page} settings`))) {
        ctx.failed(`I couldn’t open ${page} settings`)
        return
      }
      hidePanel()
    }
  })

  // Before wifi-connect, which would otherwise read "wifi" as the name of a network.
  register({
    id: 'wifi-list',
    takesTarget: false,
    title: 'Show the networks',
    group: 'system',
    summary: 'Opens the list of networks in range, for when you want to pick one yourself.',
    examples: ['connect to wifi', 'join a network'],
    match: WIFI_LIST,
    describe: () => 'Here are the networks',
    run: async (_groups, ctx) => {
      // The saved names go in the log, not the sentence — the flyout this opens already
      // shows them, along with the ones in range, which is more than Ezzy knows.
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
    takesTarget: true,
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
    // Not a failure with an apology — the list of what can be joined is one keystroke
    // away, and guessing instead risks joining a neighbour's saved network.
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
    // The radio is off, the network is out of range, or the key no longer works — which
    // cannot be read without parsing translated status text, so the answer is the same
    // either way: show the networks so they can see what the adapter can.
    await openShellTarget(SETTINGS_PAGES.networks, 'the network list')
    ctx.failed(`I couldn’t connect to ${target}`)
  }
}
