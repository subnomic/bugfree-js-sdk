import assert from 'node:assert/strict'
import { test } from 'node:test'

import { browser_runtime, create_bugfree, error_chain } from '../src/index.js'

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
  const sessions = []

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
    // Session reports are counted apart from the events they accompany.
    if (url.endsWith('/sessions')) {
      sessions.push(JSON.parse(options.body).sessions[0])
      return { ok: true, status: 202, json: async () => ({}) }
    }
    sent.push({ url, body: JSON.parse(options.body) })
    return { ok: true, status: 202, json: async () => ({ event_id: 'x' }) }
  }

  return {
    sent,
    sessions,
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

test('capture resolves to the event id, which the sent event carries', async () => {
  const browser = fake_browser()
  const client = new_client()
  client.install(fake_app())

  const pending = client.capture_exception(new Error('with an id'))
  const immediate = client.last_event_id()
  const id = await pending

  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(immediate, id, 'last_event_id() has the id before delivery')
  assert.equal(browser.sent[0].body.event_id, id)
})

test('a repeated error resolves to null and keeps the previous id', async () => {
  fake_browser()
  const client = new_client()
  client.install(fake_app())

  const error = new Error('repeated')
  const first = await client.capture_exception(error)
  const second = await client.capture_exception(error)

  assert.equal(second, null)
  assert.equal(client.last_event_id(), first)
})

test('the cause chain is sent with the event', async () => {
  const browser = fake_browser()
  const client = new_client()
  client.install(fake_app())

  const root = new TypeError('response.json is not a function')
  const middle = new Error('order could not be loaded', { cause: root })
  await client.capture_exception(new Error('checkout failed', { cause: middle }))

  assert.deepEqual(browser.sent[0].body.extra.error_chain, [
    { type: 'Error', message: 'order could not be loaded' },
    { type: 'TypeError', message: 'response.json is not a function' },
  ])
})

test('error_chain stops at a cycle and describes a cause that is not an Error', () => {
  const first = new Error('first')
  const second = new Error('second', { cause: first })
  first.cause = second

  assert.deepEqual(error_chain(first), [{ type: 'Error', message: 'second' }])
  assert.deepEqual(error_chain(new Error('coded', { cause: { code: 42 } })), [{ type: 'object', message: '{"code":42}' }])
  assert.deepEqual(error_chain(new Error('plain')), [])
})

test('leaving the page hands queued events to sendBeacon', async () => {
  const browser = fake_browser()
  const beacons = []
  navigator.sendBeacon = (url, blob) => {
    beacons.push(url)
    return true
  }
  // The first request never answers, so the next events stay queued behind it.
  globalThis.fetch = () => new Promise(() => {})

  const client = new_client()
  client.install(fake_app())

  client.capture_message('in flight')
  client.capture_message('queued one')
  client.capture_message('queued two')
  await new Promise((resolve) => setTimeout(resolve, 10))

  browser.emit('pagehide', {})
  assert.equal(beacons.length, 2)
  assert.equal(beacons[0], 'http://localhost:3000/ingest/v1/public-key/store')
})

test('ignore_errors and deny_urls drop matching errors', async () => {
  const browser = fake_browser()
  const client = create_bugfree({
    dsn: 'http://public-key@localhost:3000/ingest',
    resolve_source_maps: false,
    ignore_errors: ['ResizeObserver loop', /^AbortError:/],
    deny_urls: [/^chrome-extension:\/\//, 'https://widget.example.com/'],
  })
  client.install(fake_app())

  await client.capture_exception(new Error('ResizeObserver loop completed with undelivered notifications'))
  const aborted = new Error('The user aborted a request.')
  aborted.name = 'AbortError'
  await client.capture_exception(aborted)
  await client.capture_message('ResizeObserver loop limit exceeded')

  const from_extension = new Error('extension blew up')
  from_extension.stack = 'Error: extension blew up\n    at run (chrome-extension://abcdef/content.js:1:10)'
  await client.capture_exception(from_extension)
  browser.emit('error', { message: 'Script error.', filename: 'https://widget.example.com/embed.js' })

  await client.capture_exception(new Error('a real one'))
  await client.flush()

  assert.deepEqual(
    browser.sent.map((sent) => sent.body.message),
    ['a real one'],
  )
})

test('events carry the browser context next to their own extra', async () => {
  const browser = fake_browser()
  globalThis.window.innerWidth = 390
  globalThis.window.innerHeight = 844
  navigator.language = 'tr-TR'
  navigator.onLine = false

  const client = new_client()
  client.install(fake_app())
  await client.capture_exception(new Error('layout broke'), { extra: { step: 'checkout' } })

  const { extra } = browser.sent[0].body
  assert.equal(extra.step, 'checkout')
  assert.equal(extra.browser.viewport, '390x844')
  assert.equal(extra.browser.language, 'tr-TR')
  assert.equal(extra.browser.online, false)
})

test('capture_feedback ties the message to the latest event', async () => {
  const browser = fake_browser()
  const client = new_client()
  client.install(fake_app())

  const event_id = await client.capture_exception(new Error('checkout froze'))
  const sent = await client.capture_feedback({ message: 'I clicked pay twice', email: 'jane@example.com' })

  assert.equal(sent, true)
  const feedback = browser.sent.find((request) => request.url.endsWith('/feedback'))
  assert.equal(feedback.url, 'http://localhost:3000/ingest/v1/public-key/feedback')
  assert.equal(feedback.body.event_id, event_id)
  assert.equal(feedback.body.message, 'I clicked pay twice')
  assert.equal(feedback.body.release, 'bugfree-web@test')

  assert.equal(await client.capture_feedback({ message: '   ' }), false)
})

test('a page load is one session; an unhandled error crashes it once', async () => {
  const browser = fake_browser()
  const client = new_client()
  client.install(fake_app())

  client.set_user({ id: 42, email: 'jane@example.com' })
  await client.capture_exception(new Error('handled one'))
  browser.emit('error', { error: new Error('unhandled one') })
  browser.emit('error', { error: new Error('unhandled two') })
  await client.flush()

  const counts = browser.sessions.map(({ total, errored, crashed }) => [total, errored, crashed])
  assert.deepEqual(counts, [
    [1, 0, 0], // the page load
    [0, 0, 0], // the user becomes known
    [0, 1, 0], // a captured error
    [0, 0, 1], // the first unhandled error; the session was already errored
  ])
  assert.equal(browser.sessions[0].release, 'bugfree-web@test')
  assert.equal(browser.sessions[0].did, '')
  assert.equal(browser.sessions[3].did, '42')
})

test('sessions stay off without a release or when turned off', async () => {
  const browser = fake_browser()
  create_bugfree({ dsn: 'http://public-key@localhost:3000/ingest', resolve_source_maps: false }).install(fake_app())
  create_bugfree({ dsn: 'http://public-key@localhost:3000/ingest', release: 'web@1', track_sessions: false }).install(fake_app())
  assert.equal(browser.sessions.length, 0)
})
