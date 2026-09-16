/**
 * Sends the events to the ingest endpoint.
 *
 * Reporting must never break the application: errors are swallowed, requests are
 * sent one after another from a queue, and when the page is being left the events
 * still waiting are handed to sendBeacon (fetch can be cancelled, a beacon cannot).
 */

// The pause after a 429 that names no wait of its own (ms).
const default_retry_after_ms = 60_000

export function create_transport(store_url, debug = false) {
  // Events waiting for their turn, each with the resolver of its send() promise.
  const queue = []
  let draining = false
  // Queued plus being sent.
  let in_flight = 0
  // When the server said it takes events again (epoch ms).
  let paused_until = 0

  function log(...args) {
    if (debug) console.warn('[bugfree]', ...args)
  }

  function paused() {
    return Date.now() < paused_until
  }

  /** Queues the event; the promise resolves to the server's answer, or null. */
  function send(event) {
    if (paused()) {
      log('server asked to wait, event dropped')
      return Promise.resolve(null)
    }

    return new Promise((resolve) => {
      queue.push({ event, resolve })
      in_flight += 1
      drain()
    })
  }

  async function drain() {
    if (draining) return
    draining = true

    while (queue.length > 0) {
      const { event, resolve } = queue.shift()
      try {
        // Events queued before a 429 arrived are dropped with the rest.
        resolve(paused() ? null : await post(event))
      } catch (error) {
        log('event could not be sent', error)
        resolve(null)
      } finally {
        in_flight -= 1
      }
    }
    draining = false
  }

  async function post(event) {
    const body = JSON.stringify(event)

    const response = await fetch(store_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      // So the request is not cancelled while the page closes.
      keepalive: body.length < 60_000,
      credentials: 'omit',
    })

    if (response.status === 429) {
      paused_until = Date.now() + parse_retry_after(response.headers?.get?.('Retry-After'))
      log('server is rate limiting, sending paused')
      return null
    }
    if (!response.ok) {
      log(`server rejected the event (${response.status})`)
      return null
    }
    return response.json().catch(() => null)
  }

  /** Sends a single event with sendBeacon. */
  function send_beacon(event) {
    if (typeof navigator === 'undefined' || !navigator.sendBeacon) return false
    const blob = new Blob([JSON.stringify(event)], { type: 'application/json' })
    return navigator.sendBeacon(store_url, blob)
  }

  /**
   * Hands every event still waiting in the queue to sendBeacon.
   *
   * Called while the page is being left: the queue would otherwise die with the
   * page. The request already in flight carries keepalive and is left alone.
   */
  function beacon_queued() {
    while (queue.length > 0) {
      const { event, resolve } = queue.shift()
      if (!paused()) send_beacon(event)
      resolve(null)
      in_flight -= 1
    }
  }

  async function flush(timeout_ms = 2000) {
    const started = Date.now()
    while (in_flight > 0 && Date.now() - started < timeout_ms) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return in_flight === 0
  }

  return { send, send_beacon, beacon_queued, flush, paused }
}

/** Reads a Retry-After header, seconds or an HTTP date, as milliseconds. */
export function parse_retry_after(value, now = Date.now()) {
  if (value === null || value === undefined || value === '') return default_retry_after_ms

  const seconds = Number(value)
  if (Number.isFinite(seconds)) return seconds > 0 ? seconds * 1000 : default_retry_after_ms

  const at = Date.parse(value)
  if (Number.isFinite(at) && at > now) return at - now
  return default_retry_after_ms
}
