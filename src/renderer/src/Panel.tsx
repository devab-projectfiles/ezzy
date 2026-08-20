import { useEffect, useState } from 'react'

function Panel(): React.JSX.Element {
  const [hotkey, setHotkey] = useState('')

  useEffect(() => {
    window.ezy.getHotkey().then(setHotkey)
  }, [])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') window.ezy.closePanel()
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <div className="panel">
      <div className="panel__search">
        <span className="panel__caret" />
        <span className="panel__placeholder">Search windows and apps…</span>
      </div>
      <div className="panel__body">
        <p className="panel__title">Ezy</p>
        <p className="panel__hint">
          {hotkey && (
            <>
              <kbd>{hotkey}</kbd> toggles this panel.
              <br />
            </>
          )}
          <kbd>Esc</kbd> closes it.
        </p>
      </div>
    </div>
  )
}

export default Panel
