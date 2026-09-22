// A page fetch, not an API: no key, no account, no quota, the ids are in the HTML a browser
// would receive. Every failure means today's behaviour, never an error — a timeout or a
// markup change returns null, and the caller opens the results page exactly as before.

import { net } from 'electron'
import { log, since } from './verbose'

const TIMEOUT_MS = 1_500
const MAX_BYTES = 3_000_000
const SCAN_EVERY = 64 * 1024

// Scoped to `videoRenderer` rather than the first "videoId" anywhere in the page, since
// "anywhere" includes an ad, a Shorts shelf, a channel card.
const FIRST_RESULT = /"videoRenderer":\{"videoId":"([\w-]{11})"/

const VIDEO_ID = /^[\w-]{11}$/

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

    const request = net.request({ url, method: 'GET' })
    // Electron's default agent announces Electron; the parser expects desktop-browser markup.
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
  return id !== null && VIDEO_ID.test(id) ? id : null
}
