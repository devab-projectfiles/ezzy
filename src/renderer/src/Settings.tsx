import { useEffect, useMemo, useRef, useState } from 'react'
import { DOT_LOGOS, MAX_CUSTOM_LOGOS, MIC_READY_MAX_SECONDS } from '../../shared/types'
import type {
  AppInfo,
  BuiltInLogo,
  CustomApp,
  CustomLogo,
  CommandInfo,
  EzzyConfig,
  SettingsSnapshot,
  UpdateStatus
} from '../../shared/types'
import cards from '../assets/dot.svg?raw'
import orbit from '../assets/dots/orbit.svg?raw'
import cluster from '../assets/dots/cluster.svg?raw'
import panels from '../assets/dots/panels.svg?raw'
import HotkeyField from './HotkeyField'
import { cleanLogo } from './logo'

type Page = 'general' | 'voice' | 'commands' | 'apps' | 'appearance' | 'updates'

interface NavItem {
  page: Page
  label: string
  icon: React.JSX.Element
}

interface Row {
  id: string
  page: Page
  section: string
  name: string
  detail: string
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
  const [commands, setCommands] = useState<CommandInfo[]>([])
  const [apps, setApps] = useState<AppInfo[]>([])
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([])

  useEffect(() => {
    void window.ezzy.getSettings().then(setSnapshot)
    void window.ezzy.getUpdateStatus().then(setUpdate)
    void window.ezzy.getCommands().then(setCommands)
    void window.ezzy.getApps().then(setApps)
    return window.ezzy.onUpdateStatus(setUpdate)
  }, [])

  // Polled as well as subscribed: getVoices() answers empty until Chromium finishes loading.
  useEffect(() => {
    let tries = 0
    const read = (): void => {
      const found = window.speechSynthesis.getVoices()
      if (found.length > 0) {
        setVoices(found)
        window.clearInterval(timer)
      }
    }
    const timer = window.setInterval(() => {
      read()
      if (++tries > 20) window.clearInterval(timer)
    }, 200)
    read()
    window.speechSynthesis.addEventListener('voiceschanged', read)
    return () => {
      window.clearInterval(timer)
      window.speechSynthesis.removeEventListener('voiceschanged', read)
    }
  }, [])

  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') window.ezzy.closeSettings()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const rows = useMemo(
    () => (snapshot ? buildRows(snapshot, update, hotkeyError, voices, change) : []),

