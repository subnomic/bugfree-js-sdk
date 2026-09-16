/**
 * Times what the page does: the page load, every navigation after it, and the
 * requests made meanwhile.
 *
 * A transaction ends once the page has been idle for a moment (no request in
 * flight), so it covers the work a navigation started without waiting for a
 * signal from the application. Requests to the application's own servers carry a
 * W3C traceparent header, and the server's transaction joins the same trace.
 */

// How long the page has to be idle before a transaction ends (ms).
const idle_ms = 1000
// The longest a transaction may run before it is ended anyway (ms).
const max_transaction_ms = 30_000
// The most spans one transaction records.
const max_spans = 500
// The most resources of a page load recorded as spans.
const max_resources = 100

function random_hex(bytes) {
  const values = new Uint8Array(bytes)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(values)
  } else {
    for (let i = 0; i < bytes; i += 1) values[i] = Math.floor(Math.random() * 256)
  }
  return [...values].map((value) => value.toString(16).padStart(2, '0')).join('')
}

export const new_trace_id = () => random_hex(16)
export const new_span_id = () => random_hex(8)

function now_ms() {
  if (typeof performance !== 'undefined' && performance.timeOrigin && performance.now) {
    return performance.timeOrigin + performance.now()
  }
  return Date.now()
}

/**
 * Whether a request goes to a target that may receive the trace header. A
 * relative address, or one on the page's own origin, always may; others only
 * when a string or RegExp in targets matches them. Third parties would reject an
 * unexpected header in their CORS preflight.
 */
export function is_propagation_target(url, targets = []) {
  const text = String(url || '')
  if (typeof location !== 'undefined') {
    if (text.startsWith('/') && !text.startsWith('//')) return true
    if (location.origin && text.startsWith(location.origin)) return true
  }
  return targets.some((target) => (target instanceof RegExp ? target.test(text) : typeof target === 'string' && target && text.startsWith(target)))
}

/**
 * @param {{ sample_rate: number, propagation_targets: Array<string|RegExp>, send: (transaction: object) => void }} config
 */
export function create_tracer({ sample_rate = 0, propagation_targets = [], send, on_start = null, on_finish = null }) {
  let active = null
  const enabled = sample_rate > 0

  function finish(transaction, end = now_ms()) {
    if (!transaction || transaction.finished) return
    transaction.finished = true
    clearTimeout(transaction.idle_timer)
    clearTimeout(transaction.max_timer)
    if (active === transaction) active = null
    if (!transaction.sampled) return
    on_finish?.(transaction, end)

    if (transaction.op === 'pageload') add_page_load_details(transaction)
    send({
      trace_id: transaction.trace_id,
      span_id: transaction.span_id,
      name: transaction.name,
      op: transaction.op,
      status: transaction.status,
      start: new Date(transaction.start).toISOString(),
      duration_ms: Math.max(0, end - transaction.start),
      platform: 'javascript',
      measurements: transaction.measurements,
      spans: transaction.spans.map((span) => ({
        span_id: span.span_id,
        parent_span_id: transaction.span_id,
        op: span.op,
        description: span.description,
        status: span.status,
        start: new Date(span.start).toISOString(),
        duration_ms: Math.max(0, (span.end ?? end) - span.start),
        data: span.data,
      })),
    })
  }

  /** Ends the transaction once nothing is in flight for idle_ms. */
  function schedule_idle(transaction) {
    clearTimeout(transaction.idle_timer)
    if (transaction.pending > 0 || transaction.waiting_for_load) return
    transaction.idle_timer = setTimeout(() => finish(transaction, transaction.last_activity), idle_ms)
  }

  function start(name, op, start_time = now_ms()) {
    if (!enabled) return null
    // A new navigation ends the one before it.
    if (active) finish(active)
    const transaction = {
      trace_id: new_trace_id(),
      span_id: new_span_id(),
      sampled: Math.random() < sample_rate,
      name,
      op,
      status: 'ok',
      start: start_time,
      last_activity: now_ms(),
      pending: 0,
      spans: [],
      measurements: {},
      finished: false,
      waiting_for_load: false,
    }
    transaction.max_timer = setTimeout(() => {
      transaction.status = 'deadline_exceeded'
      finish(transaction)
    }, max_transaction_ms)
    active = transaction
    if (transaction.sampled) on_start?.(transaction)
    schedule_idle(transaction)
    return transaction
  }

  /** Starts the page load's transaction, measured from the navigation start. */
  function start_page_load(name) {
    const start_time = typeof performance !== 'undefined' && performance.timeOrigin ? performance.timeOrigin : now_ms()
    const transaction = start(name, 'pageload', start_time)
    if (!transaction) return null
    observe_vitals(transaction)
    if (typeof document !== 'undefined' && document.readyState !== 'complete' && typeof window !== 'undefined') {
      transaction.waiting_for_load = true
      window.addEventListener?.('load', () => {
        transaction.waiting_for_load = false
        transaction.last_activity = now_ms()
        schedule_idle(transaction)
      })
    }
    return transaction
  }

  /**
   * Called by the request hooks. Returns the header to add and the function that
   * ends the request's span, or null outside a transaction.
   */
  function on_request(method, url) {
    const transaction = active
    if (!transaction || transaction.finished) return null
    const span = {
      span_id: new_span_id(),
      op: 'http.client',
      description: `${method} ${url}`,
      status: 'ok',
      start: now_ms(),
      data: {},
    }
    if (transaction.spans.length < max_spans) transaction.spans.push(span)
    transaction.pending += 1
    clearTimeout(transaction.idle_timer)

    const headers = is_propagation_target(url, propagation_targets)
      ? { traceparent: `00-${transaction.trace_id}-${span.span_id}-${transaction.sampled ? '01' : '00'}` }
      : null

    return {
      headers,
      finish(status) {
        span.end = now_ms()
        if (!status) span.status = 'unknown_error'
        else {
          span.data['http.status_code'] = status
          if (status >= 400) span.status = 'http_error'
        }
        transaction.pending = Math.max(0, transaction.pending - 1)
        transaction.last_activity = span.end
        if (!transaction.finished) schedule_idle(transaction)
      },
    }
  }

  return {
    enabled,
    start,
    start_navigation: (name) => start(name, 'navigation'),
    start_page_load,
    on_request,
    rename: (name) => {
      if (active && name) active.name = name
    },
    active: () => active,
    finish,
    finish_active: () => finish(active),
  }
}

