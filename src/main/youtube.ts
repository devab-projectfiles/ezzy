/** Resolving a YouTube search to its first video, so "play X on youtube" can play X. A
 *  search URL alone only opens results; `watch?v=<id>` autoplays. Spotify cannot be
 *  answered the same way — its search page ships no track ids — so only YouTube gets this.
 *
 *  A page fetch, not an API: no key, no account, no quota, the ids are in the HTML a
 *  browser would receive. The only outbound request Ezzy makes besides the update check
 *  and the model download.
 *
 *  Every failure means today's behaviour, never an error — a timeout or a markup change
 *  returns null, and the caller opens the results page exactly as before. */

import { net } from 'electron'
import { log, since } from './verbose'

/** Bounded so a slow network cannot hold a voice command open — the whole voice path
 *  has 1200ms to answer, and this spends part of it before the browser is even asked.
 *  Measured: the page arrives in 200-600ms. */
const TIMEOUT_MS = 1_500

/** The first result sat 750KB into a 1.2MB page when this was written, so most of the
 *  body has to be read — a ceiling on how much is ever held, not an expectation. */
const MAX_BYTES = 3_000_000

/** How much new body to accumulate between attempts at the pattern — running it over
 *  the whole buffer on every chunk would be quadratic for no benefit. */
const SCAN_EVERY = 64 * 1024

/** The id of a real search result. Scoped to `videoRenderer` rather than the first
 *  `"videoId"` anywhere in the page, since "anywhere" includes an ad, a Shorts shelf, a
 *  channel card — a coincidence that would otherwise hide a bug until a command plays
 *  an advert. */
const FIRST_RESULT = /"videoRenderer":\{"videoId":"([\w-]{11})"/

/** Ids are 11 characters of URL-safe base64. Checked before it is put in a URL. */
const VIDEO_ID = /^[\w-]{11}$/

/** The first video a YouTube search returns, or null if that cannot be established
 *  quickly and confidently. Never throws. */
export async function topVideoId(query: string): Promise<string | null> {
  const startedAt = performance.now()
  const url = `https://www.youtube.com/results?search_query=${encodeURIComponent(query)}`

  const id = await new Promise<string | null>((resolve) => {
    let settled = false
    const finish = (value: string | null, why: string): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (value === null) log(`youtube: no top result (${why})`)
      resolve(value)
    }

    // Electron's net rather than node's https — goes through Chromium's stack, so a
    // system proxy and the machine's certificate store are honoured.
    const request = net.request({ url, method: 'GET' })
    // The parser expects the markup a desktop browser is served, and Electron's default
    // agent announces Electron instead.
    request.setHeader(
      'User-Agent',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    )
    request.setHeader('Accept-Language', 'en-US,en;q=0.9')

    const timer = setTimeout(() => {
      request.abort()
      finish(null, `no answer in ${TIMEOUT_MS}ms`)
    }, TIMEOUT_MS)

    request.on('error', (err) => finish(null, err.message))
    request.on('abort', () => finish(null, 'aborted'))
    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        finish(null, `HTTP ${response.statusCode}`)
        return
      }
      let body = ''
      let scannedAt = 0
      response.on('data', (chunk: Buffer) => {
        if (settled) return
        body += chunk.toString('utf8')
        if (body.length > MAX_BYTES) {
          request.abort()
          finish(null, 'page larger than expected')
          return
        }
        if (body.length - scannedAt < SCAN_EVERY) return
        scannedAt = body.length
        const found = FIRST_RESULT.exec(body)
        if (!found) return
        // Nothing further in the page can change the answer, so stop paying for it.
        request.abort()
        finish(found[1], 'found')
      })
      response.on('end', () => {
        const found = FIRST_RESULT.exec(body)
        finish(found ? found[1] : null, found ? 'found' : 'no videoRenderer in the page')
      })
      response.on('error', (err: Error) => finish(null, err.message))
    })
    request.end()
  })

  since(`youtube: top result for "${query}" -> ${id ?? 'nothing'}`, startedAt)
  // The pattern already constrains the shape; this makes it a guarantee before the URL.
  return id !== null && VIDEO_ID.test(id) ? id : null
}
