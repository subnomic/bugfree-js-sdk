import assert from 'node:assert/strict'
import { test } from 'node:test'

import { create_transport, parse_retry_after } from '../src/transport.js'

const STORE_URL = 'http://localhost:3000/ingest/v1/key/store'

test('a 429 pauses sending for as long as the server asked', async () => {
  let calls = 0
  globalThis.fetch = async () => {
    calls += 1
    return { ok: false, status: 429, headers: { get: (name) => (name === 'Retry-After' ? '30' : null) } }
  }

  const transport = create_transport(STORE_URL)
  assert.equal(await transport.send({ message: 'first' }), null)

  for (let i = 0; i < 5; i += 1) await transport.send({ message: 'during the pause' })
  assert.equal(calls, 1, 'nothing is sent while paused')
})

test('events are sent one after another and resolve to the answer', async () => {
  const order = []
  globalThis.fetch = async (_url, options) => {
    order.push(JSON.parse(options.body).message)
    return { ok: true, status: 202, json: async () => ({ event_id: 'x' }) }
  }

  const transport = create_transport(STORE_URL)
  const answers = await Promise.all([transport.send({ message: 'a' }), transport.send({ message: 'b' })])

  assert.deepEqual(order, ['a', 'b'])
  assert.deepEqual(answers, [{ event_id: 'x' }, { event_id: 'x' }])
  assert.equal(await transport.flush(100), true)
})

test('parse_retry_after reads seconds and dates, and falls back to a minute', () => {
  const now = Date.parse('2026-01-01T12:00:00Z')
  assert.equal(parse_retry_after('120', now), 120_000)
  assert.equal(parse_retry_after(new Date(now + 90_000).toUTCString(), now), 90_000)
  assert.equal(parse_retry_after(null, now), 60_000)
  assert.equal(parse_retry_after('-1', now), 60_000)
  assert.equal(parse_retry_after('soon', now), 60_000)
})
