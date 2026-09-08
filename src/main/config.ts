import { app } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { CustomApp, DEFAULT_CONFIG, DotPosition, EzzyConfig } from '../shared/types'
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

/** The config file is hand-editable, so every field is checked rather than trusted. */
function clamp(raw: unknown, low: number, high: number, fallback: number): number {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return fallback
  return Math.min(high, Math.max(low, raw))
}

/** The hand-added applications, keeping only entries that are actually one. A path that has
 *  since been deleted is left in rather than dropped: the file may be on a drive that is not
 *  plugged in, and silently forgetting what the user added is worse than a launch that fails
 *  and says so. */
function readCustomApps(raw: unknown): CustomApp[] {
  if (!Array.isArray(raw)) return []
  return raw.filter(
    (entry): entry is CustomApp =>
      typeof entry === 'object' &&
      entry !== null &&
      typeof (entry as CustomApp).id === 'string' &&
      typeof (entry as CustomApp).name === 'string' &&
      typeof (entry as CustomApp).path === 'string'
  )
}

/** Id -> list of strings, keeping only what is actually shaped like that — used for both
 *  the command phrases and the app aliases, which are the same shape. The file is a file:
 *  it can be hand-edited, half-written by a crash, or left over from an older version. */
function readPhrases(raw: unknown): Record<string, string[]> {
  if (typeof raw !== 'object' || raw === null) return {}
  const out: Record<string, string[]> = {}
  for (const [id, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue
    const phrases = list.filter((entry): entry is string => typeof entry === 'string')
    if (phrases.length > 0) out[id] = phrases
  }
  return out
}

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
    appearance: raw.appearance === 'glass' ? 'glass' : DEFAULT_CONFIG.appearance,
    duckMusic: typeof raw.duckMusic === 'boolean' ? raw.duckMusic : DEFAULT_CONFIG.duckMusic,
    voiceName: typeof raw.voiceName === 'string' ? raw.voiceName : DEFAULT_CONFIG.voiceName,
    // Clamped rather than trusted: the file is editable, and a rate of 40 is a voice nobody
    // can understand with no way to see why.
    speechRate: clamp(raw.speechRate, 0.5, 2, DEFAULT_CONFIG.speechRate),
    speechVolume: clamp(raw.speechVolume, 0, 1, DEFAULT_CONFIG.speechVolume),
    speechVariety:
      typeof raw.speechVariety === 'boolean' ? raw.speechVariety : DEFAULT_CONFIG.speechVariety,
    customApps: readCustomApps(raw.customApps),
    aliases: readPhrases(raw.aliases),
    phrases: readPhrases(raw.phrases),
    dotPositions,
    lastDisplayId: typeof raw.lastDisplayId === 'string' ? raw.lastDisplayId : null
  }
}
