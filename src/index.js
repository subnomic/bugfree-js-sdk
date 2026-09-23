/**
 * @subnomic/bugfree-js — the bugfree SDK for browser applications, with Vue, React
 * or no framework at all.
 *
 * Usage:
 *
 *   import { create_bugfree } from '@subnomic/bugfree-js'
 *
 *   const bugfree = create_bugfree({
 *     dsn: 'http://<public_key>@localhost:3000/ingest',
 *     environment: 'production',
 *     release: 'web@1.4.0',
 *   })
 *   bugfree.install()              // any page
 *   bugfree.install(app, router)   // or a Vue application and its router
 *
 * With an empty DSN the SDK stays silently off; application code is identical in
 * every environment.
 */

// Extensions are written out so the module also loads without a bundler (node).
import { parse_stack } from './stack-trace.js'
import { resolve_frame } from './source-map.js'
import { create_transport } from './transport.js'
import { create_breadcrumbs } from './breadcrumbs.js'
import { open_feedback_dialog } from './feedback-dialog.js'
import { create_tracer } from './tracing.js'
import { create_recorder, create_replay_buffer } from './replay.js'

export const VERSION = '0.9.6'

/** Parses a DSN: http://<key>@host[/ingest] */
export function parse_dsn(dsn) {
  if (!dsn) return null

  try {
    const url = new URL(dsn)
    const key = url.username
    if (!key) return null

    const path = url.pathname.replace(/^\/|\/$/g, '') || 'ingest'
    return {
      public_key: key,
      store_url: `${url.protocol}//${url.host}/${path}/v1/${key}/store`,
      feedback_url: `${url.protocol}//${url.host}/${path}/v1/${key}/feedback`,
      sessions_url: `${url.protocol}//${url.host}/${path}/v1/${key}/sessions`,
      transactions_url: `${url.protocol}//${url.host}/${path}/v1/${key}/transactions`,
      profiles_url: `${url.protocol}//${url.host}/${path}/v1/${key}/profiles`,
      replays_url: `${url.protocol}//${url.host}/${path}/v1/${key}/replays`,
    }
  } catch {
    return null
  }
}

const default_options = {
  dsn: '',
  environment: 'production',
  release: '',
  sample_rate: 1,
  max_breadcrumbs: 30,
  source_context_lines: 5,
  // The same error is sent once inside this window (ms).
  dedupe_window_ms: 10_000,
  // Whether to resolve source maps; turned off, the bundled frames are sent.
  resolve_source_maps: true,
  // Errors to drop: a string matches anywhere in "Type: message", a RegExp is tested
  // against it.
  ignore_errors: [],
  // Script addresses whose errors are dropped (browser extensions, third-party
  // widgets): matched against the file of the frame that threw.
  deny_urls: [],
  // Counts every page load as a session of the release, for release health.
  track_sessions: true,
  // Sends a warning event for every Content-Security-Policy violation, one issue
  // per directive and blocked origin. Violations are breadcrumbs either way.
  report_csp_violations: false,
  // The share of page loads and navigations timed, between 0 and 1; 0 turns tracing off.
  traces_sample_rate: 0,
  // The share of page loads recorded from start to end as a session replay.
  replays_session_sample_rate: 0,
  // The share of page loads that keep the last minute in memory and send it as a
  // replay when an error is captured.
  replays_on_error_sample_rate: 0,
  // Masks every text of the page in replays; input values are always masked.
  replay_mask_all_text: true,
  // The share of timed transactions also profiled with the browser's JS
  // Self-Profiling API; the page has to be served with "Document-Policy: js-profiling".
  profiles_sample_rate: 0,
  // Addresses beyond the page's own origin whose requests carry the trace header:
  // strings the address starts with, or RegExps.
  trace_propagation_targets: [],
  debug: false,
  // Rewrites every address the SDK sends (the request of an event, breadcrumbs,
  // spans, replays, feedback) before before_send and before_send_transaction see
  // it: one place to remove the tokens a query string or a path may hold.
  scrub_url: null,
  before_send: null,
  // Changes or drops each timed transaction before it is sent, as before_send does
  // for events: span descriptions hold the addresses of the requests and resources,
  // query string included, and before_send never sees them.
  before_send_transaction: null,
}

