/** Resolving a YouTube search to its first video, so "play X on youtube" can play X.
 *
 *  **Why this exists at all.** Handing the shell a search URL opens the results and stops
 *  there: the list lives in the browser's renderer and Ezzy has no view of it. Playing is the
 *  easy half — `watch?v=<id>` autoplays — so the whole problem is learning which video is
 *  first. Measured on this machine: Spotify cannot be answered the same way (its search page
 *  ships no track ids at all, they arrive later over an authenticated call), which is why only
 *  YouTube gets this and "play daft punk" still just opens Spotify's results.
 *
 *  **This is a page fetch, not an API.** No key, no account, no quota — the ids are in the
 *  HTML the browser itself would receive. It is also the only outbound request Ezzy makes that
 *  is not the update check or the model download, and README the plan says so out loud rather than
 *  quietly making the promise untrue. Nothing about the query is sent anywhere else and no
 *  response is stored.
 *
 *  **Every failure means today's behaviour, never an error.** A timeout, a bot check, a
 *  consent interstitial, a markup change that retires `videoRenderer` — all of them return
 *  null, and the caller opens the results page exactly as it did before this file existed.
 *  That is the whole safety argument: the worst case is what the user already had. */

import { net } from 'electron'
import { log, since } from './verbose'

/** Bounded so a slow network cannot hold a voice command open. The whole voice path has
 *  1200ms to put something in front of the user, and this spends part of that budget before
 *  the browser is even asked — so it is deliberately tight, and a miss costs only the fallback
 *  it was already going to take. Measured here: the page arrives in 200-600ms. */
const TIMEOUT_MS = 1_500

/** The first result sat 750KB into a 1.2MB page when this was written, so most of the body has
 *  to be read. This is the ceiling on how much of it we will ever hold, not an expectation. */
const MAX_BYTES = 3_000_000

/** How much new body to accumulate between attempts at the pattern. Running it over the whole
 *  buffer on every chunk would be quadratic for no benefit; every 64KB finds the id within a
 *  chunk or two of when it arrives and lets the request be aborted early. */
const SCAN_EVERY = 64 * 1024

/** The id of a real search result.
 *
 *  Scoped to `videoRenderer` rather than taking the first `"videoId"` anywhere in the page,
 *  because "anywhere" includes whatever YouTube decides to put above the results — an ad, a
 *  Shorts shelf, a channel card. On the page this was built against the two happened to be the
 *  same video, which is exactly the kind of coincidence that hides a bug until someone's
 *  command plays an advert. */
const FIRST_RESULT = /"videoRenderer":\{"videoId":"([\w-]{11})"/

/** Ids are 11 characters of URL-safe base64. Checked before it is put in a URL. */
const VIDEO_ID = /^[\w-]{11}$/

/** The first video a YouTube search returns, or null if that cannot be established quickly
 *  and confidently. Never throws. */
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

    // Electron's net rather than node's https, for the same reason whisper-model.ts uses it:
    // it goes through Chromium's stack, so a system proxy and the machine's certificate store
    // are honoured. A corporate laptop is the case that would otherwise fail silently.
    const request = net.request({ url, method: 'GET' })
    // The parser expects the markup a desktop browser is served. Electron's default agent
    // announces Electron, and a page tailored to something else is a page whose shape this
    // file has never seen.
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
  // Belt and braces before it becomes a URL: the pattern already constrains the shape, and
  // this is what makes that a guarantee rather than a reading of the regex.
  return id !== null && VIDEO_ID.test(id) ? id : null
}
