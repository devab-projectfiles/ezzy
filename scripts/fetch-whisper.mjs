// Fetch the whisper.cpp Windows binaries into resources/whisper (PLAN.md §8 chunk D,
// "bundle whisper.cpp").
//
// CLAUDE.md: never commit binaries — they are fetched by a script and gitignored. Run
// `npm run fetch:whisper` once after cloning, and again only when RELEASE below moves.
//
// The release zip carries 38 files, most of them demos and test harnesses. Only the server
// and the libraries it loads are copied out, which is the difference between ~21MB and ~9MB
// of installer.
//
// The release tag is pinned rather than tracking "latest": whisper.cpp publishes several
// builds a week, and an installer whose speech engine changes underneath it depending on
// when someone happened to clone is not a thing anyone can support.

import { createWriteStream } from 'node:fs'
import { cp, mkdir, mkdtemp, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

const RELEASE = 'b4938'
const ASSET = 'whisper-bin-x64.zip'
const URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${RELEASE}/${ASSET}`

/** What actually has to ship. `whisper-server.exe` is the process we run; `whisper.dll` and
 *  `ggml*.dll` are what it links against, and the several `ggml-cpu-*.dll` are per-CPU builds
 *  that ggml picks between at load time — dropping the ones this machine does not use would
 *  break the installer on someone else's. */
const KEEP = [/^whisper-server\.exe$/i, /^whisper\.dll$/i, /^ggml.*\.dll$/i]

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const destination = join(root, 'resources', 'whisper')

async function main() {
  const force = process.argv.includes('--force')
  if (!force && (await exists(join(destination, 'whisper-server.exe')))) {
    console.log(`whisper.cpp is already in ${destination} (pass --force to re-fetch)`)
    return
  }

  const work = await mkdtemp(join(tmpdir(), 'ezzy-whisper-'))
  try {
    const zip = join(work, ASSET)
    console.log(`downloading ${URL}`)
    const response = await fetch(URL)
    if (!response.ok || !response.body) {
      throw new Error(`${response.status} ${response.statusText}`)
    }
    await pipeline(Readable.fromWeb(response.body), createWriteStream(zip))

    // PowerShell rather than a zip library: this project is Windows-only and already shells
    // out to PowerShell for the app index, so this is one fewer dependency to audit.
    console.log('extracting')
    await run('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      `Expand-Archive -LiteralPath '${zip}' -DestinationPath '${work}' -Force`
    ])

    const release = join(work, 'Release')
    await rm(destination, { recursive: true, force: true })
    await mkdir(destination, { recursive: true })

    let copied = 0
    let bytes = 0
    for (const entry of await readdir(release, { withFileTypes: true })) {
      if (!entry.isFile() || !KEEP.some((pattern) => pattern.test(entry.name))) continue
      await cp(join(release, entry.name), join(destination, entry.name))
      bytes += (await stat(join(destination, entry.name))).size
      copied++
    }
    if (copied === 0) throw new Error(`nothing matched in ${release}`)
    console.log(`${copied} files (${(bytes / 1e6).toFixed(1)}MB) -> ${destination}`)
  } finally {
    await rm(work, { recursive: true, force: true })
  }
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

main().catch((error) => {
  console.error('could not fetch whisper.cpp:', error.message)
  console.error(`Download ${URL} by hand and copy Release/*.dll and whisper-server.exe into`)
  console.error(destination)
  process.exitCode = 1
})
