import assert from 'node:assert/strict'
import { test } from 'node:test'

import {
  clean_source_path,
  decode_mappings,
  original_position_for,
  slice_context,
} from '../src/source-map.js'

/**
 * A real source map sample.
 *
 * The generated file is one line; there are two mappings:
 *   column 0  -> source 0, line 0, column 0
 *   column 10 -> source 0, line 2, column 4
 *
 * VLQ: "AAAA" = [0,0,0,0]; "UAEI" = [10,0,2,4]
 */
const mappings = 'AAAA,UAEI'

test('decode_mappings decodes VLQ segments incrementally', () => {
  const decoded = decode_mappings(mappings)

  assert.equal(decoded.length, 1, 'one generated line expected')
  assert.equal(decoded[0].length, 2, 'two segments expected')

  assert.deepEqual(decoded[0][0], {
    generated_column: 0,
    source_index: 0,
    source_line: 0,
    source_column: 0,
  })
  assert.deepEqual(decoded[0][1], {
    generated_column: 10,
    source_index: 0,
    source_line: 2,
    source_column: 4,
  })
})

test('decode_mappings preserves empty lines', () => {
  const decoded = decode_mappings('AAAA;;AACA')
  assert.equal(decoded.length, 3)
  assert.equal(decoded[1].length, 0, 'the middle line has no mapping')
})

test('original_position_for picks the largest mapping below the column', () => {
  const decoded = decode_mappings(mappings)

  // Column 12 has to land on the mapping at 10 (there is no exact match).
  const position = original_position_for(decoded, 1, 12)
  assert.equal(position.line, 3, 'source maps count from 0; the result has to count from 1')
  assert.equal(position.column, 4)
  assert.equal(position.source_index, 0)
})

test('original_position_for returns the first mapping below the first column', () => {
  const decoded = decode_mappings('UAEI') // the first mapping is at column 10
  const position = original_position_for(decoded, 1, 2)
  assert.equal(position.line, 3)
})

test('original_position_for returns null for a missing line', () => {
  const decoded = decode_mappings(mappings)
  assert.equal(original_position_for(decoded, 9, 0), null)
})

test('slice_context centers the failing line and keeps the numbers', () => {
  const lines = ['a', 'b', 'c', 'd', 'e', 'f']
  const context = slice_context(lines, 3, 2)

  assert.equal(context.length, 5)
  assert.deepEqual(context[0], { line: 1, source: 'a' })
  assert.deepEqual(context[2], { line: 3, source: 'c' })
  assert.deepEqual(context[4], { line: 5, source: 'e' })
})

test('slice_context stays inside the file bounds', () => {
  const lines = ['a', 'b']
  assert.equal(slice_context(lines, 1, 5).length, 2)
  assert.deepEqual(slice_context(lines, 0, 2), [])
  assert.deepEqual(slice_context(lines, 99, 2), [])
})

test('clean_source_path strips the bundler prefixes', () => {
  assert.equal(clean_source_path('../../src/pages/login-page.vue'), 'src/pages/login-page.vue')
  assert.equal(clean_source_path('./src/main.js'), 'src/main.js')
  assert.equal(clean_source_path('src/app.vue'), 'src/app.vue')
})

// The build directory must not bleed into the path: the same file has to give the
// same path in every environment, or the fingerprint changes and one error splits
test('clean_source_path drops the build directory', () => {
  assert.equal(
    clean_source_path('../../repo/frontend/src/router/index.js'),
    'src/router/index.js',
  )
  assert.equal(
    clean_source_path('/builds/ci/app/src/pages/issue-detail-page.vue'),
    'src/pages/issue-detail-page.vue',
  )
  // Without the root, the path stays as it is.
  assert.equal(clean_source_path('vendor/lib/index.js'), 'vendor/lib/index.js')
  // A node_modules path is preserved (the in_app decision looks at it).
  assert.equal(
    clean_source_path('../../node_modules/vue/dist/runtime-core.js'),
    'node_modules/vue/dist/runtime-core.js',
  )
})
