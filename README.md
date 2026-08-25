# Ezzy

An Electron application with React and TypeScript

## Recommended IDE Setup

- [VSCode](https://code.visualstudio.com/) + [ESLint](https://marketplace.visualstudio.com/items?itemName=dbaeumer.vscode-eslint) + [Prettier](https://marketplace.visualstudio.com/items?itemName=esbenp.prettier-vscode)

## Project Setup

### Install

```bash
$ npm install
```

### Speech

Voice runs on whisper.cpp, whose Windows binaries are not in git. Fetch them once:

```bash
$ npm run fetch:whisper
```

The speech model itself (`ggml-base.en.bin`, ~141MB) is not bundled either — it downloads
into the app's data directory the first time you hold the hotkey, with progress shown in the
search bar. Everything runs locally; audio never leaves the machine.

Hold the hotkey, speak, let go:

| Say | What happens |
|-----|--------------|
| "switch to chrome" / "open chrome" | Focuses the window if it is open, launches the app if it is not |
| "chrome" | The same — a bare name works when the verb gets clipped |
| "close this window" | Closes the window you were last in |
| "close chrome" | Closes that window |
| "open github.com" | Opens the URL, or a path that exists |

A tap of the same key still opens the panel to type in, and never touches speech recognition.

### Development

```bash
$ npm run dev
```

### Build

```bash
# For windows
$ npm run build:win

# For macOS
$ npm run build:mac

# For Linux
$ npm run build:linux
```