    [snapshot, update, hotkeyError, voices]
  )

  if (!snapshot) return <div className="settings" />

  const searching = query.trim() !== ''
  const shown = searching
    ? rows.filter((row) => matches(row, query))
    : rows.filter((r) => r.page === page)

  const foundCommands = searching ? commands.filter((c) => commandMatches(c, query)) : []
  const nothing = shown.length === 0 && foundCommands.length === 0

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

            onClick={() => {
              setQuery('')
              setPage(item.page)
            }}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </nav>

      <main className="settings__content">
        <h1 className="settings__title">
          {searching ? `Results for “${query.trim()}”` : titleOf(page)}
        </h1>
        {!searching && page === 'apps' && (
          <Apps
            apps={apps}
            aliases={snapshot.config.aliases}
            custom={snapshot.config.customApps}
            onAliases={(aliases) => void change({ aliases })}
            onCustom={async (customApps) => {
              await change({ customApps })
              setApps(await window.ezzy.getApps())
            }}
          />
        )}
        {!searching && page === 'commands' && (
          <Commands
            commands={commands}
            phrases={snapshot.config.phrases}
            onChange={(phrases) => void change({ phrases })}
          />
        )}
        {searching && nothing && <p className="settings__empty">Nothing here matches that.</p>}
        {page === 'commands' && !searching
          ? null
          : shown.length === 0
            ? null
            : groupBy(shown, searching).map(([heading, group]) => (
                <section key={heading} className="settings__section">
                  {heading !== titleOf(page) && <h2 className="settings__heading">{heading}</h2>}
                  {group.map((row) => (
                    <div
                      key={row.id}
                      className={`settings__row${row.disabled ? ' is-disabled' : ''}`}
                    >
                      <div className="settings__label">
                        <span className="settings__name">{row.name}</span>
                        <span className="settings__detail">{row.detail}</span>
                      </div>
                      <div className="settings__control">{row.control}</div>
                    </div>
                  ))}
                </section>
              ))}
        {foundCommands.length > 0 && (
          <section className="settings__section">
            <h2 className="settings__heading">Commands</h2>
            {foundCommands.map((command) => (
              <div key={command.id} className="settings__command">
                <span className="settings__name">{command.title}</span>
                <p className="settings__detail">{command.summary}</p>
                <ul className="settings__examples">
                  {command.examples.map((example) => (
                    <li key={example} className="settings__example">
                      “{example}”
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </section>
        )}
      </main>
    </div>
  )

  async function change(patch: Partial<EzzyConfig>): Promise<void> {
    const result = await window.ezzy.setSettings(patch)
    setSnapshot(result.snapshot)
    // Cleared by any change that is not a hotkey change, not just a fresh hotkey attempt.
    setHotkeyError(patch.hotkey === undefined ? null : result.hotkeyError)
  }
}

function buildRows(
  snapshot: SettingsSnapshot,
  update: UpdateStatus,
  hotkeyError: string | null,
  voices: SpeechSynthesisVoice[],
  change: (patch: Partial<EzzyConfig>) => Promise<void>
): Row[] {
  const { config, packaged, activeHotkey, version } = snapshot
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
      id: 'dot-click',
      page: 'general',
      section: 'The dot',
      name: 'Click the dot to open the panel',
      detail:
        'A click opens the panel, the same as a tap of the shortcut, and a second click closes it. Off, the dot only moves when you drag it.',
      keywords: 'click mouse dot pill open show panel tap',
      control: (
        <Switch
          checked={config.dotClickOpensPanel}
          label="Click the dot to open the panel"
          onChange={(dotClickOpensPanel) => void change({ dotClickOpensPanel })}
        />
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
      id: 'duck-music',
      page: 'voice',
      section: 'Voice',
      name: 'Pause music while listening',
      detail:
        'Your music stops for the second or two Ezzy is recording. Off, the microphone hears the music and sometimes turns it into a command you did not give.',
      keywords: 'duck spotify echo interrupt',
      disabled: !config.voice,
      control: (
        <Switch
          checked={config.duckMusic}
          disabled={!config.voice}
          label="Pause music while listening"
          onChange={(duckMusic) => void change({ duckMusic })}
        />
      )
    },
    {
      id: 'mic-ready',
      page: 'voice',
      section: 'Voice',
      name: 'Keep the microphone ready',
      detail:
        'How long the microphone stays open after a command, so the next one starts listening at once instead of “Getting ready…”. Windows shows its microphone indicator while it is open.',
      keywords: 'warm ready getting ready delay wait latency timeout indicator',
      disabled: !config.voice,
      control: (
        <Slider
          value={config.micReadySeconds}
          min={0}
          max={MIC_READY_MAX_SECONDS}
          step={5}
          label="Keep the microphone ready"
          format={(value) => (value === 0 ? 'Off' : `${value}s`)}
          disabled={!config.voice}
          onChange={(micReadySeconds) => void change({ micReadySeconds })}
        />
      )
    },
    {
      id: 'voice-name',
      page: 'voice',
      section: 'How it sounds',
      name: 'Voice',
      detail:
        'Which installed voice reads confirmations. Automatic picks the best English one on this machine.',
      keywords: 'accent narrator tts synthesiser',
      disabled: !config.voice || !config.speech,
      control: (
        <Dropdown
          value={config.voiceName ?? ''}
          disabled={!config.voice || !config.speech}
          options={[
            { value: '', label: 'Automatic' },
            ...voices.map((voice) => ({ value: voice.name, label: voice.name }))
          ]}
          onChange={(voiceName) => void change({ voiceName: voiceName || null })}
        />
      )
    },
    {
      id: 'speech-rate',
      page: 'voice',
      section: 'How it sounds',
      name: 'Speed',
      detail: 'How fast it talks. 1.0 is the voice’s own pace.',
      keywords: 'rate speed fast slow',
      disabled: !config.voice || !config.speech,
      control: (
        <Slider
          value={config.speechRate}
          min={0.5}
          max={2}
          step={0.02}
          label="Speech speed"
          format={(value) => `${value.toFixed(2)}x`}
          disabled={!config.voice || !config.speech}
          onChange={(speechRate) => void change({ speechRate })}
        />
      )
    },
    {
      id: 'speech-volume',
      page: 'voice',
      section: 'How it sounds',
      name: 'Volume',
      detail: 'Quieter than your music on purpose — it is furniture, not the thing you are doing.',
      keywords: 'loud quiet',
      disabled: !config.voice || !config.speech,
      control: (
        <Slider
          value={config.speechVolume}
          min={0}
          max={1}
          step={0.05}
          label="Speech volume"
          format={(value) => `${Math.round(value * 100)}%`}
          disabled={!config.voice || !config.speech}
          onChange={(speechVolume) => void change({ speechVolume })}
        />
      )
    },
    {
      id: 'speech-preview',
      page: 'voice',
      section: 'How it sounds',
      name: 'Try it',
      detail: 'Says a confirmation the way it would after a command.',
      keywords: 'test preview sample',
      disabled: !config.voice || !config.speech,
      control: (
        <button
          type="button"
          className="settings__button"
          disabled={!config.voice || !config.speech}
          onClick={() => preview(config, voices)}
        >
          Play
        </button>
      )
    },
    {
      id: 'speech-variety',
      page: 'voice',
      section: 'How it sounds',
      name: 'Vary the phrasing',
      detail:
        'Puts “Okay,” or “Sure,” in front of a confirmation now and then. Off, every answer is the plain sentence.',
      keywords: 'wording lead phrasing repetitive',
      disabled: !config.voice || !config.speech,
      control: (
        <Switch
          checked={config.speechVariety}
          disabled={!config.voice || !config.speech}
          label="Vary the phrasing"
          onChange={(speechVariety) => void change({ speechVariety })}
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
      id: 'dot-logo',
      page: 'appearance',
      section: 'Surfaces',
      name: 'Dot mark',
      detail:
        'The shape the floating dot wears. Cards is the only one that animates when the pill opens.',
      keywords: 'logo icon glyph dot mark shape',
      control: (
        <LogoPicker
          value={config.dotLogo}
          own={config.customLogos}
          onChange={(dotLogo) => void change({ dotLogo })}
          onOwn={(customLogos, select) =>
            void change(select === undefined ? { customLogos } : { customLogos, dotLogo: select })
          }
        />
      )
    },
    {
      id: 'update',
      page: 'updates',
      section: 'Updates',
      name: updateText(update, version),
      detail:
        'Ezzy checks on its own every few hours and downloads a new version in the background. It installs the next time you quit Ezzy, or straight away with Restart.',
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
    }
  ]
}

/** While searching, the heading names the page instead of the section — a section name alone
 *  ("Voice", "Updates") doesn't say where the result lives. */
function groupBy(rows: Row[], searching: boolean): Array<[string, Row[]]> {
  const groups = new Map<string, Row[]>()
  for (const row of rows) {
    const key = searching ? titleOf(row.page) : row.section
    groups.set(key, [...(groups.get(key) ?? []), row])
  }
  return [...groups.entries()]
}

function commandMatches(command: CommandInfo, query: string): boolean {
  const needle = query.trim().toLowerCase()
  return `${command.title} ${command.summary} ${command.examples.join(' ')}`
    .toLowerCase()
    .includes(needle)
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

const GROUPS: Array<[CommandInfo['group'], string, string]> = [
  ['media', 'Music and video', 'Spotify, YouTube, and whatever else is playing.'],
  ['windows', 'Windows and apps', 'Getting to a window, or starting something that is not open.'],
  ['system', 'The machine', 'Settings pages, networks and power.']
]

interface CommandsProps {
  commands: CommandInfo[]
  phrases: Record<string, string[]>
  onChange: (phrases: Record<string, string[]>) => void
}

function Commands({ commands, phrases, onChange }: CommandsProps): React.JSX.Element {
  if (commands.length === 0) {
    return <p className="settings__empty">Loading…</p>
  }
  return (
    <>
      {GROUPS.map(([group, heading, blurb]) => {
        const mine = commands.filter((command) => command.group === group)
        if (mine.length === 0) return null
        return (
          <section key={group} className="settings__section">
            <h2 className="settings__heading">{heading}</h2>
            <p className="settings__blurb">{blurb}</p>
            {mine.map((command) => (
              <Command
                key={command.id}
                command={command}
                mine={phrases[command.id] ?? []}
                onChange={(list) => onChange({ ...phrases, [command.id]: list })}
              />
            ))}
          </section>
        )
      })}
    </>
  )
}

function Names({
  fixed,
  mine,
  placeholder,
  check,
  onChange
}: {
  fixed: string[]
  mine: string[]
  placeholder: string
  check?: (value: string) => Promise<string | null>
  onChange: (next: string[]) => void
}): React.JSX.Element {
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [problem, setProblem] = useState<string | null>(null)

  return (
    <>
      <ul className="settings__examples">
        {fixed.map((value) => (
          <li key={value} className="settings__example">
            “{value}”
          </li>
        ))}
        {mine.map((value) => (
          <li key={value} className="settings__example settings__example--mine">
            “{value}”
            <button
              type="button"
              className="settings__remove"
              aria-label={`Remove ${value}`}
              onClick={() => onChange(mine.filter((entry) => entry !== value))}
            >
              ×
            </button>
          </li>
        ))}
        {adding ? (
          <li className="settings__example settings__example--adding">
            <input
              className="settings__phrase-input"
              autoFocus
              placeholder={placeholder}
              value={draft}
              onChange={(event) => {
                setDraft(event.target.value)
                setProblem(null)
              }}
              onKeyDown={(event) => {
                if (event.key === 'Escape') stop()
                if (event.key === 'Enter') void add()
              }}
            />
            <button type="button" className="settings__remove" onClick={() => void add()}>
              Add
            </button>
          </li>
        ) : (
          <li>
            <button type="button" className="settings__add" onClick={() => setAdding(true)}>
              + Add a name
            </button>
          </li>
        )}
      </ul>
      {problem && <p className="settings__error settings__error--phrase">{problem}</p>}
    </>
  )

  function stop(): void {
    setAdding(false)
    setDraft('')
    setProblem(null)
  }

  async function add(): Promise<void> {
    const value = draft.trim()
    if (value === '') return stop()
    if (mine.includes(value)) {
      setProblem('You have already added that.')
      return
    }
    const reason = check ? await check(value) : null
    if (reason !== null) {
      setProblem(reason)
      return
    }
    onChange([...mine, value])
    stop()
  }
}

function Apps({
  apps,
  aliases,
  custom,
  onAliases,
  onCustom
}: {
  apps: AppInfo[]
  aliases: Record<string, string[]>
  custom: CustomApp[]
  onAliases: (next: Record<string, string[]>) => void
  onCustom: (next: CustomApp[]) => Promise<void>
}): React.JSX.Element {
  const [filter, setFilter] = useState('')
  const needle = filter.trim().toLowerCase()
  const shown = needle
    ? apps.filter(
        (app) =>
          app.name.toLowerCase().includes(needle) ||
          (aliases[app.id] ?? []).some((name) => name.toLowerCase().includes(needle))
      )
    : apps.filter((app) => app.custom || (aliases[app.id] ?? []).length > 0)

  return (
    <>
      <p className="settings__blurb">
        Ezzy found {apps.length} applications on this PC. Give one another name and it will answer
        to that too — typed or spoken, for when what you say and what it hears are not the same
        word. Anything the scan missed can be added by hand.
      </p>
      <div className="settings__filter-row">
        <input
          className="settings__filter"
          type="text"
          placeholder="Search or find an app"
          value={filter}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setFilter(event.target.value)}
        />
        <button type="button" className="settings__button" onClick={() => void addApp()}>
          Add an app…
        </button>
      </div>
      {shown.length === 0 && (
        <p className="settings__empty">
          {needle === ''
            ? 'Nothing added or renamed yet. Search above to find an application, or add one Ezzy cannot see.'
            : 'No application matches that.'}
        </p>
      )}
      {shown.map((app) => (
        <div key={app.id} className="settings__command">
          <span className="settings__name">
            {app.name}
            {app.custom && <span className="settings__tag">added by you</span>}
          </span>
          <Names
            fixed={[]}
            mine={aliases[app.id] ?? []}
            placeholder="another name for it"
            onChange={(next) => {
              const copy = { ...aliases }
              if (next.length === 0) delete copy[app.id]
              else copy[app.id] = next
              onAliases(copy)
            }}
          />
          {app.custom && (
            <button type="button" className="settings__reset" onClick={() => void forget(app.id)}>
              Remove this app
            </button>
          )}
        </div>
      ))}
    </>
  )

  async function addApp(): Promise<void> {
    const picked = await window.ezzy.pickApp()
    if (picked === null) return
    await onCustom([...custom, picked])
    setFilter(picked.name)
  }

  async function forget(id: string): Promise<void> {
    const bare = id.replace(/^custom:/, '')
    await onCustom(custom.filter((entry) => entry.id !== bare))
  }
}

/** A phrase is checked by the main process before saving — it's the only half that knows
 *  what the patterns already understand. */
function Command({
  command,
  mine,
  onChange
}: {
  command: CommandInfo
  mine: string[]
  onChange: (phrases: string[]) => void
}): React.JSX.Element {
  return (
    <div className="settings__command">
      <span className="settings__name">{command.title}</span>
      <p className="settings__detail">{command.summary}</p>
      <Names
        fixed={command.examples}
        mine={mine}
        placeholder="say it your way"
        check={window.ezzy.checkPhrase}
        onChange={onChange}
      />
    </div>
  )
}

/** Drawn by the page rather than by Windows: a native `select` on a dark window came up as
 *  an unstyleable light popup. */
function Dropdown({
  value,
  options,
  disabled,
  onChange
}: {
  value: string
  options: Array<{ value: string; label: string }>
  disabled?: boolean
  onChange: (value: string) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const box = useRef<HTMLDivElement>(null)
  const current = options.find((option) => option.value === value)

  useEffect(() => {
    if (!open) return
    const away = (event: MouseEvent): void => {
      if (!box.current?.contains(event.target as Node)) setOpen(false)
    }
    // Capture: closes before the click lands on whatever is underneath.
    document.addEventListener('mousedown', away, true)
    return () => document.removeEventListener('mousedown', away, true)
  }, [open])

  return (
    <div className="settings__dropdown" ref={box}>
      <button
        type="button"
        className={`settings__dropdown-button${open ? ' is-open' : ''}`}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => {
          setActive(
            Math.max(
              0,
              options.findIndex((option) => option.value === value)
            )
          )
          setOpen((was) => !was)
        }}
        onKeyDown={onKey}
      >
        <span className="settings__dropdown-value">{current?.label ?? 'Automatic'}</span>
        <svg viewBox="0 0 16 16" aria-hidden="true" className="settings__chevron">
          <path d="M4.4 6.2 8 9.8l3.6-3.6" {...stroke} />
        </svg>
      </button>
      {open && (
        <ul className="settings__menu" role="listbox">
          {options.map((option, index) => (
            <li key={option.value}>
              <button
                type="button"
                role="option"
                title={option.label}
                aria-selected={option.value === value}
                className={`settings__option${option.value === value ? ' is-chosen' : ''}${
                  index === active ? ' is-active' : ''
                }`}
                onMouseEnter={() => setActive(index)}
                onClick={() => {
                  onChange(option.value)
                  setOpen(false)
                }}
              >
                {option.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )

  function onKey(event: React.KeyboardEvent): void {
    if (event.key === 'Escape' && open) {
      event.stopPropagation()
      setOpen(false)
      return
    }
    if (!open && (event.key === 'ArrowDown' || event.key === 'Enter')) {
      event.preventDefault()
      setOpen(true)
      return
    }
    if (!open) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const step = event.key === 'ArrowDown' ? 1 : -1
      setActive((was) => (was + step + options.length) % options.length)
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      const option = options[active]
      if (option) onChange(option.value)
      setOpen(false)
    }
  }
}

function Slider({
  value,
  min,
  max,
  step,
  label,
  format,
  disabled,
  onChange
}: {
  value: number
  min: number
  max: number
  step: number
  label: string
  format: (value: number) => string
  disabled?: boolean
  onChange: (value: number) => void
}): React.JSX.Element {
  return (
    <>
      <span className="settings__reading">{format(value)}</span>
      <input
        className="settings__slider"
        type="range"
        aria-label={label}
        // The browser has no way to ask how much track is behind the thumb, so this paints it.
        style={{ '--fill': `${((value - min) / (max - min)) * 100}%` } as React.CSSProperties}
        value={value}
        min={min}
        max={max}
        step={step}
        disabled={disabled}
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </>
  )
}

function preview(config: EzzyConfig, voices: SpeechSynthesisVoice[]): void {
  const synth = window.speechSynthesis
  synth.cancel()
  const utterance = new SpeechSynthesisUtterance(
    config.speechVariety ? 'Okay, switching to Chrome' : 'Switching to Chrome'
  )
  utterance.rate = config.speechRate
  utterance.volume = config.speechVolume
  const voice = voices.find((entry) => entry.name === config.voiceName)
  if (voice) {
    utterance.voice = voice
    utterance.lang = voice.lang
  }
  synth.speak(utterance)
}

interface SwitchProps {
  checked: boolean
  disabled?: boolean
  label: string
  onChange: (checked: boolean) => void
}

const LOGO_PREVIEWS: Record<BuiltInLogo, string> = { cards, orbit, cluster, panels }

const LOGO_NAMES: Record<BuiltInLogo, string> = {
  cards: 'Cards',
  orbit: 'Orbit',
  cluster: 'Cluster',
  panels: 'Panels'
}

function LogoPicker({
  value,
  own,
  onChange,
  onOwn
}: {
  value: string
  own: CustomLogo[]
  onChange: (logo: string) => void
  onOwn: (logos: CustomLogo[], select?: string) => void
}): React.JSX.Element {
  const [problem, setProblem] = useState<string | null>(null)
  const full = own.length >= MAX_CUSTOM_LOGOS

  async function add(): Promise<void> {
    setProblem(null)
    const picked = await window.ezzy.pickLogo()
    if (picked.kind === 'cancelled') return
    if (picked.kind === 'problem') {
      setProblem(picked.message)
      return
    }
    const cleaned = cleanLogo(picked.markup)
    if (cleaned.kind === 'problem') {
      setProblem(cleaned.message)
      return
    }
    const id = `own-${Date.now().toString(36)}`
    onOwn([...own, { id, markup: cleaned.markup }], id)
  }

  function remove(id: string): void {
    setProblem(null)
    // Falls back in the same write: dropping the one worn would leave the dot pointing at nothing.
    onOwn(
      own.filter((logo) => logo.id !== id),
      value === id ? 'cards' : undefined
    )
  }

  return (
    <div className="settings__logo-field">
      <div className="settings__logos" role="radiogroup" aria-label="Dot mark">
        {DOT_LOGOS.map((logo) => (
          <button
            key={logo}
            type="button"
            role="radio"
            aria-checked={logo === value}
            aria-label={LOGO_NAMES[logo]}
            // Not `title`: the OS tooltip can't be styled. The label is drawn from CSS instead.
            data-label={LOGO_NAMES[logo]}
            className={`settings__logo${logo === value ? ' is-selected' : ''}`}
            onClick={() => onChange(logo)}
            dangerouslySetInnerHTML={{ __html: LOGO_PREVIEWS[logo] }}
          />
        ))}
        {own.map((logo, index) => (
          <span key={logo.id} className="settings__logo-slot">
            <button
              type="button"
              role="radio"
              aria-checked={logo.id === value}
              aria-label={`Your mark ${index + 1}`}
              data-label={`Yours ${index + 1}`}
              className={`settings__logo${logo.id === value ? ' is-selected' : ''}`}
              onClick={() => onChange(logo.id)}
              dangerouslySetInnerHTML={{ __html: logo.markup }}
            />
            <button
              type="button"
              className="settings__logo-remove"
              aria-label={`Remove your mark ${index + 1}`}
              onClick={() => remove(logo.id)}
            >
              <CrossIcon />
            </button>
          </span>
        ))}
        <button
          type="button"
          className="settings__logo settings__logo--add"
          aria-label={full ? 'Remove one of your marks to add another' : 'Add your own mark'}
          data-label={full ? 'Remove one to add another' : 'Add your own'}
          disabled={full}
          onClick={() => void add()}
        >
          <PlusIcon />
        </button>
      </div>
      {problem !== null && <p className="settings__logo-problem">{problem}</p>}
    </div>
  )
}

function CrossIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
      <path d="M6 6l12 12M18 6L6 18" strokeLinecap="round" />
    </svg>
  )
}

function PlusIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 5v14M5 12h14" strokeLinecap="round" />
    </svg>
  )
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
      return status.message
    default:
      return `Ezzy ${version}`
  }
}

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
    page: 'commands',
    label: 'Commands',
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <rect x="1.8" y="3.2" width="12.4" height="9.6" rx="2" {...stroke} />
        <path d="M4.6 7.2 6.4 9l-1.8 1.8M8.4 10.8h3" {...stroke} />
      </svg>
    )
  },
  {
    page: 'apps',
    label: 'Apps',
    icon: (
      <svg viewBox="0 0 16 16" aria-hidden="true">
        <rect x="2" y="2" width="5" height="5" rx="1.4" {...stroke} />
        <rect x="9" y="2" width="5" height="5" rx="1.4" {...stroke} />
        <rect x="2" y="9" width="5" height="5" rx="1.4" {...stroke} />
        <rect x="9" y="9" width="5" height="5" rx="1.4" {...stroke} />
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

export default Settings
