import { app } from 'electron'
import { readFileSync, writeFileSync } from 'fs'
import { join } from 'path'
import { DEFAULT_CONFIG, DotPosition, EzyConfig } from '../shared/types'
import { log } from './verbose'

let current: EzyConfig = { ...DEFAULT_CONFIG }

export function configFilePath(): string {
  return join(app.getPath('userData'), 'config.json')
}

export function loadConfig(): EzyConfig {
  try {
    const raw = JSON.parse(readFileSync(configFilePath(), 'utf8')) as Partial<EzyConfig>
    current = normalise(raw)
    log(`config loaded from ${configFilePath()}`)
  } catch {
    current = { ...DEFAULT_CONFIG }
    save()
    log(`config created at ${configFilePath()}`)
  }
  return current
}

export function getConfig(): EzyConfig {
  return current
}

export function updateConfig(patch: Partial<EzyConfig>): void {
  current = { ...current, ...patch }
  save()
}

function save(): void {
  try {
    writeFileSync(configFilePath(), `${JSON.stringify(current, null, 2)}\n`, 'utf8')
  } catch (err) {
    console.error('[ezy] could not write config:', err)
  }
}

/** The config file is hand-editable, so every field is checked rather than trusted. */
function normalise(raw: Partial<EzyConfig>): EzyConfig {
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
    dotPositions,
    lastDisplayId: typeof raw.lastDisplayId === 'string' ? raw.lastDisplayId : null
  }
}