/** Collects web vitals while the page loads. */
function observe_vitals(transaction) {
  if (typeof PerformanceObserver === 'undefined') return
  const observe = (type, handle) => {
    try {
      new PerformanceObserver((list) => list.getEntries().forEach(handle)).observe({ type, buffered: true })
    } catch {
      // The browser does not know this entry type.
    }
  }
  observe('largest-contentful-paint', (entry) => {
    transaction.measurements.lcp = entry.startTime
  })
  observe('layout-shift', (entry) => {
    if (!entry.hadRecentInput) transaction.measurements.cls = (transaction.measurements.cls || 0) + entry.value
  })
}

/** Adds the navigation timings and the loaded resources to a page load. */
function add_page_load_details(transaction) {
  if (typeof performance === 'undefined' || !performance.getEntriesByType) return
  const origin = performance.timeOrigin || transaction.start

  const [navigation] = performance.getEntriesByType('navigation')
  if (navigation) {
    transaction.measurements.ttfb = navigation.responseStart
    const phases = [
      ['browser.request', 'request', navigation.requestStart, navigation.responseEnd],
      ['browser.dom', 'DOM content loaded', navigation.responseEnd, navigation.domContentLoadedEventEnd],
      ['browser.load', 'load event', navigation.loadEventStart, navigation.loadEventEnd],
    ]
    for (const [op, description, from, to] of phases) {
      if (to > from) transaction.spans.push({ span_id: new_span_id(), op, description, status: 'ok', start: origin + from, end: origin + to })
    }
  }

  const paint = performance.getEntriesByType('paint').find((entry) => entry.name === 'first-contentful-paint')
  if (paint) transaction.measurements.fcp = paint.startTime

  for (const resource of performance.getEntriesByType('resource').slice(0, max_resources)) {
    // Requests made through fetch and XHR are spans of their own already.
    if (resource.initiatorType === 'fetch' || resource.initiatorType === 'xmlhttprequest') continue
    if (transaction.spans.length >= max_spans) break
    transaction.spans.push({
      span_id: new_span_id(),
      op: `resource.${resource.initiatorType || 'other'}`,
      description: resource.name,
      status: 'ok',
      start: origin + resource.startTime,
      end: origin + resource.startTime + resource.duration,
      data: { 'transfer.size': resource.transferSize || 0 },
    })
  }
}