/** Whether text matches one of the patterns: a substring or a RegExp. */
export function matches_any(text, patterns = []) {
  if (!text) return false
  return patterns.some((pattern) =>
    pattern instanceof RegExp ? pattern.test(text) : typeof pattern === 'string' && pattern !== '' && text.includes(pattern),
  )
}

/**
 * Describes the browser at the time of the event: what makes a layout bug or a
 * failed request readable ("only on narrow screens", "only while offline").
 */
export function browser_context() {
  const context = {}
  if (typeof window !== 'undefined' && window.innerWidth) {
    context.viewport = `${window.innerWidth}x${window.innerHeight}`
    if (window.devicePixelRatio) context.pixel_ratio = window.devicePixelRatio
  }
  if (typeof screen !== 'undefined' && screen?.width) context.screen = `${screen.width}x${screen.height}`
  if (typeof navigator !== 'undefined') {
    if (navigator.language) context.language = navigator.language
    if (typeof navigator.onLine === 'boolean') context.online = navigator.onLine
    if (navigator.connection?.effectiveType) context.connection = navigator.connection.effectiveType
  }
  if (typeof document !== 'undefined' && document.visibilityState) context.visibility = document.visibilityState
  return context
}

/**
 * Produces a short runtime label: "Chrome/141", "Safari/26"...
 *
 * The full User-Agent is stored in the event's `request.user_agent` field;
 * `runtime` is shown as a tag in the interface, so it has to be short and readable.
 */
export function browser_runtime(user_agent = '') {
  // The order matters: Edge/Chrome carry both "Chrome" and their own name, and
  // Safari appears in every Chromium browser; the most specific is tried first.
  const patterns = [
    /(Edg)\/([\d.]+)/,
    /(OPR)\/([\d.]+)/,
    /(Firefox)\/([\d.]+)/,
    /(Chrome)\/([\d.]+)/,
    /Version\/([\d.]+).*(Safari)/,
  ]
  const names = { Edg: 'Edge', OPR: 'Opera' }

  for (const pattern of patterns) {
    const match = user_agent.match(pattern)
    if (!match) continue
    // The Safari pattern captures the version first; the others capture the name first.
    const [name, version] = match[2] === 'Safari' ? [match[2], match[1]] : [match[1], match[2]]
    // Only the major version: "141.0.0.0" would split the grouping for nothing.
    return `${names[name] || name}/${version.split('.')[0]}`
  }
  return user_agent.slice(0, 80)
}

// What an address becomes when scrub_url fails, as the server masks a value.
const filtered_url = '[Filtered]'

