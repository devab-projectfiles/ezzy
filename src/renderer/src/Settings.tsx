import { useEffect, useMemo, useState } from 'react'
import type {
  AppInfo,
  CustomApp,
  CommandInfo,
  EzzyConfig,
  SettingsSnapshot,
  UpdateStatus
} from '../../shared/types'
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

type Page = 'general' | 'voice' | 'commands' | 'apps' | 'appearance' | 'updates'

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

  // Read here rather than asked of the main process: the list is the machine's, every window
  // has the same one, and it arrives asynchronously the first time it is asked for.
  useEffect(() => {
    const read = (): void => setVoices(window.speechSynthesis.getVoices())
    read()
    window.speechSynthesis.addEventListener('voiceschanged', read)
    return () => window.speechSynthesis.removeEventListener('voiceschanged', read)
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
    // `change` is deliberately not a dependency: it closes over nothing but the setters, and
    // the rows are rebuilt on every snapshot anyway because that is what they draw.
    [snapshot, update, hotkeyError, voices]
  )

  // One frame of nothing rather than a layout that jumps: every control below needs the
  // config to know what it is showing.
  if (!snapshot) return <div className="settings" />

  const searching = query.trim() !== ''
  const shown = searching
    ? rows.filter((row) => matches(row, query))
    : rows.filter((r) => r.page === page)
  // Commands are searched alongside the settings, because "spotify" is a thing this app does
  // and a search that answered it with nothing would be telling the user it does not.
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
                  {/* A page whose only group repeats its own name says it twice. The heading earns
                  its place when it divides a page — General's Shortcut and Startup — and not
                  when it is the page. */}
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
  voices: SpeechSynthesisVoice[],
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
      id: 'voice-name',
      page: 'voice',
      section: 'How it sounds',
      name: 'Voice',
      detail:
        'Which installed voice reads confirmations. Automatic picks the best English one on this machine.',
      keywords: 'accent narrator tts synthesiser',
      disabled: !config.voice || !config.speech,
      control: (
        <select
          className="settings__select"
          value={config.voiceName ?? ''}
          disabled={!config.voice || !config.speech}
          onChange={(event) => void change({ voiceName: event.target.value || null })}
        >
          <option value="">Automatic</option>
          {voices.map((voice) => (
            <option key={voice.name} value={voice.name}>
              {voice.name}
            </option>
          ))}
        </select>
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

/** What Ezzy understands, read out of the registry rather than written out here.
 *
 *  There is exactly one list of commands in this app and this draws it, so a command cannot
 *  be added without appearing here and cannot be removed and left behind. The examples are
 *  the command's own, and the first of them is the phrasing its pattern is written around. */
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

/** A row of names: the ones that came with the thing, then the ones the user added, then a
 *  way to add another. Shared by commands and applications because it is the same gesture in
 *  both places — a phrase for a command and an alias for an app are both "another way to say
 *  this", and they should not look or behave differently. */
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
  /** Why this cannot be added, or null. Only commands have a reason to refuse one. */
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

/** Applications, and the names the user has given them.
 *
 *  There are 140 of these on this machine, so the page does not open as a wall of them: it
 *  shows what has actually been customised and asks you to search for the rest. An alias is
 *  almost always added in response to something specific going wrong — "it hears school when
 *  I say Skool" — so arriving with a search box is arriving in the right place. */
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
    : // What the user has actually touched: anything renamed, and anything they added by
      // hand. Listing only the renamed ones hid an app the moment it was added, which is
      // exactly when someone wants to see it.
      apps.filter((app) => app.custom || (aliases[app.id] ?? []).length > 0)

  return (
    <>
      <p className="settings__blurb">
        Give an application another name and Ezzy will answer to it — typed or spoken. Useful when
        what you say and what it hears are not the same word.
      </p>
      <div className="settings__filter-row">
        <input
          className="settings__filter"
          type="text"
          placeholder={`Search ${apps.length} applications`}
          value={filter}
          autoComplete="off"
          spellCheck={false}
          onChange={(event) => setFilter(event.target.value)}
        />
        {/* For anything the scan cannot see: a portable executable, or something installed
            somewhere the Start Menu never hears about. */}
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
    // Show it, or a page that only lists what has been renamed would swallow the thing the
    // user just added.
    setFilter(picked.name)
  }

  async function forget(id: string): Promise<void> {
    const bare = id.replace(/^custom:/, '')
    await onCustom(custom.filter((entry) => entry.id !== bare))
  }
}

/** One command, with the wordings the user has added to it.
 *
 *  A phrase is checked by the main process before it is saved — it is the only half that knows
 *  what the patterns already understand — so the reason a phrase is refused appears under the
 *  field rather than the phrase being quietly dropped. */
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

/** Say a sample here rather than asking the dot to say one.
 *
 *  It is the same Chromium and the same installed voices, so what is heard is what the dot
 *  would produce — and going through the dot would mean a preview that cannot be heard while
 *  the settings window has focus is indistinguishable from one that is broken. */
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

function LogIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" aria-hidden="true">
      <path d="M3.4 2.4h6l3.2 3.2v8H3.4z" {...stroke} />
      <path d="M9.2 2.4v3.4h3.4M5.6 9h4.8M5.6 11.3h3.2" {...stroke} />
    </svg>
  )
}

export default Settings
