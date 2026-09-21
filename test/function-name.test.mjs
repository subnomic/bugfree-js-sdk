import assert from 'node:assert/strict'
import { test } from 'node:test'

import { function_at } from '../src/function-name.js'

// The same fixture and cases as backend/internal/sourcemap/function-name_test.go:
// the server and the SDK have to name a frame the same way.
const component = `<template>
  <button @click="capture_with_cause">{{ $t('debug.cause_chain') }}</button>
</template>

<script setup>
const explode = computed(() => {
  if (!explode.value) return ''
  const cart = undefined
  return cart.items.length
})

/** An error created with a cause. */
function capture_with_cause() {
  mark(t('debug.cause_chain'))
  const middle = new Error('the order could not be loaded', { cause: root })
  if (middle) {
    bugfree.value?.capture_exception(new Error('deliberate "}" failure', { cause: middle }))
  }
}

const load = async (id) => {
  const items = rows.map((row) => {
    return row.id // a "{" in a comment
  })
  return items
}

class Cart {
  static async total(items,
    currency) {
    return items.reduce((sum, item) => sum + item.price, 0)
  }
}

const handlers = {
  save: function () {
    persist()
  },
}

setup()
</script>`

function position(needle) {
  const lines = component.split('\n')
  const index = lines.findIndex((text) => text.includes(needle))
  assert.ok(index >= 0, `${needle} is not in the fixture`)
  return [index + 1, lines[index].indexOf(needle)]
}

const cases = [
  ['named function, through an if block and braces in quotes', 'capture_exception(new Error', 'capture_with_cause', true],
  ['function declaration line itself', "mark(t('debug.cause_chain'))", 'capture_with_cause', true],
  ['assigned arrow function', 'return items', 'load', true],
  ['anonymous callback has no name of its own', 'return row.id', '', true],
  ['class method with parameters over two lines', 'items.reduce', 'total', true],
  ['object property function', 'persist()', 'save', true],
  ['arrow passed to a call', 'cart.items.length', '', true],
  ['top-level code', 'setup()', '', false],
]

for (const [name, needle, expected, found] of cases) {
  test(`function_at: ${name}`, () => {
    const [line, column] = position(needle)
    assert.deepEqual(function_at(component, line, column), { found, name: expected })
  })
}

test('function_at: a line out of range resolves to nothing', () => {
  assert.equal(function_at(component, 0, 0).found, false)
  assert.equal(function_at(component, 10_000, 0).found, false)
})