export function create_bugfree(user_options = {}) {
  const options = { ...default_options, ...user_options }
  const dsn = parse_dsn(options.dsn)
  const transport = dsn ? create_transport(dsn.store_url, options.debug) : null

  /**
   * Passes an address the SDK is about to send through scrub_url.
   *
   * A hook that throws, or returns anything but a string, sends [Filtered]: the
   * address may hold the very token the hook was there to remove.
   */
  function clean_url(url) {
    const address = url === undefined || url === null ? '' : String(url)
    if (typeof options.scrub_url !== 'function') return address
    try {
      const cleaned = options.scrub_url(address)
      if (typeof cleaned === 'string') return cleaned
    } catch (error) {
      if (options.debug) console.warn('[bugfree]', 'scrub_url failed, the address is filtered', error)
    }
    return filtered_url
  }

  const tracer = create_tracer({
    sample_rate: dsn ? options.traces_sample_rate : 0,
    propagation_targets: options.trace_propagation_targets,
    scrub_url: clean_url,
    send: (transaction) => send_transaction(transaction),
    on_start: (transaction) => start_profile(transaction),
    on_finish: (transaction, end, sent) => finish_profile(transaction, end, sent),
  })

  // The profile of the transaction running now; one at a time.
  let profile_run = null

  /** Starts profiling a transaction, when the browser can and the sample says so. */
  function start_profile(transaction) {
    if (!(options.profiles_sample_rate > 0) || Math.random() >= options.profiles_sample_rate) return
    const Profiler = typeof window !== 'undefined' ? window.Profiler : undefined
    if (typeof Profiler !== 'function') return
    try {
      profile_run = { transaction, profiler: new Profiler({ sampleInterval: 10, maxBufferSize: 10_000 }) }
    } catch (error) {
      // Without the document policy the constructor throws; profiling stays off.
      if (options.debug) console.warn('[bugfree]', 'profiling is not available', error)
    }
  }

  /**
   * Stops the transaction's profile and sends it, tied to its trace. The profiler
   * stops either way; a transaction that was not sent (before_send_transaction
   * dropped it, the transport is paused) leaves its profile unsent, with nothing
   * it could belong to.
   */
  async function finish_profile(transaction, end, sent = true) {
    const run = profile_run
    if (!run || run.transaction !== transaction) return
    profile_run = null
    try {
      const trace = await run.profiler.stop()
      if (!sent || !transport || transport.paused() || !trace?.samples?.length) return
      fetch(dsn.profiles_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          kind: 'browser',
          format: 'js-self-profile',
          // The resources are the addresses of the scripts that ran.
          profile: { ...trace, resources: (trace.resources || []).map(clean_url) },
          sample_interval_ms: run.profiler.sampleInterval || 10,
          trace_id: transaction.trace_id,
          started_at: new Date(transaction.start).toISOString(),
          duration_ms: Math.round(Math.max(0, end - transaction.start)),
          environment: options.environment,
          release: options.release,
          platform: 'javascript',
        }),
        credentials: 'omit',
      }).catch(() => {})
    } catch (error) {
      if (options.debug) console.warn('[bugfree]', 'profile could not be sent', error)
    }
  }
  const breadcrumbs = create_breadcrumbs(options.max_breadcrumbs, {
    // Every delivery of the SDK goes to the same ingest address.
    ignore_url: dsn?.store_url.replace(/\/store$/, ''),
    on_request: tracer.enabled ? tracer.on_request : null,
    scrub_url: clean_url,
  })

  const tags = {}
  let user = null
  let last_event_id = null
  const seen = new Map()
  // The page load's session, once install() started it.
  let session = null
  // The replay being recorded, once install() started one.
  let replay = null

  const enabled = () => Boolean(transport)

  /**
   * Captures that have not reached the transport yet.
   *
   * The capture chain is asynchronous (it waits for source map resolution); a
   * flush that only looks at the transport queue counts an event that has not
   * even been queued as "done" and loses it when the page closes.
   */
  const in_progress = new Set()

  function track(promise) {
    in_progress.add(promise)
    // An error in the chain must not lock up the flush.
    promise.catch(() => {}).finally(() => in_progress.delete(promise))
    return promise
  }

  /** Stops the same error from being sent over and over in a loop. */
  function is_duplicate(signature) {
    const now = Date.now()
    const previous = seen.get(signature)
    seen.set(signature, now)

    if (seen.size > 200) {
      for (const [key, at] of seen) {
        if (now - at > options.dedupe_window_ms) seen.delete(key)
      }
    }
    return previous !== undefined && now - previous < options.dedupe_window_ms
  }

  /**
   * Turns the frames into original source with the source map.
   * A frame that cannot be resolved is kept as it is.
   */
  async function resolve_frames(frames) {
    if (!options.resolve_source_maps) return frames

    const resolved = await Promise.all(
      frames.map(async (frame) => {
        try {
          return await resolve_frame(frame, options.source_context_lines)
        } catch {
          return null
        }
      }),
    )

    // Frames run innermost first, so the next frame is the caller. Where the
    // original file was not available, the name at its call site names the
    // function it called.
    return frames.map((frame, index) => {
      const own = resolved[index]
      if (!own) return frame
      const caller = resolved[index + 1]
      if (!own.named_from_source && caller?.call_name) own.function = caller.call_name
      return { ...frame, ...own }
    })
  }

  /**
   * Reports session counts. Sent at once with keepalive: a session report is tiny
   * and matters most when the page is about to go away.
   */
  function report_session(counts) {
    if (!session || !transport || transport.paused()) return
    const body = JSON.stringify({
      sessions: [
        {
          release: options.release,
          environment: options.environment,
          started: session.started,
          did: user?.id ? String(user.id) : '',
          total: 0,
          errored: 0,
          crashed: 0,
          ...counts,
        },
      ],
    })
    fetch(dsn.sessions_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
      credentials: 'omit',
    }).catch((error) => {
      if (options.debug) console.warn('[bugfree]', 'session could not be reported', error)
    })
  }

  /**
   * Reports a finished transaction, with the release and environment, after
   * before_send_transaction had its say. Returns whether it was sent.
   *
   * The hook runs where the transaction ends, which may be inside a router hook: an
   * error it throws drops the transaction instead of reaching the application.
   */
  function send_transaction(transaction) {
    if (!transport || transport.paused()) return false
    let payload = {
      ...transaction,
      environment: options.environment,
      release: options.release,
      user_id: user?.id ? String(user.id) : '',
      tags: { ...tags },
    }
    if (typeof options.before_send_transaction === 'function') {
      try {
        payload = options.before_send_transaction(payload)
      } catch (error) {
        if (options.debug) console.warn('[bugfree]', 'before_send_transaction failed, transaction dropped', error)
        return false
      }
      if (!payload) return false
    }
    const body = JSON.stringify({ transactions: [payload] })
    fetch(dsn.transactions_url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: body.length < 60_000,
      credentials: 'omit',
    }).catch((error) => {
      if (options.debug) console.warn('[bugfree]', 'transaction could not be sent', error)
    })
    return true
  }

  // How often a recording in session mode sends what it has (ms), the most events
  // one segment holds, and the longest a replay records (ms).
  const replay_flush_ms = 10_000
  const replay_segment_events = 3000
  const replay_max_ms = 60 * 60_000

  /**
   * Starts recording, in session mode or in buffer mode, as the sample rates say.
   * A browser without MutationObserver records nothing.
   */
  function start_replay() {
    if (replay || !dsn) return
    const mode =
      Math.random() < options.replays_session_sample_rate
        ? 'session'
        : Math.random() < options.replays_on_error_sample_rate
          ? 'buffer'
          : null
    if (!mode) return

    const buffer = create_replay_buffer()
    const state = {
      id: new_event_id(),
      mode,
      buffer,
      pending: [],
      error_ids: [],
      segment: 0,
      started: Date.now(),
    }
    state.recorder = create_recorder({
      mask_all_text: options.replay_mask_all_text,
      scrub_url: clean_url,
      on_event: (event) => {
        if (state.mode === 'buffer') state.buffer.push(event)
        else {
          state.pending.push(event)
          if (state.pending.length >= replay_segment_events) flush_replay()
        }
      },
    })
    replay = state
    if (!state.recorder.start()) {
      replay = null
      return
    }
    state.timer = setInterval(() => {
      if (Date.now() - state.started > replay_max_ms) return stop_replay()
      if (state.mode === 'session') flush_replay()
      else if (state.buffer.needs_checkout(Date.now())) state.recorder.snapshot()
    }, replay_flush_ms)
  }

  function stop_replay() {
    if (!replay) return
    flush_replay()
    clearInterval(replay.timer)
    replay.recorder.stop()
    replay = null
  }

  /**
   * Ties a captured error to the replay. A replay kept in memory is sent from here
   * on: what came before the error, and everything after it.
   */
  function note_replay_error(event_id) {
    if (!replay) return null
    if (event_id) replay.error_ids.push(event_id)
    if (replay.mode === 'buffer') {
      replay.mode = 'session'
      replay.pending = replay.buffer.take()
    }
    // Sent on the next tick, so the error's own event reaches the server first.
    setTimeout(flush_replay, 0)
    return replay.id
  }

  /** Sends what the replay recorded since the last segment. */
  function flush_replay({ leaving = false } = {}) {
    if (!replay || replay.mode !== 'session' || !transport || transport.paused()) return
    if (!replay.pending.length && !replay.error_ids.length) return
    const events = replay.pending
    replay.pending = []
    const body = JSON.stringify({
      segment: replay.segment,
      events,
      error_ids: replay.error_ids,
      started_at: new Date(replay.started).toISOString(),
      url: clean_url(typeof location !== 'undefined' ? location.href : ''),
      environment: options.environment,
      release: options.release,
      user_id: user?.id ? String(user.id) : '',
      browser: typeof navigator !== 'undefined' ? browser_runtime(navigator.userAgent) : '',
    })
    replay.segment += 1
    replay.error_ids = []
    fetch(`${dsn.replays_url}/${replay.id}/segments`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: leaving && body.length < 60_000,
      credentials: 'omit',
    }).catch((error) => {
      if (options.debug) console.warn('[bugfree]', 'replay segment could not be sent', error)
    })
  }

  /** Starts the page load's session. */
  function start_session() {
    if (!options.track_sessions || !options.release || session) return
    session = { started: new Date().toISOString(), errored: false, crashed: false, user_counted: Boolean(user?.id) }
    report_session({ total: 1 })
  }

  /**
   * Marks the session: an unhandled error crashes it, a captured one errors it.
   * Each change is reported once; a crashed session is errored too.
   */
  function note_session(outcome) {
    if (!session || session.crashed) return
    if (outcome === 'crashed') {
      report_session({ crashed: 1, errored: session.errored ? 0 : 1 })
      session.crashed = true
      session.errored = true
      return
    }
    if (session.errored) return
    session.errored = true
    report_session({ errored: 1 })
  }

  /** Turns the error into an event and sends it (the internal implementation). */
  async function do_capture_exception(error, context = {}) {
    if (!enabled()) return null

    const value = error instanceof Error ? error : new Error(stringify(error))
    const type = context.type || value.name || 'Error'
    const message = value.message || stringify(error)

    let frames = parse_stack(value.stack)
    if (matches_any(`${type}: ${message}`, options.ignore_errors)) return null
    if (matches_any(frames[0]?.file, options.deny_urls)) return null
    note_session(context.handled === false ? 'crashed' : 'errored')
    const replay_id = note_replay_error(context.event_id)

    const signature = `${type}|${message}|${frames[0]?.file || ''}:${frames[0]?.line || 0}`
    if (is_duplicate(signature)) return null
    // Still synchronous: last_event_id() has the id as soon as the call returns.
    last_event_id = context.event_id

    frames = await resolve_frames(frames)

    const extra = { browser: browser_context(), ...(context.extra || {}) }
    if (replay_id) extra.replay_id = replay_id
    const trace = tracer.active()
    const chain = error_chain(value)
    if (chain.length > 0) extra.error_chain = chain

    const culprit = frames.find((frame) => frame.in_app) || frames[0]
    const event = {
      event_id: context.event_id,
      trace_id: trace?.trace_id,
      level: context.level || 'error',
      type,
      message,
      culprit: culprit ? `${culprit.function} (${culprit.file}:${culprit.line})` : '',
      platform: 'javascript',
      environment: options.environment,
      release: options.release,
      runtime: browser_runtime(navigator.userAgent),
      stacktrace: frames,
      breadcrumbs: breadcrumbs.list(),
      tags: { sdk: `bugfree-js/${VERSION}`, ...tags, ...(context.tags || {}) },
      extra,
      request: {
        method: 'GET',
        url: clean_url(location.pathname + location.search),
        user_agent: navigator.userAgent,
      },
      occurred_at: new Date().toISOString(),
    }
    if (user) event.user = user

    return send(event)
  }

  /** Records a free-form message (the internal implementation). */
  async function do_capture_message(message, context = {}) {
    if (!enabled()) return null
    const type = context.type || 'Message'
    if (matches_any(`${type}: ${message}`, options.ignore_errors)) return null
    last_event_id = context.event_id

    return send({
      event_id: context.event_id,
      level: context.level || 'info',
      type,
      message: String(message),
      extra: { browser: browser_context(), ...(context.extra || {}) },
      platform: 'javascript',
      environment: options.environment,
      release: options.release,
      runtime: browser_runtime(navigator.userAgent),
      breadcrumbs: breadcrumbs.list(),
      tags: { sdk: `bugfree-js/${VERSION}`, ...tags, ...(context.tags || {}) },
      occurred_at: new Date().toISOString(),
    })
  }

  /**
   * Records a Content-Security-Policy violation: a breadcrumb always, and a warning
   * event with report_csp_violations. A blocked request leaves no trace on any
   * server; without this it is found only in the browser's console.
   */
  function note_csp_violation(violation) {
    if (from_extension(violation.sourceFile) || from_extension(violation.blockedURI)) return
    const directive = csp_directive(violation)
    const source = violation.sourceFile ? `${clean_url(violation.sourceFile)}:${violation.lineNumber || 0}` : ''
    breadcrumbs.add({ category: 'csp', message: `${directive} blocked ${clean_url(violation.blockedURI)}`, data: source, level: 'warning' })
    if (options.report_csp_violations) track(do_capture_csp(violation, directive))
  }

  /**
   * Sends a violation as an event. Its type, culprit and message are the ones the
   * server's csp endpoint writes, so both land in one issue per directive and
   * blocked origin; a repeat inside the dedupe window is sent once.
   */
  async function do_capture_csp(violation, directive) {
    if (!enabled()) return null
    const origin = clean_url(blocked_origin(violation.blockedURI))
    if (is_duplicate(`csp|${directive}|${origin}`)) return null
    const disposition = violation.disposition || 'enforce'
    return send({
      event_id: new_event_id(),
      level: 'warning',
      type: 'CSPViolation',
      message: `${directive} blocked ${origin}`,
      culprit: directive,
      platform: 'javascript',
      environment: options.environment,
      release: options.release,
      runtime: browser_runtime(navigator.userAgent),
      breadcrumbs: breadcrumbs.list(),
      tags: { sdk: `bugfree-js/${VERSION}`, ...tags, 'csp.directive': directive, 'csp.disposition': disposition },
      extra: {
        browser: browser_context(),
        csp: {
          directive,
          blocked_url: clean_url(violation.blockedURI),
          source_file: clean_url(violation.sourceFile),
          line: violation.lineNumber || 0,
          column: violation.columnNumber || 0,
          disposition,
          sample: violation.sample || '',
        },
      },
      request: {
        method: 'GET',
        url: clean_url(location.pathname + location.search),
        user_agent: navigator.userAgent,
      },
      occurred_at: new Date().toISOString(),
    })
  }

  /**
   * Turns the error into an event and sends it.
   *
   * The promise resolves once the event is handed over, to the event's id, or to
   * null when nothing was sent (disabled, a repeat, sampled out, dropped by
   * before_send). last_event_id() has the id as soon as the call returns.
   */
  function capture_exception(error, context = {}) {
    return track(do_capture_exception(error, with_event_id(context)))
  }

  /** Records a free-form message; resolves like capture_exception. */
  function capture_message(message, context = {}) {
    return track(do_capture_message(message, with_event_id(context)))
  }

  /** Chooses the event's id up front, so the caller can have it before delivery. */
  function with_event_id(context) {
    return { ...context, event_id: new_event_id() }
  }

  async function send(event) {
    if (options.sample_rate < 1 && Math.random() > options.sample_rate) return null

    let payload = event
    if (typeof options.before_send === 'function') {
      payload = options.before_send(event)
      if (!payload) return null
    }
    await transport.send(payload)
    return payload.event_id || null
  }

  /**
   * Installs the global handlers.
   *
   * With app given, Vue's errorHandler is attached; with router given, page
   * transitions are recorded as steps.
   */
  function install(app, router) {
    if (!enabled()) return

    window.addEventListener('error', (event) => {
      // An error from a cross-origin script has no stack to match deny_urls against,
      // only the address of the script.
      if (matches_any(event.filename, options.deny_urls)) return
      capture_exception(event.error || event.message, { level: 'error', handled: false })
    })

    window.addEventListener('unhandledrejection', (event) => {
      capture_exception(event.reason, {
        level: 'error',
        handled: false,
        type: 'UnhandledRejection',
        extra: { unhandled_rejection: true },
      })
    })

    if (app) {
      const previous = app.config.errorHandler
      app.config.errorHandler = (error, instance, info) => {
        capture_exception(error, {
          level: 'fatal',
          handled: false,
          extra: { vue_info: info, component: instance?.$options?.__name || '' },
        })
        // Do not break the developer experience: write it to the console too.
        console.error(error)
        if (typeof previous === 'function') previous(error, instance, info)
      }
    }

    // The page load is timed from the navigation start; a router names it after
    // the route pattern once it resolved. Until then it is named after the address.
    tracer.start_page_load(clean_url(typeof location !== 'undefined' ? location.pathname : '/'))
    if (router) {
      let first = true
      router.afterEach((to) => {
        const route = to.matched?.[to.matched.length - 1]?.path || clean_url(to.path)
        if (first) tracer.rename(route)
        else tracer.start_navigation(route)
        first = false
      })
    }

    if (router) {
      router.afterEach((to, from) => {
        breadcrumbs.add({
          category: 'navigation',
          message: `${clean_url(from.fullPath)} → ${clean_url(to.fullPath)}`,
          level: 'info',
        })
      })
    }

    // Without a router, page changes are read from the History API.
    if (!router) breadcrumbs.install_history_hook()

    breadcrumbs.install_fetch_hook()
    breadcrumbs.install_xhr_hook()
    breadcrumbs.install_websocket_hook()
    breadcrumbs.install_click_hook()
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('securitypolicyviolation', note_csp_violation)
    }
    start_session()
    breadcrumbs.install_console_hook()

    // The page is being left (a tab closed, a link followed): hand the queued
    // events to sendBeacon before the page and its queue are gone. pagehide also
    // fires when the page enters the back/forward cache, where unload does not.
    window.addEventListener('pagehide', () => {
      tracer.report_interactions()
      transport.beacon_queued()
      flush_replay({ leaving: true })
    })
    // A phone rarely fires pagehide: the page is hidden and then discarded. The
    // route's INP so far goes out when it is hidden.
    if (typeof document !== 'undefined' && document.addEventListener) {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') tracer.report_interactions()
      })
    }
    start_replay()
  }

  /**
   * Sends everything pending: first the capture chains, then the queue.
   *
   * Awaiting the pending ones can produce new captures (breadcrumb hooks, for
   * instance), so it retries until the time is up.
   */
  async function flush(timeout_ms = 2000) {
    const deadline = Date.now() + timeout_ms
    while (in_progress.size > 0 && Date.now() < deadline) {
      await Promise.allSettled([...in_progress])
    }
    if (!transport) return true
    return transport.flush(Math.max(0, deadline - Date.now()))
  }

  /**
   * Sends what a user wrote about a problem. Without an event_id it is tied to the
   * latest captured event, which is usually the error the user just saw.
   *
   * Resolves to true when the server stored it.
   */
  async function capture_feedback({ message, name = '', email = '', event_id, url } = {}) {
    if (!enabled() || !message || !String(message).trim()) return false
    const body = {
      event_id: event_id === undefined ? last_event_id : event_id,
      message: String(message),
      name,
      email,
      url: clean_url(url ?? (typeof location !== 'undefined' ? location.href : '')),
      environment: options.environment,
      release: options.release,
    }
    try {
      const response = await fetch(dsn.feedback_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        credentials: 'omit',
      })
      return response.ok
    } catch (error) {
      if (options.debug) console.warn('[bugfree]', 'feedback could not be sent', error)
      return false
    }
  }

  /**
   * Opens a dialog asking the user what happened and sends the answer. Resolves to
   * true when feedback was sent, false when the dialog was closed.
   *
   * labels replaces the dialog's English texts; the user set with set_user fills in
   * the email field.
   */
  function show_feedback_dialog({ event_id, labels } = {}) {
    if (!enabled()) return Promise.resolve(false)
    const tied_to = event_id === undefined ? last_event_id : event_id
    return open_feedback_dialog({
      labels,
      name: user?.name || user?.username || '',
      email: user?.email || '',
      submit: (values) => capture_feedback({ ...values, event_id: tied_to }),
    })
  }

  /**
   * Times a piece of work the page does outside a page load or navigation, such as
   * a button that saves: the requests made meanwhile become its spans, and it ends
   * once the page is idle. Returns { trace_id, finish() }, or null with tracing off.
   */
  function start_transaction(name, { op = 'ui.action' } = {}) {
    const transaction = tracer.start(String(name), op)
    if (!transaction) return null
    return { trace_id: transaction.trace_id, finish: () => tracer.finish(transaction) }
  }

  return {
    install,
    start_transaction,
    /** The id of the replay being recorded, or null. */
    replay_id: () => replay?.id || null,
    stop_replay,
    capture_exception,
    capture_feedback,
    show_feedback_dialog,
    capture_message,
    add_breadcrumb: breadcrumbs.add,
    // A tag set to null or undefined is removed, such as the tenant after signing out.
    set_tag: (key, value) => {
      if (value === null || value === undefined) delete tags[key]
      else tags[key] = value
    },
    set_user: (value) => {
      user = value
      // The session's user is counted once, when an id first becomes known.
      if (session && !session.user_counted && user?.id) {
        session.user_counted = true
        report_session({})
      }
    },
    flush,
    enabled,
    last_event_id: () => last_event_id,
  }
}

