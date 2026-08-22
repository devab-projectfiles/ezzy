/** §6's search bar: its own 420x54 acrylic window, fully rounded, 11px above the panel.
 *
 *  It is deliberately inert for now — the input, the fuzzy matching and the mic all arrive
 *  with chunks C and D. What it has to do today is be the right surface in the right place,
 *  because it is one of the four §6 asks for the dual rim on. */
function SearchBar(): React.JSX.Element {
  return (
    <div className="searchbar">
      <SearchGlyph />
      <span className="searchbar__placeholder">Search or say a command</span>
      <MicGlyph />
      <span className="searchbar__sheen" aria-hidden="true" />
    </div>
  )
}

/** 18px, 72% white (§6). */
function SearchGlyph(): React.JSX.Element {
  return (
    <svg className="searchbar__search" viewBox="0 0 18 18" aria-hidden="true">
      <circle cx="7.75" cy="7.75" r="5.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path
        d="M11.6 11.6 15.5 15.5"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
    </svg>
  )
}

/** 19px, 92% white (§6). While listening it is the rim that pulses, not this glyph — but
 *  that is chunk D's job, so nothing animates yet. */
function MicGlyph(): React.JSX.Element {
  return (
    <svg className="searchbar__mic" viewBox="0 0 19 19" aria-hidden="true">
      <rect
        x="7"
        y="2.5"
        width="5"
        height="9"
        rx="2.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <path
        d="M4.5 8.75a5 5 0 0 0 10 0"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
      />
      <path d="M9.5 13.75v2.75" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  )
}

export default SearchBar
