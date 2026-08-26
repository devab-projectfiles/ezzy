// Stamp the Scoop manifest against the zip that was just built (PLAN.md §8 chunk F).
//
// §3 picks Scoop as the distribution channel precisely because it needs no code-signing
// certificate, and §9 explains why that matters: an unsigned .exe gets a full-screen
// SmartScreen warning and non-technical people close the tab. `scoop install ezzy` has no
// such warning.
//
// A Scoop manifest carries the sha256 of the file it fetches, so it cannot be written by hand
// before the release exists and cannot be left stale after it does — a wrong hash is a hard
// install failure for everyone. Run this after `npm run build:win`, commit the manifest, then
// publish the release.

import { createHash } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const REPO = 'devab-projectfiles/ezzy'

async function main() {
  const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const version = pkg.version
  const zip = join(root, 'dist', `Ezzy-${version}-portable.zip`)

  let bytes
  try {
    bytes = await readFile(zip)
  } catch {
    console.error(`No ${zip}.\nRun \`npm run build:win\` first — the manifest hashes that zip.`)
    process.exitCode = 1
    return
  }
  const hash = createHash('sha256').update(bytes).digest('hex')

  const manifest = {
    version,
    description: pkg.description,
    homepage: `https://github.com/${REPO}`,
    license: pkg.license,
    architecture: {
      '64bit': {
        url: `https://github.com/${REPO}/releases/download/v${version}/Ezzy-${version}-portable.zip`,
        hash
      }
    },
    bin: 'Ezzy.exe',
    shortcuts: [['Ezzy.exe', 'Ezzy']],
    // Ezzy keeps everything it owns in %APPDATA%\Ezzy — config, the speech model, the log —
    // so a Scoop upgrade replaces the app directory without persisting anything from it.
    notes: [
      'Ezzy lives in the tray. Press Alt+Space to open it, hold Alt+Space to speak.',
      'Settings, the log file and Quit are all in the tray menu.',
      'Update with: scoop update ezzy'
    ],
    checkver: 'github',
    autoupdate: {
      architecture: {
        '64bit': {
          url: `https://github.com/${REPO}/releases/download/v$version/Ezzy-$version-portable.zip`
        }
      }
    }
  }

  const out = join(root, 'scoop', 'ezzy.json')
  await writeFile(out, `${JSON.stringify(manifest, null, 4)}\n`, 'utf8')
  console.log(`scoop/ezzy.json -> ${version}\nsha256 ${hash}`)
}

main().catch((err) => {
  console.error(err)
  process.exitCode = 1
})
