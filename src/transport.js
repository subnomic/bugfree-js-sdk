/**
 * Sends the events to the ingest endpoint.
 *
 * Reporting must never break the application: errors are swallowed, requests are
 * sent through a sequential queue, and a last attempt is made with sendBeacon
 * while the page closes (fetch can be cancelled, a beacon cannot).
 */
export function create_transport(store_url, debug = false) {
  let chain = Promise.resolve()
  let in_flight = 0

  function log(...args) {
    if (debug) console.warn('[bugfree]', ...args)
  }

  function send(event) {
    in_flight += 1
    chain = chain
      .then(() => post(event))
      .catch((error) => log('event could not be sent', error))
      .finally(() => {
        in_flight -= 1
      })
    return chain
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

    if (!response.ok) {
      log(`server rejected the event (${response.status})`)
      return null
    }
    return response.json().catch(() => null)
  }

  /** A last attempt to drain the queue while the page closes. */
  function send_beacon(event) {
    if (typeof navigator === 'undefined' || !navigator.sendBeacon) return false
    const blob = new Blob([JSON.stringify(event)], { type: 'application/json' })
    return navigator.sendBeacon(store_url, blob)
  }

  async function flush(timeout_ms = 2000) {
    const started = Date.now()
    while (in_flight > 0 && Date.now() - started < timeout_ms) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    return in_flight === 0
  }

  return { send, send_beacon, flush }
}
