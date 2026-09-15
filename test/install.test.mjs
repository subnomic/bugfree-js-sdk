import assert from 'node:assert/strict'
import { test } from 'node:test'

import { browser_runtime, create_bugfree } from '../src/index.js'

/**
 * Verifies that the handlers install() sets up really produce events.
 *
 * Why: the interface's own errors (an uncaught exception, a rejected promise, a
 * Vue render error) produced no record at all for a long time. The loss was
 * somewhere in the middle of the chain every time -- once a field exceeded a
 * database limit -- and nothing but trying it by hand in a browser caught it.
 * This test emulates the browser environment and runs the chain end to end.
 */

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

/** Installs the browser globals and collects the bodies that were sent. */
function fake_browser({ user_agent = CHROME_UA } = {}) {
  const listeners = {}
  const sent = []

  globalThis.window = {
    addEventListener: (name, handler) => {
      listeners[name] = [...(listeners[name] || []), handler]
    },
    // breadcrumbs.install_fetch_hook wraps this.
    fetch: async () => ({ ok: true, status: 200 }),
  }
  // Node's own navigator is read-only; the definition is replaced.
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: user_agent, sendBeacon: () => true },
    configurable: true,
    writable: true,
  })
  globalThis.location = { pathname: '/debug', search: '', origin: 'http://localhost:3000' }
  globalThis.fetch = async (url, options) => {
    sent.push({ url, body: JSON.parse(options.body) })
    return { ok: true, status: 202, json: async () => ({ event_id: 'x' }) }
  }

  return {
    sent,
    /** Fires a registered global handler. */
    emit: (name, event) => {
      const handlers = listeners[name] || []
      assert.ok(handlers.length > 0, `${name} handler was not installed`)
      handlers.forEach((handler) => handler(event))
    },
  }
}

/** The smallest Vue application that carries an errorHandler. */
function fake_app() {
  return { config: { errorHandler: null } }
}

function new_client() {
  return create_bugfree({
    dsn: 'http://public-key@localhost:3000/ingest',
    environment: 'development',
    release: 'bugfree-web@test',
    // Source maps need the network; this test measures delivery.
    resolve_source_maps: false,
  })
}

test('install sends an uncaught exception', async () => {
  const browser = fake_browser()
  const client = new_client()
  client.install(fake_app())

  const error = new TypeError("Cannot read properties of undefined (reading 'items')")
  browser.emit('error', { error })
  await client.flush()

  assert.equal(browser.sent.length, 1)
  const event = browser.sent[0].body
  assert.equal(browser.sent[0].url, 'http://localhost:3000/ingest/v1/public-key/store')
  assert.equal(event.type, 'TypeError')
  assert.equal(event.level, 'error')
  assert.equal(event.platform, 'javascript')
  assert.match(event.message, /Cannot read properties/)
})

test('install sends a rejected promise', async () => {
  const browser = fake_browser()
  const client = new_client()
  client.install(fake_app())

  browser.emit('unhandledrejection', { reason: new Error('deliberate rejection') })
  await client.flush()

  assert.equal(browser.sent.length, 1)
  assert.equal(browser.sent[0].body.type, 'UnhandledRejection')
  assert.equal(browser.sent[0].body.extra.unhandled_rejection, true)
})

test('install sends a Vue render error', async () => {
  const browser = fake_browser()
  const client = new_client()
  const app = fake_app()
  client.install(app)

  assert.equal(typeof app.config.errorHandler, 'function', 'errorHandler was not attached')
  app.config.errorHandler(new TypeError('render blew up'), { $options: { __name: 'debug-page' } }, 'render function')
  await client.flush()

  assert.equal(browser.sent.length, 1)
  const event = browser.sent[0].body
  assert.equal(event.level, 'fatal')
  assert.equal(event.extra.vue_info, 'render function')
  assert.equal(event.extra.component, 'debug-page')
})

test('install keeps the previous errorHandler chained', async () => {
  fake_browser()
  const client = new_client()
  const app = fake_app()
  const seen = []
  app.config.errorHandler = (error) => seen.push(error.message)

  client.install(app)
  app.config.errorHandler(new Error('chain'), null, 'setup')
  await client.flush()

  assert.deepEqual(seen, ['chain'])
})

test('capture_exception sends when called by hand', async () => {
  const browser = fake_browser()
  const client = new_client()
  client.install(fake_app())

  client.set_tag('triggered_from', 'debug-page')
  client.add_breadcrumb({ category: 'ui', message: 'clicked manual capture' })
  await client.capture_exception(new Error('manual capture'))

  assert.equal(browser.sent.length, 1)
  const event = browser.sent[0].body
  assert.equal(event.tags.triggered_from, 'debug-page')
  assert.equal(event.breadcrumbs[0].message, 'clicked manual capture')
})

// events.runtime is varchar(255): the full User-Agent used to fail the INSERT
// (while it was varchar(80)) and no event from a browser could be stored.
test('the runtime field carries a short label and the full User-Agent stays in the request context', async () => {
  const browser = fake_browser()
  const client = new_client()
  client.install(fake_app())

  browser.emit('error', { error: new Error('boom') })
  await client.flush()

  const event = browser.sent[0].body
  assert.equal(event.runtime, 'Chrome/141')
  assert.ok(event.runtime.length <= 80, 'the runtime label has to be short')
  assert.equal(event.request.user_agent, CHROME_UA)
})

test('browser_runtime recognizes the common browsers', () => {
  const cases = [
    [CHROME_UA, 'Chrome/141'],
    [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/141.0.0.0 Safari/537.36 Edg/141.0.3537.57',
      'Edge/141',
    ],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:135.0) Gecko/20100101 Firefox/135.0', 'Firefox/135'],
    [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) ' +
        'Version/26.0 Safari/605.1.15',
      'Safari/26',
    ],
  ]

  for (const [user_agent, expected] of cases) {
    assert.equal(browser_runtime(user_agent), expected, user_agent)
  }
})

test('browser_runtime clips a value it does not recognize', () => {
  const long = 'x'.repeat(400)
  assert.equal(browser_runtime(long).length, 80)
  assert.equal(browser_runtime(''), '')
})
