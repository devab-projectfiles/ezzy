import { useEffect, useState } from 'react'
import type { EzzyConfig, SettingsSnapshot, UpdateStatus } from '../../shared/types'
import HotkeyField from './HotkeyField'

/** The settings window: hotkey, voice on/off, speech on/off, startup.
 *
 *  It holds no state of its own beyond what is being edited. Every change goes to the main
 *  process and the snapshot that comes back is what gets drawn — which matters for the hotkey,
 *  where what you asked for and what Windows gave you are not always the same thing. */
function Settings(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null)
  const [hotkeyError, setHotkeyError] = useState<string | null>(null)
  const [update, setUpdate] = useState<UpdateStatus>({ kind: 'idle' })

  useEffect(() => {
    void window.ezzy.getSettings().then(setSnapshot)
    void window.ezzy.getUpdateStatus().then(setUpdate)
    return window.ezzy.onUpdateStatus(setUpdate)
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') window.ezzy.closeSettings()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // One frame of nothing rather than a layout that jumps: every control below needs the
  // config to know what it is showing.
  if (!snapshot) return <div className="settings" />

  const { config, packaged, activeHotkey, version, logPath } = snapshot

  return (
    <div className="settings">
      <header className="settings__header">
        <h1 className="settings__title">Ezzy</h1>
        <span className="settings__version">{version}</span>
      </header>

      <section className="settings__section">
        <h2 className="settings__heading">SHORTCUT</h2>
        <HotkeyField
          hotkey={config.hotkey}
          active={activeHotkey}
          error={hotkeyError}
          onChange={(hotkey) => void change({ hotkey })}
        />
        <div className="settings__row">
          <div className="settings__label">
            <span className="settings__name">Touchpad gesture</span>
            <span className="settings__detail">
              Map a three-finger tap to {config.hotkey} to open Ezzy with a gesture.
            </span>
          </div>
          <button
            type="button"
            className="settings__button"
            onClick={window.ezzy.openTouchpadSettings}
          >
            Set up
          </button>
        </div>
      </section>

      <section className="settings__section">
        <h2 className="settings__heading">VOICE</h2>
        <Toggle
          label="Voice commands"
          detail="Hold the shortcut and speak. A tap still opens the panel."
          checked={config.voice}
          onChange={(voice) => void change({ voice })}
        />
        <Toggle
          label="Show the panel while listening"
          detail="Off, the dot itself reports what it heard and nothing covers your work."
          checked={config.voicePanel}
          disabled={!config.voice}
          onChange={(voicePanel) => void change({ voicePanel })}
        />
        <Toggle
          label="Speak confirmations"
          detail="Says what it did out loud, and why a command missed."
          checked={config.speech}
          disabled={!config.voice}
          onChange={(speech) => void change({ speech })}
        />
      </section>

      <section className="settings__section">
        <h2 className="settings__heading">STARTUP</h2>
        <Toggle
          label="Start Ezzy when Windows starts"
          detail={
            packaged
              ? 'Ezzy is meant to be there before you look for it.'
              : 'Only takes effect in an installed build — in development this would register Electron itself.'
          }
          checked={config.openAtLogin}
          disabled={!packaged}
          onChange={(openAtLogin) => void change({ openAtLogin })}
        />
      </section>

      <section className="settings__section">
        <h2 className="settings__heading">UPDATES</h2>
        <div className="settings__row">
          <div className="settings__label">
            <span className="settings__name">{updateText(update, version)}</span>
            <span className="settings__detail">Updates install the next time you quit Ezzy.</span>
          </div>
          {update.kind === 'ready' ? (
            <button type="button" className="settings__button" onClick={window.ezzy.installUpdate}>
              Restart
            </button>
          ) : (
            <button
              type="button"
              className="settings__button"
              disabled={busy(update)}
              onClick={window.ezzy.checkForUpdates}
            >
              Check
            </button>
          )}
        </div>
      </section>

      <footer className="settings__footer">
        {/* A log file users can attach to issues has to be findable
            without knowing where %APPDATA% is. */}
        <button type="button" className="settings__link" onClick={window.ezzy.openLogFile}>
          Open log file
        </button>
        <span className="settings__path" title={logPath}>
          {logPath}
        </span>
      </footer>
    </div>
  )

  async function change(patch: Partial<EzzyConfig>): Promise<void> {
    const result = await window.ezzy.setSettings(patch)
    setSnapshot(result.snapshot)
    // Cleared by any change that is not a hotkey change: the message is about one attempt,
    // and leaving it under the field while the user toggles speech reads as a live problem.
    setHotkeyError(patch.hotkey === undefined ? null : result.hotkeyError)
  }
}

interface ToggleProps {
  label: string
  detail: string
  checked: boolean
  disabled?: boolean
  onChange: (checked: boolean) => void
}

function Toggle({ label, detail, checked, disabled, onChange }: ToggleProps): React.JSX.Element {
  return (
    <label className={`settings__row settings__row--toggle${disabled ? ' is-disabled' : ''}`}>
      <span className="settings__label">
        <span className="settings__name">{label}</span>
        <span className="settings__detail">{detail}</span>
      </span>
      <input
        type="checkbox"
        className="settings__checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="settings__switch" aria-hidden="true" />
    </label>
  )
}

function busy(status: UpdateStatus): boolean {
  return status.kind === 'checking' || status.kind === 'downloading' || status.kind === 'available'
}

function updateText(status: UpdateStatus, version: string): string {
  switch (status.kind) {
    case 'checking':
      return 'Checking for updates…'
    case 'available':
      return `Downloading ${status.version}…`
    case 'downloading':
      return `Downloading ${status.version} — ${status.percent}%`
    case 'ready':
      return `Ezzy ${status.version} is ready to install`
    case 'current':
      return `Ezzy ${version} is up to date`
    case 'unsupported':
      return status.reason
    case 'error':
      return `Update check failed: ${status.message}`
    default:
      return `Ezzy ${version}`
  }
}

export default Settings
