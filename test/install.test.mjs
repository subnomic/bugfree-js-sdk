import assert from 'node:assert/strict'
import { test } from 'node:test'

import { blocked_origin, browser_runtime, create_bugfree, error_chain } from '../src/index.js'

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

test('before_send_transaction scrubs or drops a transaction before it is sent', async () => {
  const browser = fake_browser()
  const seen = []
  const client = create_bugfree({
    dsn: 'http://public-key@localhost:3000/ingest',
    release: 'bugfree-web@test',
    resolve_source_maps: false,
    track_sessions: false,
    traces_sample_rate: 1,
    before_send_transaction(transaction) {
      seen.push(transaction.name)
      if (transaction.name === 'dropped') return null
      if (transaction.name === 'broken') throw new Error('a hook that fails')
      for (const span of transaction.spans) span.description = span.description.replace(/\?\S*/, '')
      return transaction
    },
  })
  client.install(fake_app())
  client.set_user({ id: 7 })

  // The page load install() started ends with the first action.
  const save = client.start_transaction('save settings')
  await window.fetch('/api/v1/settings?token=secret')
  save.finish()
  client.start_transaction('dropped').finish()
  // A hook that throws loses its transaction, never the caller's flow.
  assert.doesNotThrow(() => client.start_transaction('broken').finish())

  assert.deepEqual(seen, ['/debug', 'save settings', 'dropped', 'broken'])
  const transactions = browser.sent
    .filter(({ url }) => url.endsWith('/transactions'))
    .map(({ body }) => body.transactions[0])
  assert.deepEqual(
    transactions.map((transaction) => transaction.name),
    ['/debug', 'save settings'],
  )
  const [, sent] = transactions
  assert.equal(sent.spans[0].description, 'GET /api/v1/settings')
  // The hook sees the transaction as it is sent, release and user included.
  assert.equal(sent.release, 'bugfree-web@test')
  assert.equal(sent.user_id, '7')
  assert.ok(!JSON.stringify(browser.sent).includes('secret'))
})

/** The smallest DOM the replay recorder can take a snapshot of. */
function fake_document() {
  const element = (name, attributes = {}, extra = {}) => ({
    nodeType: 1,
    nodeName: name,
    attributes: Object.entries(attributes).map(([attribute, value]) => ({ name: attribute, value })),
    childNodes: [],
    ...extra,
  })
  const root = element('HTML')
  root.childNodes = [
    element('LINK', { rel: 'stylesheet' }, { href: 'http://localhost:3000/app.css?token=secret-7' }),
    element('A', { href: '/invite/secret-8' }),
    element('FORM', { action: '/reset-password/secret-9' }),
  ]
  globalThis.document = { documentElement: root, addEventListener: () => {}, removeEventListener: () => {} }
  globalThis.window.removeEventListener = () => {}
  globalThis.MutationObserver = class {
    observe() {}
    disconnect() {}
  }
}

