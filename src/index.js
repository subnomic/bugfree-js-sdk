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

export const VERSION = '0.1.0'

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
  debug: false,
  before_send: null,
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

export function create_bugfree(user_options = {}) {
  const options = { ...default_options, ...user_options }
  const dsn = parse_dsn(options.dsn)
  const transport = dsn ? create_transport(dsn.store_url, options.debug) : null
  const breadcrumbs = create_breadcrumbs(options.max_breadcrumbs)

  const tags = {}
  let user = null
  const seen = new Map()

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

    return Promise.all(
      frames.map(async (frame) => {
        try {
          const resolved = await resolve_frame(frame, options.source_context_lines)
          return resolved ? { ...frame, ...resolved } : frame
        } catch {
          return frame
        }
      }),
    )
  }

  /** Turns the error into an event and sends it (the internal implementation). */
  async function do_capture_exception(error, context = {}) {
    if (!enabled()) return null

    const value = error instanceof Error ? error : new Error(stringify(error))
    const type = context.type || value.name || 'Error'
    const message = value.message || stringify(error)

    let frames = parse_stack(value.stack)
    const signature = `${type}|${message}|${frames[0]?.file || ''}:${frames[0]?.line || 0}`
    if (is_duplicate(signature)) return null

    frames = await resolve_frames(frames)

    const culprit = frames.find((frame) => frame.in_app) || frames[0]
    const event = {
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
      extra: context.extra || {},
      request: {
        method: 'GET',
        url: location.pathname + location.search,
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

    return send({
      level: context.level || 'info',
      type: context.type || 'Message',
      message: String(message),
      platform: 'javascript',
      environment: options.environment,
      release: options.release,
      runtime: browser_runtime(navigator.userAgent),
      breadcrumbs: breadcrumbs.list(),
      tags: { sdk: `bugfree-js/${VERSION}`, ...tags, ...(context.tags || {}) },
      occurred_at: new Date().toISOString(),
    })
  }

  /** Turns the error into an event and sends it. */
  function capture_exception(error, context = {}) {
    return track(do_capture_exception(error, context))
  }

  /** Records a free-form message. */
  function capture_message(message, context = {}) {
    return track(do_capture_message(message, context))
  }

  function send(event) {
    if (options.sample_rate < 1 && Math.random() > options.sample_rate) return null

    let payload = event
    if (typeof options.before_send === 'function') {
      payload = options.before_send(event)
      if (!payload) return null
    }
    return transport.send(payload)
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
      capture_exception(event.error || event.message, { level: 'error' })
    })

    window.addEventListener('unhandledrejection', (event) => {
      capture_exception(event.reason, {
        level: 'error',
        type: 'UnhandledRejection',
        extra: { unhandled_rejection: true },
      })
    })

    if (app) {
      const previous = app.config.errorHandler
      app.config.errorHandler = (error, instance, info) => {
        capture_exception(error, {
          level: 'fatal',
          extra: { vue_info: info, component: instance?.$options?.__name || '' },
        })
        // Do not break the developer experience: write it to the console too.
        console.error(error)
        if (typeof previous === 'function') previous(error, instance, info)
      }
    }

    if (router) {
      router.afterEach((to, from) => {
        breadcrumbs.add({
          category: 'navigation',
          message: `${from.fullPath} → ${to.fullPath}`,
          level: 'info',
        })
      })
    }

    breadcrumbs.install_fetch_hook()
    breadcrumbs.install_console_hook()
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

  return {
    install,
    capture_exception,
    capture_message,
    add_breadcrumb: breadcrumbs.add,
    set_tag: (key, value) => {
      tags[key] = value
    },
    set_user: (value) => {
      user = value
    },
    flush,
    enabled,
  }
}

function stringify(value) {
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
