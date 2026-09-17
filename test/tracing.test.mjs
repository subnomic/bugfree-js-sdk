import assert from 'node:assert/strict'
import { mock, test } from 'node:test'

import { create_tracer, is_propagation_target, trace_sampled } from '../src/tracing.js'
import { create_breadcrumbs } from '../src/breadcrumbs.js'

test('trace_sampled decides by the trace id', () => {
  assert.equal(trace_sampled('00000001aaaaaaaaaaaaaaaaaaaaaaaa', 0.01), true)
  assert.equal(trace_sampled('ffffffffaaaaaaaaaaaaaaaaaaaaaaaa', 0.99), false)
  assert.equal(trace_sampled('ffffffffaaaaaaaaaaaaaaaaaaaaaaaa', 1), true)
  assert.equal(trace_sampled('00000001aaaaaaaaaaaaaaaaaaaaaaaa', 0), false)
})

test('the trace header only goes to the page own origin and the listed targets', () => {
  globalThis.location = { origin: 'https://app.example.com', pathname: '/' }
  assert.equal(is_propagation_target('/api/v1/orders'), true)
  assert.equal(is_propagation_target('https://app.example.com/api'), true)
  assert.equal(is_propagation_target('//cdn.example.com/x.js'), false)
  assert.equal(is_propagation_target('https://api.stripe.com/v1'), false)
  assert.equal(is_propagation_target('https://api.example.com/v2', ['https://api.example.com']), true)
  assert.equal(is_propagation_target('https://eu.api.example.com/v2', [/\.api\.example\.com/]), true)
})

test('a navigation ends once its requests are done and the page is idle', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const sent = []
    const tracer = create_tracer({ sample_rate: 1, send: (transaction) => sent.push(transaction) })
    const navigation = tracer.start_navigation('/orders/:id')

    const request = tracer.on_request('GET', '/api/v1/orders/7')
    assert.match(request.headers.traceparent, new RegExp(`^00-${navigation.trace_id}-[0-9a-f]{16}-01$`))

    mock.timers.tick(5000)
    assert.equal(sent.length, 0, 'a request in flight keeps the transaction open')

    request.finish(503)
    mock.timers.tick(1000)
    assert.equal(sent.length, 1)
    const [transaction] = sent
    assert.equal(transaction.name, '/orders/:id')
    assert.equal(transaction.op, 'navigation')
    assert.equal(transaction.spans.length, 1)
    assert.equal(transaction.spans[0].op, 'http.client')
    assert.equal(transaction.spans[0].status, 'http_error')
    assert.equal(transaction.spans[0].parent_span_id, transaction.span_id)
  } finally {
    mock.timers.reset()
  }
})

test('a new navigation ends the previous one, and tracing off does nothing', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const sent = []
    const tracer = create_tracer({ sample_rate: 1, send: (transaction) => sent.push(transaction) })
    tracer.start_navigation('/a')
    tracer.start_navigation('/b')
    assert.deepEqual(sent.map((transaction) => transaction.name), ['/a'])

    const off = create_tracer({ sample_rate: 0, send: () => assert.fail('nothing is sent') })
    assert.equal(off.start_navigation('/c'), null)
    assert.equal(off.on_request('GET', '/x'), null)
  } finally {
    mock.timers.reset()
  }
})

test('start_transaction times an action with the requests made meanwhile', async () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const sent = []
    const tracer = create_tracer({ sample_rate: 1, send: (transaction) => sent.push(transaction) })
    const action = tracer.start('save settings', 'ui.action')
    tracer.on_request('PATCH', '/api/v1/settings').finish(200)
    mock.timers.tick(1000)
    assert.equal(sent.length, 1)
    assert.equal(sent[0].trace_id, action.trace_id)
    assert.equal(sent[0].op, 'ui.action')
  } finally {
    mock.timers.reset()
  }
})

test('sampled transactions notify their start and end, unsampled ones do not', () => {
  mock.timers.enable({ apis: ['setTimeout'] })
  try {
    const events = []
    const tracer = create_tracer({
      sample_rate: 1,
      send: () => {},
      on_start: (transaction) => events.push(['start', transaction.name]),
      on_finish: (transaction) => events.push(['finish', transaction.name]),
    })
    tracer.start('first', 'ui.action')
    tracer.start('second', 'ui.action')
    mock.timers.tick(1000)
    assert.deepEqual(events, [['start', 'first'], ['finish', 'first'], ['start', 'second'], ['finish', 'second']])
  } finally {
    mock.timers.reset()
  }
})

test('the fetch hook adds the trace header and ends the span', async () => {
  const seen = []
  globalThis.location = { origin: 'https://app.example.com', pathname: '/' }
  globalThis.window = {
    fetch: async (url, init) => {
      seen.push(init?.headers?.get?.('traceparent'))
      return { status: 200 }
    },
  }
  const finished = []
  const crumbs = create_breadcrumbs(5, {
    on_request: () => ({ headers: { traceparent: '00-abc-def-01' }, finish: (status) => finished.push(status) }),
  })
  crumbs.install_fetch_hook()
  await globalThis.window.fetch('/api/v1/issues', { method: 'GET', headers: { accept: 'application/json' } })

  assert.deepEqual(seen, ['00-abc-def-01'])
  assert.deepEqual(finished, [200])
})
