import assert from 'node:assert/strict'
import { test } from 'node:test'

import { is_in_app, normalize_function, parse_line, parse_stack } from '../src/stack-trace.js'

const chrome_stack = `TypeError: Cannot read properties of undefined (reading 'items')
    at setup (http://localhost:3000/assets/index-abc.js:1:24815)
    at callWithErrorHandling (http://localhost:3000/assets/vue-def.js:1:1204)
    at http://localhost:3000/assets/index-abc.js:1:9002`

const firefox_stack = `setup@http://localhost:3000/assets/index-abc.js:1:24815
callWithErrorHandling@http://localhost:3000/assets/vue-def.js:1:1204`

test('parse_stack parses the Chrome format', () => {
  const frames = parse_stack(chrome_stack)

  assert.equal(frames.length, 3)
  assert.deepEqual(frames[0], {
    function: 'setup',
    file: 'http://localhost:3000/assets/index-abc.js',
    line: 1,
    column: 24815,
    in_app: true,
  })
})

test('parse_stack keeps an anonymous frame', () => {
  const frames = parse_stack(chrome_stack)
  assert.equal(frames[2].function, '<anonymous>')
  assert.equal(frames[2].column, 9002)
})

test('parse_stack parses the Firefox format', () => {
  const frames = parse_stack(firefox_stack)

  assert.equal(frames.length, 2)
  assert.equal(frames[0].function, 'setup')
  assert.equal(frames[0].line, 1)
  assert.equal(frames[0].column, 24815)
})

test('parse_stack does not count the error header as a frame', () => {
  const frames = parse_stack(chrome_stack)
  for (const frame of frames) {
    assert.notEqual(frame.function, 'TypeError')
  }
})

test('parse_stack survives empty and invalid input', () => {
  assert.deepEqual(parse_stack(''), [])
  assert.deepEqual(parse_stack(undefined), [])
  assert.deepEqual(parse_stack('garbage without locations'), [])
})

test('parse_stack bounds the frame count', () => {
  const long = Array.from({ length: 100 }, (_, i) => `    at fn${i} (http://h/f.js:1:${i})`).join('\n')
  assert.equal(parse_stack(long, 10).length, 10)
})

test('parse_line returns null for an unrecognized line', () => {
  assert.equal(parse_line('this is not a frame'), null)
})

test('normalize_function strips the wrappers', () => {
  assert.equal(normalize_function('Object.handler'), 'handler')
  assert.equal(normalize_function('async load'), 'load')
  assert.equal(normalize_function(''), '<anonymous>')
  assert.equal(normalize_function(undefined), '<anonymous>')
})

test('is_in_app does not count dependencies as application code', () => {
  assert.equal(is_in_app('/assets/index.js'), true)
  assert.equal(is_in_app('http://h/node_modules/vue/dist/vue.js'), false)
  assert.equal(is_in_app('chrome-extension://abc/inject.js'), false)
  assert.equal(is_in_app(''), false)
})
