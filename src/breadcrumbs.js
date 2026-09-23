/**
 * Collects the steps that led up to an error.
 *
 * The steps tell how the error came about: which page was visited, which request
 * was made, what was written to the console. A ring buffer is used; past the
 * limit the oldest step is dropped.
 *
 * scrub_url rewrites the addresses of requests and pages as they are recorded.
 */
export function create_breadcrumbs(limit = 30, { ignore_url = '', on_request = null, scrub_url = (url) => url } = {}) {
  const items = []

  /** The SDK's own delivery requests are not steps of the application. */
  function ignored(url) {
    return Boolean(ignore_url) && String(url).startsWith(ignore_url)
  }

  function add(crumb) {
    items.push({
      category: crumb.category || 'log',
      message: truncate(crumb.message, 300),
      data: truncate(crumb.data, 300),
      level: crumb.level || 'info',
      at: crumb.at || new Date().toISOString(),
    })
    if (items.length > limit) items.shift()
  }

  /** Copies the steps with the newest first. */
  function list() {
    return [...items].reverse()
  }

  /** Records fetch calls as steps. */
  function install_fetch_hook() {
    if (typeof window === 'undefined' || !window.fetch || window.fetch.__bugfree) return

    const original = window.fetch
    const wrapped = async (...given) => {
      let args = given
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || String(args[0] || '')
      const method = args[1]?.method || args[0]?.method || 'GET'
      const started = Date.now()
      if (ignored(url)) return original(...args)

      // Inside a transaction the request is a span and may carry the trace header.
      const tracking = on_request?.(method, url)
      if (tracking?.headers && typeof Headers !== 'undefined') {
        const init = { ...(args[1] || {}) }
        const headers = new Headers(init.headers || (args[0] instanceof Object && args[0].headers) || undefined)
        for (const [name, value] of Object.entries(tracking.headers)) headers.set(name, value)
        init.headers = headers
        args = [args[0], init]
      }

      try {
        const response = await original(...args)
        tracking?.finish(response.status)
        add({
          category: 'fetch',
          message: `${method} ${scrub_url(url)}`,
          data: `${response.status} · ${Date.now() - started}ms`,
          level: response.status >= 400 ? 'warning' : 'info',
        })
        return response
      } catch (error) {
        tracking?.finish(0)
        add({
          category: 'fetch',
          message: `${method} ${scrub_url(url)}`,
          data: `failed · ${error.message}`,
          level: 'error',
        })
        throw error
      }
    }
    wrapped.__bugfree = true
    window.fetch = wrapped
  }

  /** Records console.error/warn calls as steps. */
  function install_console_hook() {
    if (typeof console === 'undefined') return

    for (const level of ['error', 'warn']) {
      const original = console[level]
      if (!original || original.__bugfree) continue

      const wrapped = (...args) => {
        add({
          category: 'console',
          message: args.map(stringify).join(' '),
          level: level === 'warn' ? 'warning' : 'error',
        })
        original.apply(console, args)
      }
      wrapped.__bugfree = true
      console[level] = wrapped
    }
  }

  /**
   * Records XMLHttpRequest calls as steps.
   *
   * Libraries such as axios still send through XHR, where the fetch hook does not
   * see them.
   */
  function install_xhr_hook() {
    const XHR = typeof window === 'undefined' ? undefined : window.XMLHttpRequest
    if (!XHR?.prototype || XHR.prototype.open.__bugfree) return

    const original_open = XHR.prototype.open
    const original_send = XHR.prototype.send

    const open = function (method, url, ...rest) {
      this.__bugfree_request = { method: String(method || 'GET').toUpperCase(), url: String(url) }
      return original_open.call(this, method, url, ...rest)
    }
    const send = function (...args) {
      const request = this.__bugfree_request
      if (request && !ignored(request.url)) {
        const started = Date.now()
        const tracking = on_request?.(request.method, request.url)
        for (const [name, value] of Object.entries(tracking?.headers || {})) this.setRequestHeader(name, value)
        this.addEventListener('loadend', () => {
          tracking?.finish(this.status)
          const failed = this.status === 0
          add({
            category: 'xhr',
            message: `${request.method} ${scrub_url(request.url)}`,
            data: failed ? 'failed' : `${this.status} · ${Date.now() - started}ms`,
            level: failed ? 'error' : this.status >= 400 ? 'warning' : 'info',
          })
        })
      }
      return original_send.apply(this, args)
    }
    open.__bugfree = true
    XHR.prototype.open = open
    XHR.prototype.send = send
  }

  /**
   * Records WebSocket connections as steps: opened, failed and closed, with the
   * close code, the reason and whether it closed cleanly. A terminal, a console or
   * a chat that stops updating left no trace before the error it caused.
   *
   * Messages are never recorded, sent or received: they are the application's data.
   */
  function install_websocket_hook() {
    const Native = typeof window === 'undefined' ? undefined : window.WebSocket
    if (typeof Native !== 'function' || Native.__bugfree) return

    // A subclass keeps instanceof, the static constants and every method as they are.
    class BugfreeWebSocket extends Native {
      constructor(url, protocols) {
        super(url, protocols)
        const address = scrub_url(String(url))
        const opened = Date.now()
        this.addEventListener('open', () => add({ category: 'websocket', message: `open ${address}` }))
        this.addEventListener('error', () => add({ category: 'websocket', message: `error ${address}`, level: 'error' }))
        this.addEventListener('close', (event) => {
          const reason = event.reason ? ` ${event.reason}` : ''
          add({
            category: 'websocket',
            message: `close ${address}`,
            data: `${event.code}${reason} · ${event.wasClean ? 'clean' : 'not clean'} · ${Date.now() - opened}ms`,
            level: event.wasClean ? 'info' : 'warning',
          })
        })
      }
    }
    BugfreeWebSocket.__bugfree = true
    window.WebSocket = BugfreeWebSocket
  }

  /**
   * Records clicks as steps, by the element clicked.
   *
   * Only a selector is kept (tag, id, classes, and a name or aria-label), never
   * the element's text: what a page shows may be personal data.
   */
  function install_click_hook() {
    if (typeof document === 'undefined' || !document.addEventListener || document.__bugfree_clicks) return
    document.__bugfree_clicks = true

    document.addEventListener(
      'click',
      (event) => {
        const selector = describe_element(event.target)
        if (selector) add({ category: 'ui.click', message: selector })
      },
      // Capture phase: a handler that stops propagation must not hide the click.
      true,
    )
  }

  /**
   * Records page changes as steps, for applications without a router install()
   * knows about.
   */
  function install_history_hook() {
    if (typeof window === 'undefined' || !window.history || window.history.pushState?.__bugfree) return

    let last = current_path()
    const record = () => {
      const next = current_path()
      if (next === last) return
      add({ category: 'navigation', message: `${scrub_url(last)} → ${scrub_url(next)}` })
      last = next
    }

    for (const name of ['pushState', 'replaceState']) {
      const original = window.history[name]
      if (typeof original !== 'function') continue
      const wrapped = function (...args) {
        const result = original.apply(this, args)
        record()
        return result
      }
      wrapped.__bugfree = true
      window.history[name] = wrapped
    }
    window.addEventListener?.('popstate', record)
  }

  return {
    add,
    list,
    install_fetch_hook,
    install_xhr_hook,
    install_websocket_hook,
    install_console_hook,
    install_click_hook,
    install_history_hook,
  }
}

function current_path() {
  if (typeof location === 'undefined') return ''
  return `${location.pathname || ''}${location.search || ''}`
}

/** Describes an element as a short CSS-like selector: button#save.primary[name="email"]. */
export function describe_element(element) {
  if (!element || typeof element.tagName !== 'string') return ''

  let selector = element.tagName.toLowerCase()
  if (element.id) selector += `#${element.id}`

  const classes = typeof element.className === 'string' ? element.className.trim().split(/\s+/) : []
  for (const name of classes.filter(Boolean).slice(0, 3)) selector += `.${name}`

  for (const attribute of ['name', 'aria-label', 'data-testid']) {
    const value = element.getAttribute?.(attribute)
    if (value) {
      selector += `[${attribute}="${value.slice(0, 40)}"]`
      break
    }
  }
  return selector
}

function truncate(value, length) {
  if (value === undefined || value === null) return ''
  const text = typeof value === 'string' ? value : stringify(value)
  return text.length > length ? `${text.slice(0, length)}…` : text
}

function stringify(value) {
  if (typeof value === 'string') return value
  if (value instanceof Error) return value.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}
