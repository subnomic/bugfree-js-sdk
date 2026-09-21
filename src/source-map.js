/**
 * The source map resolver.
 *
 * Browser stack traces point at the bundled file
 * ("/assets/index-abc.js:1:24815"). What is useful to the reader is the original
 * file, line and the source on that line. This module downloads the map, decodes
 * the VLQ mappings and finds the closest one; sourcesContent then provides the
 * source code itself.
 *
 * No external library is used: the bundle stays small and the interface's strict
 * CSP rules are not in the way.
 */

import { function_at } from './function-name.js'

// The base64 alphabet; a character -> value table for the VLQ decoding.
const base64_chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const base64_values = new Map([...base64_chars].map((character, index) => [character, index]))

/**
 * Decodes a single VLQ (variable length quantity) value.
 * The result is a [value, characters consumed] pair.
 */
function decode_vlq(segment, start) {
  let result = 0
  let shift = 0
  let index = start
  let digit

  do {
    if (index >= segment.length) return [0, index - start]
    digit = base64_values.get(segment[index])
    if (digit === undefined) return [0, index - start]
    index += 1

    // The lowest bit is the continuation flag, the remaining 5 bits are data.
    result += (digit & 31) << shift
    shift += 5
  } while (digit & 32)

  // The sign lives in the lowest bit.
  const negative = result & 1
  result >>= 1
  return [negative ? -result : result, index - start]
}

/**
 * Turns the "mappings" field into per-line mappings.
 *
 * The format: lines are separated by ';' and segments by ','. Every segment
 * carries the deltas of
 * [generated_column, source_index, source_line, source_column, name_index];
 * the values are relative to the previous segment.
 */
export function decode_mappings(mappings) {
  const lines = []
  let source_index = 0
  let source_line = 0
  let source_column = 0
  let name_index = 0

  for (const raw_line of mappings.split(';')) {
    const segments = []
    let generated_column = 0

    for (const raw_segment of raw_line.split(',')) {
      if (!raw_segment) continue

      let cursor = 0
      const values = []
      while (cursor < raw_segment.length) {
        const [value, consumed] = decode_vlq(raw_segment, cursor)
        if (consumed === 0) break
        cursor += consumed
        values.push(value)
      }
      if (!values.length) continue

      generated_column += values[0]
      const segment = { generated_column }

      if (values.length >= 4) {
        source_index += values[1]
        source_line += values[2]
        source_column += values[3]
        segment.source_index = source_index
        segment.source_line = source_line
        segment.source_column = source_column
      }
      if (values.length >= 5) {
        name_index += values[4]
        segment.name_index = name_index
      }
      segments.push(segment)
    }

    // The segments may not be in column order; they are sorted for the binary search.
    segments.sort((a, b) => a.generated_column - b.generated_column)
    lines.push(segments)
  }
  return lines
}

/**
 * Turns a generated (line, column) position into the original position.
 *
 * An exact match usually does not exist; taking the largest mapping less than or
 * equal to the given column is the behaviour the source map spec prescribes.
 */
export function original_position_for(decoded, line, column) {
  const segments = decoded[line - 1]
  if (!segments || !segments.length) return null

  let low = 0
  let high = segments.length - 1
  let found = null

  while (low <= high) {
    const middle = (low + high) >> 1
    if (segments[middle].generated_column <= column) {
      found = segments[middle]
      low = middle + 1
    } else {
      high = middle - 1
    }
  }

  // With a column below the first mapping, the first mapping is the best guess.
  const segment = found || segments[0]
  if (segment.source_index === undefined) return null

  return {
    source_index: segment.source_index,
    line: segment.source_line + 1, // source maps are 0-based
    column: segment.source_column,
    name_index: segment.name_index,
  }
}

/** Caches the downloaded scripts and their decoded maps. */
const script_cache = new Map()

/** Builds the internal map shape from a raw source map document. */
function shape_map(raw) {
  if (!raw?.mappings) return null
  return {
    sources: raw.sources || [],
    sources_content: raw.sourcesContent || [],
    names: raw.names || [],
    source_root: raw.sourceRoot || '',
    decoded: decode_mappings(raw.mappings),
  }
}

/** Decodes a `data:` source map URL (base64 or percent-encoded JSON). */
function decode_inline_map(url) {
  const comma = url.indexOf(',')
  if (comma < 0) return null

  const meta = url.slice(0, comma)
  const payload = url.slice(comma + 1)
  try {
    const json = meta.includes(';base64') ? atob(payload) : decodeURIComponent(payload)
    return JSON.parse(json)
  } catch {
    return null
  }
}

/**
 * Finds the sourceMappingURL annotation of a script.
 *
 * Two things keep this from matching the wrong text. The annotation has to be in
 * the comment form the spec defines (`//# sourceMappingURL=`), and only the tail
 * of the file is scanned -- this very module contains the marker as a string, and
 * a bundle that includes the SDK would otherwise match its own source.
 */
