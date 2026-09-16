import assert from 'node:assert/strict'
import { test } from 'node:test'

import { create_breadcrumbs, describe_element } from '../src/breadcrumbs.js'

test('the steps are ordered newest to oldest', () => {
  const crumbs = create_breadcrumbs(10)
  crumbs.add({ category: 'navigation', message: 'first' })
  crumbs.add({ category: 'navigation', message: 'second' })

  const list = crumbs.list()
  assert.equal(list[0].message, 'second')
  assert.equal(list[1].message, 'first')
})

test('past the limit the oldest step is dropped', () => {
  const crumbs = create_breadcrumbs(3)
  for (const message of ['a', 'b', 'c', 'd', 'e']) {
    crumbs.add({ message })
  }

  const list = crumbs.list()
  assert.equal(list.length, 3)
  assert.equal(list[0].message, 'e')
  assert.equal(list[2].message, 'c')
})

test('the timestamp and the defaults are filled in', () => {
  const crumbs = create_breadcrumbs(5)
  crumbs.add({ message: 'x' })

  const [crumb] = crumbs.list()
  assert.equal(crumb.category, 'log')
  assert.equal(crumb.level, 'info')
  assert.ok(crumb.at, 'the timestamp is empty')
})

test('long text is clipped', () => {
  const crumbs = create_breadcrumbs(5)
  crumbs.add({ message: 'x'.repeat(500) })

  const [crumb] = crumbs.list()
  assert.ok(crumb.message.length <= 301, `length ${crumb.message.length}`)
})

test('the fetch hook records requests as steps', async () => {
  const calls = []
  globalThis.window = {
    fetch: async (url, init) => {
      calls.push([url, init])
      return { status: 200 }
    },
  }

  const crumbs = create_breadcrumbs(5)
  crumbs.install_fetch_hook()
  await globalThis.window.fetch('/api/v1/issues', { method: 'GET' })

  const [crumb] = crumbs.list()
  assert.equal(crumb.category, 'fetch')
  assert.equal(crumb.message, 'GET /api/v1/issues')
  assert.match(crumb.data, /^200/)
  assert.equal(calls.length, 1, 'the original fetch has to be called')

  delete globalThis.window
})

test('the fetch hook is not installed twice', () => {
  const original = async () => ({ status: 200 })
  globalThis.window = { fetch: original }

  const crumbs = create_breadcrumbs(5)
  crumbs.install_fetch_hook()
  const wrapped = globalThis.window.fetch
  crumbs.install_fetch_hook()

  assert.equal(globalThis.window.fetch, wrapped, 'the second install replaced the wrapper')
  delete globalThis.window
})

test('a failed fetch leaves an error step and re-throws', async () => {
  globalThis.window = {
    fetch: async () => {
      throw new Error('network down')
    },
  }

  const crumbs = create_breadcrumbs(5)
  crumbs.install_fetch_hook()

  await assert.rejects(() => globalThis.window.fetch('/x'), /network down/)
  const [crumb] = crumbs.list()
  assert.equal(crumb.level, 'error')
  assert.match(crumb.data, /failed/)

  delete globalThis.window
})

test('the fetch hook skips the SDK own delivery requests', async () => {
  globalThis.window = { fetch: async () => ({ status: 202 }) }

  const crumbs = create_breadcrumbs(5, { ignore_url: 'http://localhost:3000/ingest/v1/key/store' })
  crumbs.install_fetch_hook()
  await globalThis.window.fetch('http://localhost:3000/ingest/v1/key/store', { method: 'POST' })

  assert.equal(crumbs.list().length, 0)
})

test('the XHR hook records requests as steps', () => {
  class FakeXHR {
    open() {}
    send() {
      this.status = 503
      this.listeners.forEach((listener) => listener())
    }
    addEventListener(name, listener) {
      this.listeners = [...(this.listeners || []), listener]
    }
  }
  globalThis.window = { XMLHttpRequest: FakeXHR }

  const crumbs = create_breadcrumbs(5)
  crumbs.install_xhr_hook()
  const request = new FakeXHR()
  request.open('post', '/api/v1/orders')
  request.send()

  const [crumb] = crumbs.list()
  assert.equal(crumb.category, 'xhr')
  assert.equal(crumb.message, 'POST /api/v1/orders')
  assert.equal(crumb.level, 'warning')
  assert.match(crumb.data, /^503/)
})

test('describe_element keeps a selector and never the text', () => {
  const button = {
    tagName: 'BUTTON',
    id: 'save',
    className: 'bf-btn bf-btn-primary',
    textContent: 'Pay 1,250 EUR to Jane Doe',
    getAttribute: (name) => (name === 'aria-label' ? 'Save order' : null),
  }

  assert.equal(describe_element(button), 'button#save.bf-btn.bf-btn-primary[aria-label="Save order"]')
  assert.equal(describe_element(null), '')
})

test('the history hook records page changes', () => {
  globalThis.location = { pathname: '/issues', search: '' }
  globalThis.window = {
    history: {
      pushState(_state, _title, url) {
        globalThis.location = { pathname: url, search: '' }
      },
      replaceState() {},
    },
    addEventListener() {},
  }

  const crumbs = create_breadcrumbs(5)
  crumbs.install_history_hook()
  globalThis.window.history.pushState({}, '', '/issues/BF-1')

  const [crumb] = crumbs.list()
  assert.equal(crumb.category, 'navigation')
  assert.equal(crumb.message, '/issues → /issues/BF-1')
})