test('scrub_url rewrites every address the SDK sends', async () => {
  const browser = fake_browser()
  globalThis.location = {
    pathname: '/reset-password/secret-1',
    search: '?token=secret-2',
    href: 'http://localhost:3000/reset-password/secret-1?token=secret-2',
    origin: 'http://localhost:3000',
  }
  fake_document()
  const scrubbed = []
  const client = create_bugfree({
    dsn: 'http://public-key@localhost:3000/ingest',
    release: 'bugfree-web@test',
    resolve_source_maps: false,
    track_sessions: false,
    traces_sample_rate: 1,
    replays_session_sample_rate: 1,
    scrub_url(url) {
      scrubbed.push(url)
      return url.replace(/secret-\d+/g, ':token')
    },
    // before_send and before_send_transaction see the addresses already rewritten.
    before_send(event) {
      assert.ok(!JSON.stringify(event).includes('secret'), 'before_send saw a raw address')
      return event
    },
    before_send_transaction(transaction) {
      assert.ok(!JSON.stringify(transaction).includes('secret'), 'before_send_transaction saw a raw address')
      return transaction
    },
  })
  const after_each = []
  client.install(fake_app(), { afterEach: (hook) => after_each.push(hook) })
  after_each.forEach((hook) => hook({ matched: [], path: '/invite/secret-3', fullPath: '/invite/secret-3' }, { fullPath: '/' }))

  const save = client.start_transaction('accept invitation')
  await window.fetch('/api/v1/invites/secret-4/accept?token=secret-5')
  save.finish()
  await client.capture_exception(new Error('the invitation could not be accepted'))
  await client.capture_feedback({ message: 'the link did not work' })
  client.stop_replay()
  await client.flush()

  const bodies = browser.sent.map(({ body }) => JSON.stringify(body)).join('\n')
  assert.ok(!bodies.includes('secret'), 'a raw address left the browser')
  const find = (suffix) => browser.sent.find(({ url }) => url.endsWith(suffix))?.body

  const event = find('/store')
  assert.equal(event.request.url, '/reset-password/:token?token=:token')
  assert.deepEqual(
    event.breadcrumbs.map((crumb) => crumb.message),
    ['GET /api/v1/invites/:token/accept?token=:token', '/ → /invite/:token'],
  )

  const [page_load, action] = browser.sent.filter(({ url }) => url.endsWith('/transactions')).map(({ body }) => body.transactions[0])
  // The router named the page load after an address, not a route pattern.
  assert.equal(page_load.name, '/invite/:token')
  assert.equal(action.spans[0].description, 'GET /api/v1/invites/:token/accept?token=:token')

  const segment = find('/segments')
  assert.equal(segment.url, 'http://localhost:3000/reset-password/:token?token=:token')
  const snapshot = segment.events.find((recorded) => recorded.type === 'snapshot')
  assert.equal(snapshot.url, 'http://localhost:3000/reset-password/:token?token=:token')
  assert.deepEqual(
    snapshot.node.children.map((child) => child.attributes.href || child.attributes.action),
    ['http://localhost:3000/app.css?token=:token', '/invite/:token', '/reset-password/:token'],
  )

  assert.equal(find('/feedback').url, 'http://localhost:3000/reset-password/:token?token=:token')
  assert.ok(scrubbed.length > 0)

  delete globalThis.document
  delete globalThis.MutationObserver
})

test('a scrub_url that fails sends [Filtered] instead of the address', async () => {
  const browser = fake_browser()
  globalThis.location = { pathname: '/invite/secret-1', search: '', href: 'http://localhost:3000/invite/secret-1', origin: 'http://localhost:3000' }
  const client = create_bugfree({
    dsn: 'http://public-key@localhost:3000/ingest',
    resolve_source_maps: false,
    scrub_url: (url) => {
      if (url.startsWith('http')) throw new Error('a hook that fails')
      return undefined
    },
  })
  client.install(fake_app())

  await client.capture_exception(new Error('boom'))
  await client.capture_feedback({ message: 'broken' })
  await client.flush()

  assert.equal(browser.sent.find(({ url }) => url.endsWith('/store')).body.request.url, '[Filtered]')
  assert.equal(browser.sent.find(({ url }) => url.endsWith('/feedback')).body.url, '[Filtered]')
  assert.ok(!JSON.stringify(browser.sent).includes('secret'))
})

/** A document that keeps its listeners, so a test can fire the page's events. */
function listening_document() {
  const listeners = {}
  globalThis.document = {
    addEventListener: (name, handler) => {
      listeners[name] = [...(listeners[name] || []), handler]
    },
    removeEventListener: () => {},
  }
  return (name, event) => (listeners[name] || []).forEach((handler) => handler(event))
}