const ANNOTATION_TAIL = 2048
const ANNOTATION = /\/\/[#@]\s*sourceMappingURL=(\S+)/g

function source_mapping_url(text) {
  const tail = text.length > ANNOTATION_TAIL ? text.slice(-ANNOTATION_TAIL) : text

  let found = ''
  for (const match of tail.matchAll(ANNOTATION)) found = match[1]
  return found.trim()
}

/**
 * Downloads a script together with its source map.
 *
 * Two shapes have to be handled, and only handling the first one meant the
 * development server produced no source code at all:
 *
 *   - production build: a separate `<file>.map` next to the asset,
 *   - Vite dev server: the map inlined into the module as a `data:` URL.
 *
 * The script text is kept as well. Without a usable map, the code that actually
 * ran is still better than showing nothing.
 */
async function load_script(file_url) {
  if (script_cache.has(file_url)) return script_cache.get(file_url)

  const promise = (async () => {
    const result = { text: '', map: null }

    try {
      const response = await fetch(file_url, { credentials: 'omit' })
      if (response.ok) result.text = await response.text()
    } catch {
      // The file could not be fetched (offline, CORS): the .map attempt below
      // may still succeed.
    }

    const annotated = result.text ? source_mapping_url(result.text) : ''
    if (annotated.startsWith('data:')) {
      result.map = shape_map(decode_inline_map(annotated))
      if (result.map) return result
    }

    // A relative annotation, or none at all: fall back to the conventional
    // "<file>.map" address.
    const map_url = annotated && !annotated.startsWith('data:')
      ? new URL(annotated, file_url).toString()
      : `${file_url}.map`

    try {
      const response = await fetch(map_url, { credentials: 'omit' })
      if (response.ok) result.map = shape_map(await response.json())
    } catch {
      // No map: the caller falls back to the script's own lines.
    }
    return result
  })()

  script_cache.set(file_url, promise)
  return promise
}

/**
 * Downloads and decodes the source map of a bundle file.
 * Returns null when there is no map (not published in production).
 */
export async function load_source_map(file_url) {
  return (await load_script(file_url)).map
}

/**
 * Turns a single frame into original source.
 *
 * On failure it returns null and the caller keeps the bundled frame as it is: a
 * missing map must not lose the error.
 */
export async function resolve_frame(frame, context_lines = 5) {
  if (!frame.file || !frame.line) return null

  const script = await load_script(frame.file)
  const map = script.map
  const position = map
    ? original_position_for(map.decoded, frame.line, frame.column || 0)
    : null

  // No map, or the line is not in it: at least attach the source of the code
  // that ran. The frame keeps its own file and line.
  if (!position) {
    if (!script.text) return null
    const lines = script.text.split('\n')
    // A minified bundle carries everything on one line; showing a clipped slice
    // of it is noise, not context.
    if ((lines[frame.line - 1] || '').length > MAX_SOURCE_LENGTH * 4) return null
    return { context: slice_context(lines, frame.line, context_lines) }
  }

  const source = map.sources[position.source_index] || ''
  const content = map.sources_content[position.source_index]

  const resolved = {
    function: frame.function,
    file: clean_source_path(map.source_root + source),
    line: position.line,
    column: position.column,
    in_app: !source.includes('node_modules'),
  }

  if (typeof content === 'string') {
    resolved.context = slice_context(content.split('\n'), position.line, context_lines)
  }

  // The function is named after the one the code sits in. Without the original
  // file, the frame that called this one can name it (resolve_frames): the token
  // at a call site is the name of the function called there. Neither field is
  // enumerable, so neither travels with the event.
  const enclosing = typeof content === 'string' ? function_at(content, position.line, position.column) : null
  if (enclosing?.found) resolved.function = enclosing.name || '<anonymous>'
  Object.defineProperty(resolved, 'named_from_source', { value: typeof content === 'string' })
  Object.defineProperty(resolved, 'call_name', {
    value: position.name_index !== undefined ? map.names[position.name_index] || '' : '',
  })
  return resolved
}

/**
 * Normalizes a source path.
 *
 * Bundler paths are relative to the build directory: locally
 * "../../src/pages/x.vue", inside a container maybe
 * "../../repo/frontend/src/pages/x.vue". The same file producing two different
 * paths hurts readability and changes the fingerprint, splitting one error into
 * two groups. So when the known project root ("src/" by default) is found, the
 * path is taken from there on.
 */
export function clean_source_path(source, root = 'src/') {
  const cleaned = String(source)
    .replace(/^(\.\.\/)+/, '')
    .replace(/^\/?@fs\//, '')
    .replace(/^\.\//, '')
    .replace(/^\//, '')

  if (!root) return cleaned

  const index = cleaned.indexOf(`/${root}`)
  return index >= 0 ? cleaned.slice(index + 1) : cleaned
}

/**
 * Extracts the window around the failing line.
 * Line numbers are 1-based; the interface matches the failing line with frame.line.
 */
export function slice_context(lines, line, around) {
  if (line <= 0 || line > lines.length) return []

  const start = Math.max(1, line - around)
  const end = Math.min(lines.length, line + around)
  const context = []

  for (let number = start; number <= end; number += 1) {
    context.push({ line: number, source: clip(lines[number - 1].replace(/\s+$/, '')) })
  }
  return context
}

/** The longest source line kept, in characters. */
const MAX_SOURCE_LENGTH = 300

/**
 * Bounds a source line.
 *
 * A minified bundle is one line of a hundred kilobytes. Sending it as "context"
 * would blow the event past the ingest body limit and take the whole error down
 * with it -- and it tells the reader nothing anyway.
 */
function clip(source) {
  return source.length > MAX_SOURCE_LENGTH ? `${source.slice(0, MAX_SOURCE_LENGTH)}…` : source
}
