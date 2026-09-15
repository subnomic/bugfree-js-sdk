/**
 * Collects the steps that led up to an error.
 *
 * The steps tell how the error came about: which page was visited, which request
 * was made, what was written to the console. A ring buffer is used; past the
 * limit the oldest step is dropped.
 */
export function create_breadcrumbs(limit = 30) {
  const items = []

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
    const wrapped = async (...args) => {
      const url = typeof args[0] === 'string' ? args[0] : args[0]?.url || ''
      const method = args[1]?.method || 'GET'
      const started = Date.now()

      try {
        const response = await original(...args)
        add({
          category: 'fetch',
          message: `${method} ${url}`,
          data: `${response.status} · ${Date.now() - started}ms`,
          level: response.status >= 400 ? 'warning' : 'info',
        })
        return response
      } catch (error) {
        add({
          category: 'fetch',
          message: `${method} ${url}`,
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

  return { add, list, install_fetch_hook, install_console_hook }
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