test('a CSP violation is a breadcrumb, and an event with report_csp_violations', async () => {
  const browser = fake_browser()
  const fire = listening_document()
  const client = create_bugfree({
    dsn: 'http://public-key@localhost:3000/ingest',
    resolve_source_maps: false,
    report_csp_violations: true,
    scrub_url: (url) => url.replace(/sig=[^&]+/, 'sig=:signature'),
  })
  client.install(fake_app())

  const violation = {
    effectiveDirective: 'img-src',
    blockedURI: 'https://cdn.example.com/previews/7.png?sig=secret',
    sourceFile: 'http://localhost:3000/assets/index.js',
    lineNumber: 12,
    disposition: 'enforce',
  }
  fire('securitypolicyviolation', violation)
  // The same directive and origin again is a repeat; another image of the host too.
  fire('securitypolicyviolation', { ...violation, blockedURI: 'https://cdn.example.com/previews/8.png' })
  // A browser extension's violation is not the application's.
  fire('securitypolicyviolation', { effectiveDirective: 'style-src', blockedURI: 'chrome-extension://abc/inject.css' })
  await client.capture_exception(new Error('the preview did not load'))
  await client.flush()

  const events = browser.sent.map(({ body }) => body)
  const csp = events.filter((event) => event.type === 'CSPViolation')
  assert.equal(csp.length, 1)
  assert.equal(csp[0].level, 'warning')
  assert.equal(csp[0].message, 'img-src blocked https://cdn.example.com')
  assert.equal(csp[0].culprit, 'img-src')
  assert.equal(csp[0].extra.csp.blocked_url, 'https://cdn.example.com/previews/7.png?sig=:signature')

  const error = events.find((event) => event.type === 'Error')
  const crumbs = error.breadcrumbs.filter((crumb) => crumb.category === 'csp')
  assert.deepEqual(
    crumbs.map((crumb) => [crumb.message, crumb.data, crumb.level]),
    [
      ['img-src blocked https://cdn.example.com/previews/8.png', 'http://localhost:3000/assets/index.js:12', 'warning'],
      ['img-src blocked https://cdn.example.com/previews/7.png?sig=:signature', 'http://localhost:3000/assets/index.js:12', 'warning'],
    ],
  )
  assert.ok(!JSON.stringify(browser.sent).includes('secret'))
  delete globalThis.document
})

test('CSP violations send no event unless report_csp_violations is on', async () => {
  const browser = fake_browser()
  const fire = listening_document()
  const client = new_client()
  client.install(fake_app())

  fire('securitypolicyviolation', { violatedDirective: "connect-src 'self'", blockedURI: 'https://ingest.example.com/store' })
  await client.flush()

  assert.equal(browser.sent.length, 0)
  delete globalThis.document
})

test('blocked_origin groups what a policy blocked as the server does', () => {
  assert.equal(blocked_origin('https://cdn.example.com:8443/a.png?x=1'), 'https://cdn.example.com:8443')
  assert.equal(blocked_origin('data:image/png;base64,AAAA'), 'data')
  assert.equal(blocked_origin('blob:https://app.example.com/1234'), 'blob')
  assert.equal(blocked_origin('inline'), 'inline')
  assert.equal(blocked_origin(''), 'unknown')
})

test('set_tag with null or undefined removes the tag', async () => {
  const browser = fake_browser()
  const client = new_client()
  client.install(fake_app())

  client.set_tag('tenant_id', 't-1')
  client.set_tag('plan', 'team')
  await client.capture_message('signed in')
  client.set_tag('tenant_id', null)
  client.set_tag('plan', undefined)
  await client.capture_message('signed out')
  await client.flush()

  const [signed_in, signed_out] = browser.sent.map(({ body }) => body.tags)
  assert.equal(signed_in.tenant_id, 't-1')
  assert.equal(signed_in.plan, 'team')
  assert.ok(!('tenant_id' in signed_out) && !('plan' in signed_out), JSON.stringify(signed_out))
  assert.ok(signed_out.sdk, 'the SDK tag stays')
})

test('a transaction before_send_transaction drops sends no profile', async () => {
  const browser = fake_browser()
  const stopped = []
  window.Profiler = class {
    sampleInterval = 10
    async stop() {
      stopped.push(true)
      return { frames: [], resources: [], stacks: [], samples: [{ timestamp: 1 }] }
    }
  }
  const client = create_bugfree({
    dsn: 'http://public-key@localhost:3000/ingest',
    resolve_source_maps: false,
    track_sessions: false,
    traces_sample_rate: 1,
    profiles_sample_rate: 1,
    before_send_transaction: (transaction) => (transaction.name === 'kept' ? transaction : null),
  })
  client.install(fake_app())

  // The page load install() started ends with the first action, and is dropped.
  client.start_transaction('dropped').finish()
  client.start_transaction('kept').finish()
  await new Promise((resolve) => setTimeout(resolve, 10))

  assert.equal(stopped.length, 3, 'every profiler is stopped')
  const profiles = browser.sent.filter(({ url }) => url.endsWith('/profiles'))
  assert.equal(profiles.length, 1, 'only the kept transaction sends its profile')
  const [kept] = browser.sent.filter(({ url }) => url.endsWith('/transactions')).map(({ body }) => body.transactions[0])
  assert.equal(profiles[0].body.trace_id, kept.trace_id)
})
