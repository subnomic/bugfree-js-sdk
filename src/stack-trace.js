/**
 * Parses browser stack traces.
 *
 * The format differs per browser; all three are supported:
 *   Chrome/Edge : "    at fn (http://host/file.js:12:34)"
 *   Firefox     : "fn@http://host/file.js:12:34"
 *   Safari      : "fn@http://host/file.js:12:34" (sometimes "global code@...")
 */

const chrome_pattern = /^\s*at\s+(?:(.+?)\s+\()?(.+?):(\d+):(\d+)\)?$/
const firefox_pattern = /^\s*(.*?)@(.+?):(\d+):(\d+)$/

/** Turns the stack text into a list of frames. */
export function parse_stack(stack, limit = 30) {
  if (!stack || typeof stack !== 'string') return []

  const frames = []
  for (const raw of stack.split('\n')) {
    const line = raw.trim()
    if (!line || line === 'Error' || line.startsWith('Error:')) continue

    const frame = parse_line(line)
    if (frame) frames.push(frame)
    if (frames.length >= limit) break
  }
  return frames
}

/** Turns a single line into a frame; returns null when unrecognized. */
export function parse_line(line) {
  const chrome = chrome_pattern.exec(line)
  if (chrome) {
    return make_frame(chrome[1], chrome[2], chrome[3], chrome[4])
  }

  const firefox = firefox_pattern.exec(line)
  if (firefox) {
    return make_frame(firefox[1], firefox[2], firefox[3], firefox[4])
  }
  return null
}

function make_frame(fn, file, line, column) {
  // Wrappers such as "eval" and "async" can bleed into the file name.
  const cleaned_file = String(file).replace(/^async\s+/, '').replace(/\)$/, '')

  return {
    function: normalize_function(fn),
    file: cleaned_file,
    line: Number(line) || 0,
    column: Number(column) || 0,
    in_app: is_in_app(cleaned_file),
  }
}

/** Simplifies the function name. */
export function normalize_function(fn) {
  if (!fn) return '<anonymous>'
  return String(fn)
    .replace(/^Object\./, '')
    .replace(/^async\s+/, '')
    .trim()
}

/**
 * Decides whether the frame belongs to the application.
 * Bundler output and dynamic code are application code; dependencies are not.
 */
export function is_in_app(file) {
  if (!file) return false
  return !file.includes('/node_modules/') && !file.startsWith('chrome-extension://')
}
