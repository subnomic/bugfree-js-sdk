import assert from 'node:assert/strict'
import { test } from 'node:test'

import { resolve_frame } from '../src/source-map.js'

/**
 * End-to-end verification of turning a bundled frame back into original source.
 *
 * The map points at line 4 of "src/pages/cart-page.vue" and carries the source
 * itself in sourcesContent. That way the interface answers "what is on which
 * line" from the original file rather than from the bundle.
 */
const source = [
  '<script setup>',
  'import { use_cart } from "@/stores/cart"',
  'const cart = use_cart()',
  'const total = cart.items.reduce((sum, item) => sum + item.price, 0)',
  '</script>',
].join('\n')

const base64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** A VLQ encoder for the fixture; hand-written strings are far too error-prone. */
function encode_vlq(value) {
  let encoded = ''
  let rest = value < 0 ? (-value << 1) | 1 : value << 1

  do {
    let digit = rest & 31
    rest >>>= 5
    if (rest > 0) digit |= 32
    encoded += base64[digit]
  } while (rest > 0)

  return encoded
}

const encode_segment = (values) => values.map(encode_vlq).join('')

// Two mappings on a single generated line:
//   column 0   -> source 0, line 0, column 0
//   column 100 -> source 0, line 3 (0-based) => original line 4, column 14
const mappings = [
  encode_segment([0, 0, 0, 0]),
  encode_segment([100, 0, 3, 14]),
].join(',')

const map = {
  version: 3,
  file: 'index-abc.js',
  sources: ['../../src/pages/cart-page.vue'],
  sourcesContent: [source],
  names: ['total'],
  mappings,
}

/**
 * Serves the given URLs and records what was requested.
 *
 * A frame is resolved in two steps -- the script first, then its map -- so a
 * fake that answers every URL the same way would hide which one was used.
 */
function fake_fetch(routes) {
  const original = globalThis.fetch
  const requested = []

  globalThis.fetch = async (url) => {
    requested.push(url)
    const route = routes[url]
    if (!route) return { ok: false, status: 404 }
    return {
      ok: true,
      status: 200,
      text: async () => route.text ?? '',
      json: async () => route.json ?? JSON.parse(route.text),
    }
  }

  return { requested, restore: () => { globalThis.fetch = original } }
}

test('resolve_frame turns a bundled frame into original source', async () => {
  const fetching = fake_fetch({
    'http://localhost:3000/assets/index-xyz.js': { text: 'console.log(1)\n' },
    'http://localhost:3000/assets/index-xyz.js.map': { json: map },
  })

  const resolved = await resolve_frame(
    {
      function: 'e',
      file: 'http://localhost:3000/assets/index-xyz.js',
      line: 1,
      column: 105,
      in_app: true,
    },
    2,
  )
  fetching.restore()

  assert.deepEqual(fetching.requested, [
    'http://localhost:3000/assets/index-xyz.js',
    'http://localhost:3000/assets/index-xyz.js.map',
  ])

  assert.ok(resolved, 'the frame was not resolved')
  assert.equal(resolved.file, 'src/pages/cart-page.vue', 'original file name')
  assert.equal(resolved.line, 4, 'original line (1-based)')
  assert.equal(resolved.in_app, true)

  // The point of all this: the source of the failing line.
  const error_line = resolved.context.find((row) => row.line === 4)
  assert.ok(error_line, 'the failing line is missing from the context')
  assert.equal(error_line.source, 'const total = cart.items.reduce((sum, item) => sum + item.price, 0)')

  // The surrounding lines have to come too.
  assert.equal(resolved.context.length, 4, `context line count: ${resolved.context.length}`)
  assert.equal(resolved.context[0].line, 2)
})

/**
 * The Vite dev server inlines the map into the module as a `data:` URL and
 * publishes no `<file>.map`. Looking only for the separate file meant no source
 * code at all showed up during development -- the frames had a file and a line
 * and nothing else.
 */
test('resolve_frame reads a source map inlined as a data URL', async () => {
  const inline = `data:application/json;base64,${Buffer.from(JSON.stringify(map)).toString('base64')}`
  const fetching = fake_fetch({
    'http://localhost:8080/src/pages/cart-page.vue': {
      text: `const total = 1\n//# sourceMappingURL=${inline}\n`,
    },
  })

  const resolved = await resolve_frame(
    { function: 'setup', file: 'http://localhost:8080/src/pages/cart-page.vue', line: 1, column: 105 },
    2,
  )
  fetching.restore()

  // The map came from the module itself: no second request.
  assert.equal(fetching.requested.length, 1)
  assert.equal(resolved.file, 'src/pages/cart-page.vue')
  assert.equal(resolved.line, 4)
  assert.equal(resolved.context.find((row) => row.line === 4).source.includes('cart.items'), true)
})

test('resolve_frame reads a percent-encoded inline map', async () => {
  const inline = `data:application/json;charset=utf-8,${encodeURIComponent(JSON.stringify(map))}`
  const fetching = fake_fetch({
    'http://localhost:8080/src/pages/other-page.vue': {
      text: `const total = 1\n//# sourceMappingURL=${inline}\n`,
    },
  })

  const resolved = await resolve_frame(
    { function: 'setup', file: 'http://localhost:8080/src/pages/other-page.vue', line: 1, column: 105 },
    1,
  )
  fetching.restore()
  assert.equal(resolved.line, 4)
})

