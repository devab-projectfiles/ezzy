// The registry has no fall-through, so a settings command registered after `open` would
// simply never run. The pattern below carries the page names inside it, so "open bluetooth"
// matches and "open chrome" is never even a candidate.

import { openShellTarget } from '../launcher'
import { log } from '../verbose'
import { hidePanel } from '../windows'
import { connectTo, currentNetwork, matchProfile, refreshProfiles, savedProfiles } from '../wifi'
import { CommandContext, register } from './registry'

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

// Longest first, so "windows update" wins over "update" rather than leaving " windows"
// stranded in front of it.
const SETTINGS_NAMES = Object.keys(ALIASES)
  .sort((a, b) => b.length - a.length)
  .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|')

const OPEN_SETTINGS = new RegExp(
  `^(?:open|show|show me|go to|take me to|launch)\\s+(?:the\\s+)?(?:settings\\s+)?(${SETTINGS_NAMES})(?:\\s+(?:settings?|page|panel))?$`
)

// Registered before WIFI_CONNECT, whose `(.+?)` would otherwise take "wifi" as a network name.
const WIFI_LIST =
  /^(?:connect|reconnect|join)(?:\s+(?:to|me\s+to))?\s+(?:the\s+|a\s+|my\s+)?(?:wifi|wi\s?-?\s?fi|wireless|internet|network|networks)$/

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
      if (!(await openShellTarget(uri, `${page} settings`))) {
        ctx.failed(`I couldn’t open ${page} settings`)
        return
      }
      hidePanel()
    }
  })

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

  if (target === null) {
    await refreshProfiles()
    saved = await savedProfiles()
    target = matchProfile(spoken, saved)
  }

  if (target === null) {
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
    await openShellTarget(SETTINGS_PAGES.networks, 'the network list')
    ctx.failed(`I couldn’t connect to ${target}`)
  }
}
