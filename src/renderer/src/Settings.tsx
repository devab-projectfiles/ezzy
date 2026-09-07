import { useEffect, useMemo, useState } from 'react'
import type { EzzyConfig, SettingsSnapshot, UpdateStatus } from '../../shared/types'
import HotkeyField from './HotkeyField'

/** The settings window: a nav down the left, one page of rows on the right.
 *
 *  **Every setting is declared as data**, not as JSX nested inside the page that shows it.
 *  That is what makes the search work: a query filters the same list the pages are built
 *  from, so a setting can never be findable on its own page and invisible to the search, and
 *  adding one is a row in an array rather than an edit in two places. The command registry
 *  makes the same trade for the same reason.
 *
 *  It holds no state of its own beyond what is being edited. Every change goes to the main
 *  process and the snapshot that comes back is what gets drawn — which matters for the hotkey,
 *  where what you asked for and what Windows gave you are not always the same thing. */

type Page = 'general' | 'voice' | 'appearance' | 'updates'

interface NavItem {
  page: Page
  label: string
  icon: React.JSX.Element
}

/** One setting, wherever it is being drawn. `control` is what sits on the right of the row;
 *  the label and the detail are the row's own, so the search has text to match without asking
 *  a control what it is called. */
interface Row {
  id: string
  page: Page
  /** The heading this row sits under, as Claude's settings group Profile and Preferences. */
  section: string
  name: string
  detail: string
  /** Words a user might search for that are not in the name or the detail. */
  keywords?: string
  control: React.JSX.Element
  disabled?: boolean
}

