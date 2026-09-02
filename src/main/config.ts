import { app } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { DEFAULT_CONFIG, DotPosition, EzzyConfig } from '../shared/types'
import { log } from './verbose'

let current: EzzyConfig = { ...DEFAULT_CONFIG }

/** A byte order mark, which JSON.parse rejects as an unexpected token. */
const BOM = 0xfeff

export function configFilePath(): string {
  return join(app.getPath('userData'), 'config.json')
}

export function loadConfig(): EzzyConfig {
  try {
    // Tray > Settings opens this file in whatever editor Windows picks, and Notepad saves
    // UTF-8 with a BOM by default. Without this the parse throws, the catch below resets
    // every setting — dot position included — and writes the defaults back over the file.
    // Editing your own hotkey through the app's menu would silently wipe it.
    const text = readFileSync(configFilePath(), 'utf8')
    const json = text.charCodeAt(0) === BOM ? text.slice(1) : text
    const raw = JSON.parse(json) as Partial<EzzyConfig>
    current = normalise(raw)
    log(`config loaded from ${configFilePath()}`)
  } catch {
    current = { ...DEFAULT_CONFIG }
    save()
    log(`config created at ${configFilePath()}`)
  }
  return current
}

export function getConfig(): EzzyConfig {
  return current
}

export function updateConfig(patch: Partial<EzzyConfig>): void {
  current = { ...current, ...patch }
  save()
}

function save(): void {
  try {
    writeFileSync(configFilePath(), `${JSON.stringify(current, null, 2)}\n`, 'utf8')
  } catch (err) {
    console.error('[ezzy] could not write config:', err)
  }
}

/** No more than ten seconds. Past that the user has walked away from whatever they asked
 *  for, and a play key arriving then is a surprise rather than a confirmation. */
const MAX_PLAY_DELAY_MS = 10_000

/** The config file is hand-editable, so every field is checked rather than trusted. */
function normalise(raw: Partial<EzzyConfig>): EzzyConfig {
  const dotPositions: Record<string, DotPosition> = {}
  if (raw.dotPositions && typeof raw.dotPositions === 'object') {
    for (const [id, pos] of Object.entries(raw.dotPositions)) {
      if (pos && typeof pos.x === 'number' && typeof pos.y === 'number') {
        dotPositions[id] = { x: pos.x, y: pos.y }
      }
    }
  }
  return {
    hotkey:
      typeof raw.hotkey === 'string' && raw.hotkey.trim().length > 0
        ? raw.hotkey.trim()
        : DEFAULT_CONFIG.hotkey,
    openAtLogin:
      typeof raw.openAtLogin === 'boolean' ? raw.openAtLogin : DEFAULT_CONFIG.openAtLogin,
    speech: typeof raw.speech === 'boolean' ? raw.speech : DEFAULT_CONFIG.speech,
    voice: typeof raw.voice === 'boolean' ? raw.voice : DEFAULT_CONFIG.voice,
    voicePanel: typeof raw.voicePanel === 'boolean' ? raw.voicePanel : DEFAULT_CONFIG.voicePanel,
    // Clamped, not just type-checked: this one is a duration a hand-editor is invited to
    // change, and a negative or absurd value would either fire the play key before Spotify
    // exists or leave a timer running for an hour.
    spotifyPlayDelayMs: clampDelay(raw.spotifyPlayDelayMs),
    dotPositions,
    lastDisplayId: typeof raw.lastDisplayId === 'string' ? raw.lastDisplayId : null
  }
}

function clampDelay(raw: unknown): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return DEFAULT_CONFIG.spotifyPlayDelayMs
  return Math.min(Math.max(Math.round(raw), 0), MAX_PLAY_DELAY_MS)
}