test('resolve_frame follows a relative sourceMappingURL', async () => {
  const fetching = fake_fetch({
    'http://localhost:3000/assets/app.js': {
      text: 'console.log(1)\n//# sourceMappingURL=app.js.map\n',
    },
    'http://localhost:3000/assets/app.js.map': { json: map },
  })

  const resolved = await resolve_frame(
    { function: 'e', file: 'http://localhost:3000/assets/app.js', line: 1, column: 105 },
    1,
  )
  fetching.restore()

  assert.equal(fetching.requested[1], 'http://localhost:3000/assets/app.js.map')
  assert.equal(resolved.line, 4)
})

/**
 * Without a usable map, the code that actually ran is still worth more than an
 * empty panel: the frame keeps its own file and line and only gains context.
 */
test('without a map the context comes from the script itself', async () => {
  const fetching = fake_fetch({
    'http://localhost:3000/assets/no-map.js': {
      text: ['first();', 'const cart = undefined', 'cart.items.length', 'last();'].join('\n'),
    },
  })

  const resolved = await resolve_frame(
    { function: 'e', file: 'http://localhost:3000/assets/no-map.js', line: 3, column: 10 },
    1,
  )
  fetching.restore()

  assert.ok(resolved, 'a frame without a map produced nothing')
  assert.equal(resolved.file, undefined, 'the file must not be overwritten')
  assert.equal(resolved.context.length, 3)
  assert.equal(resolved.context.find((row) => row.line === 3).source, 'cart.items.length')
})

test('with neither script nor map the frame stays as it is', async () => {
  const fetching = fake_fetch({})

  const resolved = await resolve_frame({
    function: 'e',
    file: 'http://localhost:3000/assets/missing.js',
    line: 1,
    column: 10,
  })
  fetching.restore()
  assert.equal(resolved, null, 'it has to return null when nothing can be fetched')
})

test('a failing fetch does not propagate', async () => {
  const original_fetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error('offline')
  }

  const resolved = await resolve_frame({
    function: 'e',
    file: 'http://localhost:3000/assets/offline.js',
    line: 1,
    column: 1,
  })

  globalThis.fetch = original_fetch
  assert.equal(resolved, null)
})

test('a node_modules source does not count as application code', async () => {
  const fetching = fake_fetch({
    'http://localhost:3000/assets/vendor-1.js': { text: 'x()\n' },
    'http://localhost:3000/assets/vendor-1.js.map': {
      json: {
        version: 3,
        sources: ['../../node_modules/vue/dist/runtime-core.esm-bundler.js'],
        sourcesContent: ['export function callWithErrorHandling() {}'],
        names: [],
        mappings: 'AAAA',
      },
    },
  })

  const resolved = await resolve_frame({
    function: 'x',
    file: 'http://localhost:3000/assets/vendor-1.js',
    line: 1,
    column: 0,
  })
  fetching.restore()
  assert.equal(resolved.in_app, false)
})

/**
 * A minified bundle is one line of a hundred kilobytes. Attaching it as context
 * would push the event past the ingest body limit and lose the error entirely.
 */
test('a minified line is not attached as context', async () => {
  const fetching = fake_fetch({
    'http://localhost:3000/assets/minified.js': { text: `x=1;${'y'.repeat(200000)}` },
  })

  const resolved = await resolve_frame(
    { function: 'e', file: 'http://localhost:3000/assets/minified.js', line: 1, column: 5 },
    2,
  )
  fetching.restore()
  assert.equal(resolved, null, 'a minified line must not become context')
})

test('a long source line is clipped', async () => {
  const fetching = fake_fetch({
    'http://localhost:3000/assets/long.js': {
      text: ['short();', 'const message = "' + 'a'.repeat(900) + '"', 'more();'].join('\n'),
    },
  })

  const resolved = await resolve_frame(
    { function: 'e', file: 'http://localhost:3000/assets/long.js', line: 2, column: 1 },
    1,
  )
  fetching.restore()

  const line = resolved.context.find((row) => row.line === 2)
  assert.ok(line.source.length <= 301, `line length: ${line.source.length}`)
  assert.equal(line.source.endsWith('…'), true, 'the clip has to be visible')
})

/**
 * A bundle that includes the SDK carries the text "sourceMappingURL=" as a
 * string literal in its own code. Matching that would send the resolver after a
 * bogus URL, so the annotation is only accepted in comment form and only from
 * the tail of the file.
 */
test('a sourceMappingURL inside the code is not treated as an annotation', async () => {
  const code = [
    "const marker = 'sourceMappingURL=' + name",
    'function scan(text) { return text.indexOf(marker) }',
    'const failing = undefined.items',
  ].join('\n')

  const fetching = fake_fetch({
    'http://localhost:3000/assets/self.js': { text: code },
  })

  const resolved = await resolve_frame(
    { function: 'scan', file: 'http://localhost:3000/assets/self.js', line: 3, column: 1 },
    1,
  )
  fetching.restore()

  // Only the file and its .map were asked for; no bogus URL in between.
  assert.deepEqual(fetching.requested, [
    'http://localhost:3000/assets/self.js',
    'http://localhost:3000/assets/self.js.map',
  ])
  assert.equal(resolved.context.find((row) => row.line === 3).source, 'const failing = undefined.items')
})

test('an annotation far from the tail of a large file is ignored', async () => {
  const code = `//# sourceMappingURL=stale.js.map\n${'x'.repeat(5000)}\nconst boom = 1\n`
  const fetching = fake_fetch({ 'http://localhost:3000/assets/big.js': { text: code } })

  await resolve_frame({ function: 'f', file: 'http://localhost:3000/assets/big.js', line: 3, column: 1 }, 1)
  fetching.restore()

  assert.equal(fetching.requested[1], 'http://localhost:3000/assets/big.js.map')
})