function Settings(): React.JSX.Element {
  const [snapshot, setSnapshot] = useState<SettingsSnapshot | null>(null)
  const [hotkeyError, setHotkeyError] = useState<string | null>(null)
  const [update, setUpdate] = useState<UpdateStatus>({ kind: 'idle' })
  const [page, setPage] = useState<Page>('general')
  const [query, setQuery] = useState('')

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

  const rows = useMemo(
    () => (snapshot ? buildRows(snapshot, update, hotkeyError, change) : []),
    // `change` is deliberately not a dependency: it closes over nothing but the setters, and
    // the rows are rebuilt on every snapshot anyway because that is what they draw.
    [snapshot, update, hotkeyError]
  )

  // One frame of nothing rather than a layout that jumps: every control below needs the
  // config to know what it is showing.
  if (!snapshot) return <div className="settings" />

  const searching = query.trim() !== ''
  const shown = searching
    ? rows.filter((row) => matches(row, query))
    : rows.filter((r) => r.page === page)

  return (
    <div className="settings">
      <nav className="settings__nav">
        <div className="settings__search">
          <SearchIcon />
          <input
            className="settings__search-input"
            type="text"
            placeholder="Search"
            value={query}
            autoComplete="off"
            spellCheck={false}
            onChange={(event) => setQuery(event.target.value)}
          />
        </div>
        <span className="settings__nav-label">Settings</span>
        {NAV.map((item) => (
          <button
            key={item.page}
            type="button"
            className={`settings__nav-item${!searching && item.page === page ? ' is-current' : ''}`}
            // Picking a page is also how you leave a search: the result you were looking at
            // belongs to a page, and staying in the filtered list after choosing one would
            // leave the nav highlighting nothing.
            onClick={() => {
              setQuery('')
              setPage(item.page)
            }}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
        <button type="button" className="settings__nav-foot" onClick={window.ezzy.openLogFile}>
          <LogIcon />
          Open log file
        </button>
      </nav>

      <main className="settings__content">
        <h1 className="settings__title">
          {searching ? `Results for “${query.trim()}”` : titleOf(page)}
        </h1>
        {shown.length === 0 ? (
          <p className="settings__empty">Nothing here matches that.</p>
        ) : (
          groupBy(shown, searching).map(([heading, group]) => (
            <section key={heading} className="settings__section">
              {/* A page whose only group repeats its own name says it twice. The heading earns
                  its place when it divides a page — General's Shortcut and Startup — and not
                  when it is the page. */}
              {heading !== titleOf(page) && <h2 className="settings__heading">{heading}</h2>}
              {group.map((row) => (
                <div key={row.id} className={`settings__row${row.disabled ? ' is-disabled' : ''}`}>
                  <div className="settings__label">
                    <span className="settings__name">{row.name}</span>
                    <span className="settings__detail">{row.detail}</span>
                  </div>
                  <div className="settings__control">{row.control}</div>
                </div>
              ))}
            </section>
          ))
        )}
      </main>
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

/** Every setting there is, in the order the pages show them. */
function buildRows(
  snapshot: SettingsSnapshot,
  update: UpdateStatus,
  hotkeyError: string | null,
  change: (patch: Partial<EzzyConfig>) => Promise<void>
): Row[] {
  const { config, packaged, activeHotkey, version, logPath } = snapshot
  return [
    {
      id: 'hotkey',
      page: 'general',
      section: 'Shortcut',
      name: 'Shortcut',
      detail: 'Tap it for the panel, hold it to speak.',
      keywords: 'hotkey key alt space',
      control: (
        <HotkeyField
          hotkey={config.hotkey}
          active={activeHotkey}
          error={hotkeyError}
          onChange={(hotkey) => void change({ hotkey })}
        />
      )
    },
    {
      id: 'touchpad',
      page: 'general',
      section: 'Shortcut',
      name: 'Touchpad gesture',
      detail: 'Map a three-finger tap to your shortcut to open Ezzy with a gesture.',
      keywords: 'trackpad three finger swipe',
      control: (
        <button
          type="button"
          className="settings__button"
          onClick={window.ezzy.openTouchpadSettings}
        >
          Set up
        </button>
      )
    },
    {
      id: 'startup',
      page: 'general',
      section: 'Startup',
      name: 'Start Ezzy when Windows starts',
      detail: packaged
        ? 'Ezzy is meant to be there before you look for it.'
        : 'Only takes effect in an installed build — in development this would register Electron itself.',
      keywords: 'login boot autostart',
      disabled: !packaged,
      control: (
        <Switch
          checked={config.openAtLogin}
          disabled={!packaged}
          label="Start Ezzy when Windows starts"
          onChange={(openAtLogin) => void change({ openAtLogin })}
        />
      )
    },
    {
      id: 'voice',
      page: 'voice',
      section: 'Voice',
      name: 'Voice commands',
      detail: 'Hold the shortcut and speak. A tap still opens the panel.',
      keywords: 'microphone speech whisper dictation',
      control: (
        <Switch
          checked={config.voice}
          label="Voice commands"
          onChange={(voice) => void change({ voice })}
        />
      )
    },
    {
      id: 'voice-panel',
      page: 'voice',
      section: 'Voice',
      name: 'Show the panel while listening',
      detail: 'Off, the dot itself reports what it heard and nothing covers your work.',
      disabled: !config.voice,
      control: (
        <Switch
          checked={config.voicePanel}
          disabled={!config.voice}
          label="Show the panel while listening"
          onChange={(voicePanel) => void change({ voicePanel })}
        />
      )
    },
    {
      id: 'speech',
      page: 'voice',
      section: 'Voice',
      name: 'Speak confirmations',
      detail: 'Says what it did out loud, and why a command missed.',
      keywords: 'talk out loud tts',
      disabled: !config.voice,
      control: (
        <Switch
          checked={config.speech}
          disabled={!config.voice}
          label="Speak confirmations"
          onChange={(speech) => void change({ speech })}
        />
      )
    },
    {
      id: 'appearance',
      page: 'appearance',
      section: 'Surfaces',
      name: 'Glass surfaces',
      detail:
        'Adds the tinted gradient, the sheen and the lit edges. Off, each surface is one flat colour.',
      keywords: 'theme glass flat colour color skin',
      control: (
        <Switch
          checked={config.appearance === 'glass'}
          label="Glass surfaces"
          onChange={(glass) => void change({ appearance: glass ? 'glass' : 'flat' })}
        />
      )
    },
    {
      id: 'update',
      page: 'updates',
      section: 'Updates',
      name: updateText(update, version),
      detail: 'Updates install the next time you quit Ezzy.',
      keywords: 'version upgrade check',
      control:
        update.kind === 'ready' ? (
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
        )
    },
    {
      id: 'log',
      page: 'updates',
      section: 'Diagnostics',
      // A log file users can attach to issues has to be findable without knowing
      // where %APPDATA% is.
      name: 'Log file',
      detail: logPath,
      keywords: 'diagnostics debug verbose',
      control: (
        <button type="button" className="settings__button" onClick={window.ezzy.openLogFile}>
          Open
        </button>
      )
    }
  ]
}

/** Rows under their section headings, in first-seen order. While searching the heading names
 *  the PAGE instead, because a section name on its own — "Voice", "Updates" — does not say
 *  where the result lives. */
function groupBy(rows: Row[], searching: boolean): Array<[string, Row[]]> {
  const groups = new Map<string, Row[]>()
  for (const row of rows) {
    const key = searching ? titleOf(row.page) : row.section
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  return [...groups.entries()]
}

function matches(row: Row, query: string): boolean {
  const needle = query.trim().toLowerCase()
  return `${row.name} ${row.detail} ${row.keywords ?? ''} ${titleOf(row.page)}`
    .toLowerCase()
    .includes(needle)
}

function titleOf(page: Page): string {
  return NAV.find((item) => item.page === page)?.label ?? ''
}

interface SwitchProps {
  checked: boolean
  disabled?: boolean
  /** The row already shows the name, so the control needs its own only for a screen reader. */
  label: string
  onChange: (checked: boolean) => void
}

function Switch({ checked, disabled, label, onChange }: SwitchProps): React.JSX.Element {
  return (
    <label className="settings__toggle">
      <input
        type="checkbox"
        className="settings__checkbox"
        aria-label={label}
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

/** 16px, currentColor, drawn rather than imported — the app ships no icon set and four
 *  outlines are not a reason to start one. */
const stroke = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.5,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const
}

function SearchIcon(): React.JSX.Element {
  return (
    <svg className="settings__search-icon" viewBox="0 0 16 16" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" {...stroke} />
      <path d="M10.4 10.4 13.5 13.5" {...stroke} />
    </svg>
  )
}

const NAV: NavItem[] = [
  {
    page: 'general',
    label: 'General',
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="2.2" {...stroke} />
        <path
          d="M8 1.6v1.7M8 12.7v1.7M14.4 8h-1.7M3.3 8H1.6M12.5 3.5l-1.2 1.2M4.7 11.3l-1.2 1.2M12.5 12.5l-1.2-1.2M4.7 4.7 3.5 3.5"
          {...stroke}
        />
      </svg>
    )
  },
  {
    page: 'voice',
    label: 'Voice',
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <rect x="6" y="1.8" width="4" height="7.4" rx="2" {...stroke} />
        <path d="M3.6 7.4a4.4 4.4 0 0 0 8.8 0M8 11.8v2.4" {...stroke} />
      </svg>
    )
  },
  {
    page: 'appearance',
    label: 'Appearance',
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <circle cx="8" cy="8" r="6.2" {...stroke} />
        <path d="M8 1.8a6.2 6.2 0 0 1 0 12.4z" fill="currentColor" stroke="none" />
      </svg>
    )
  },
  {
    page: 'updates',
    label: 'Updates',
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <path d="M8 2.6v7.6M5.2 7.4 8 10.2l2.8-2.8M2.8 12.4h10.4" {...stroke} />
      </svg>
    )
  }
]

function LogIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.4 2.4h6l3.2 3.2v8H3.4z" {...stroke} />
      <path d="M9.2 2.4v3.4h3.4M5.6 9h4.8M5.6 11.3h3.2" {...stroke} />
    </svg>
  )
}

export default Settings
