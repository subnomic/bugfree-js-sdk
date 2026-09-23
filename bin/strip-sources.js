#!/usr/bin/env node
/**
 * Removes the source code from source maps before they are uploaded.
 *
 * A map carries the complete original source in sourcesContent. Without it the
 * server still turns a bundled frame into the original file, line and function
 * name; only the lines around the failing one are not shown, so no code leaves
 * the build.
 *
 * Usage: bugfree-strip-sources <file or folder>...
 *
 * Every .map file named, or found under a folder named, is rewritten in place.
 */
import { realpathSync } from 'node:fs'
import { readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Removes sourcesContent from a decoded map, and from each section of an index map. */
export function strip_map(map) {
  if (!map || typeof map !== 'object') return map
  delete map.sourcesContent
  if (Array.isArray(map.sections)) {
    for (const section of map.sections) strip_map(section?.map)
  }
  return map
}

/** Lists the .map files under the given files and folders. */
async function map_files(paths) {
  const found = []
  for (const path of paths) {
    const info = await stat(path)
    if (info.isDirectory()) {
      const entries = await readdir(path, { recursive: true, withFileTypes: true })
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.map')) found.push(join(entry.parentPath ?? entry.path, entry.name))
      }
    } else if (path.endsWith('.map')) {
      found.push(path)
    }
  }
  return found
}

/**
 * Strips every map under paths in place. Returns the files stripped and the ones
 * that could not be read as a source map.
 */
export async function strip_sources(paths) {
  const stripped = []
  const failed = []
  for (const file of await map_files(paths)) {
    try {
      const map = JSON.parse(await readFile(file, 'utf8'))
      await writeFile(file, JSON.stringify(strip_map(map)))
      stripped.push(file)
    } catch (error) {
      failed.push({ file, error: error.message })
    }
  }
  return { stripped, failed }
}

async function main(paths) {
  if (paths.length === 0) {
    console.error('Usage: bugfree-strip-sources <file or folder>...')
    process.exit(2)
  }
  const { stripped, failed } = await strip_sources(paths)
  for (const { file, error } of failed) console.error(`${file}: ${error}`)
  console.log(`Removed the source code from ${stripped.length} source map${stripped.length === 1 ? '' : 's'}.`)
  // A map left with its source would be uploaded as it is.
  if (failed.length > 0) process.exit(1)
}

// Run as a command, not imported. npx starts it through a link in node_modules/.bin,
// so the link is resolved before the comparison.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
