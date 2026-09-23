import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

import { strip_map, strip_sources } from '../bin/strip-sources.js'

const map = {
  version: 3,
  file: 'index-abc.js',
  sources: ['../../src/pages/cart-page.vue'],
  sourcesContent: ['const total = cart.items.reduce((sum, item) => sum + item.price, 0)'],
  names: ['total'],
  mappings: 'AAAA',
}

test('strip_map removes the code and keeps what resolves a frame', () => {
  const stripped = strip_map(structuredClone(map))
  assert.equal(stripped.sourcesContent, undefined)
  assert.deepEqual(stripped.sources, map.sources)
  assert.deepEqual(stripped.names, map.names)
  assert.equal(stripped.mappings, map.mappings)

  const index = strip_map({ version: 3, sections: [{ offset: { line: 0, column: 0 }, map: structuredClone(map) }] })
  assert.equal(index.sections[0].map.sourcesContent, undefined)
})

test('strip_sources rewrites every map under a folder and reports unreadable ones', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'bugfree-strip-'))
  try {
    await mkdir(join(folder, 'assets', 'chunks'), { recursive: true })
    await writeFile(join(folder, 'assets', 'index-abc.js.map'), JSON.stringify(map))
    await writeFile(join(folder, 'assets', 'chunks', 'cart-def.js.map'), JSON.stringify(map))
    await writeFile(join(folder, 'assets', 'index-abc.js'), 'console.log(1)')
    await writeFile(join(folder, 'assets', 'broken.js.map'), 'not a map')

    const { stripped, failed } = await strip_sources([folder])
    assert.equal(stripped.length, 2)
    assert.deepEqual(failed.map(({ file }) => file), [join(folder, 'assets', 'broken.js.map')])
    for (const file of stripped) {
      const written = await readFile(file, 'utf8')
      assert.ok(!written.includes('cart.items.reduce'), `${file} still holds code`)
      assert.equal(JSON.parse(written).sources[0], '../../src/pages/cart-page.vue')
    }
    assert.equal(await readFile(join(folder, 'assets', 'index-abc.js'), 'utf8'), 'console.log(1)')
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('the command runs through the link npx starts it from', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'bugfree-strip-'))
  try {
    await writeFile(join(folder, 'app.js.map'), JSON.stringify(map))
    const link = join(folder, 'bugfree-strip-sources')
    await symlink(fileURLToPath(new URL('../bin/strip-sources.js', import.meta.url)), link)

    const output = execFileSync(process.execPath, [link, folder], { encoding: 'utf8' })
    assert.match(output, /from 1 source map\./)
    assert.equal(JSON.parse(await readFile(join(folder, 'app.js.map'), 'utf8')).sourcesContent, undefined)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})