/** The name of the directive a violation broke; older browsers send its value too. */
function csp_directive(violation) {
  const directive = violation.effectiveDirective || String(violation.violatedDirective || '').trim().split(/\s+/)[0]
  return directive ? directive.toLowerCase() : 'unknown'
}

/**
 * Reduces what a policy blocked to what the policy names: the origin of an
 * address, the scheme of data: or blob:, or the keyword a browser reports for
 * code written into the page. The server groups its reports the same way.
 */
export function blocked_origin(blocked) {
  const text = String(blocked || '').trim()
  if (!text) return 'unknown'
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(text)
  if (!scheme) return text
  const host = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(text)
  return host && host[1] ? `${scheme[1].toLowerCase()}://${host[1]}` : scheme[1].toLowerCase()
}

// Browser extensions break a page's policy on every visit; their violations say
// nothing about the application.
const extension_schemes = ['chrome-extension:', 'moz-extension:', 'safari-extension:', 'safari-web-extension:', 'ms-browser-extension:']

function from_extension(address) {
  const text = String(address || '').trim().toLowerCase()
  return extension_schemes.some((scheme) => text.startsWith(scheme))
}

// The deepest `cause` chain an event lists.
const max_chain_length = 10

/**
 * Lists the errors behind error.cause, outermost first.
 *
 * The reported error's own type and message are already the event's; the chain
 * holds what caused it: new Error('checkout failed', { cause }).
 */
export function error_chain(error) {
  const chain = []
  const visited = new Set([error])
  let current = error?.cause

  while (current !== undefined && current !== null && chain.length < max_chain_length) {
    if (visited.has(current)) break
    visited.add(current)

    chain.push(
      current instanceof Error
        ? { type: current.name || 'Error', message: current.message || '' }
        : { type: typeof current, message: stringify(current) },
    )
    current = current instanceof Error ? current.cause : undefined
  }
  return chain
}

/** Produces a random (version 4) UUID. */
export function new_event_id() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  // crypto.randomUUID needs a secure context (https or localhost).
  const bytes = new Uint8Array(16)
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    crypto.getRandomValues(bytes)
  } else {
    for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256)
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

function stringify(value) {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
