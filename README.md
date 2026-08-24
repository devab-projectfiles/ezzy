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
