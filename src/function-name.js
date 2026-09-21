/**
 * Names the function that encloses a position of the original source.
 *
 * The name a source map carries for a position is the identifier of the token
 * there -- the "Error" of new Error, the method being called -- not the function
 * the code sits in. Taken as the frame's function, it put the name of whatever
 * was called on the failing line, and without one the frame kept the minified
 * name ("ye"), which means nothing to anyone.
 *
 * The same scan runs on the server (backend/internal/sourcemap/function-name.go)
 * for maps that are uploaded rather than published; the two have to agree.
 */

// How far above the failing line the enclosing function is looked for.
const MAX_SCAN_LINES = 400

const identifier = '[A-Za-z_$][\\w$]*'

// function name(...)
const named_function = new RegExp(`(?:^|[^\\w$.])function\\s*\\*?\\s*(${identifier})\\s*\\([^{}]*\\)\\s*(?::[^{}=;]*)?$`)
// name = function (...) / name: async function (...)
const assigned_function = new RegExp(`(${identifier})\\s*[:=]\\s*(?:async\\s+)?function\\b[^{}]*$`)
// name = (...) => / name = async value =>
const assigned_arrow = new RegExp(
  `(${identifier})\\s*[:=]\\s*(?:async\\s+)?(?:\\([^{}]*\\)|${identifier})\\s*(?::[^{}=;]*)?=>\\s*$`,
)
// name(...) { in a class or an object literal
const method = new RegExp(
  `^\\s*(?:(?:static|async|get|set|public|private|protected|override)\\s+)*\\*?\\s*(${identifier})\\s*\\([^{}]*\\)\\s*(?::[^{}=;]*)?$`,
)
// function (...) / (...) => without a name of their own
const anonymous_function = /(?:(?:^|[^\w$.])function\s*\*?\s*\([^{}]*\)|=>)\s*(?::[^{}=;]*)?$/

const quoted = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g

// Words the method pattern would otherwise read as a method name.
const block_keywords = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'function', 'return', 'else'])

/**
 * The source is scanned upwards from the position, counting braces, to the block
 * that opens around it; blocks that are not functions (if, for, object literals)
 * are stepped out of. Braces inside quotes and line comments are ignored.
 *
 * Returns { found, name }: found is false when no function encloses the
 * position, and a function without a name of its own has an empty name.
 * line is 1-based, column 0-based.
 */
export function function_at(content, line, column) {
  const lines = String(content).split('\n')
  if (line <= 0 || line > lines.length) return { found: false, name: '' }

  let depth = 0
  const stop = Math.max(0, line - MAX_SCAN_LINES)
  for (let index = line - 1; index >= stop; index--) {
    let text = lines[index]
    // Only what precedes the failing position can open a block around it.
    if (index === line - 1 && column >= 0 && column < text.length) text = text.slice(0, column)
    text = code_only(text)

    for (let position = text.length - 1; position >= 0; position--) {
      const character = text[position]
      if (character === '}') {
        depth++
      } else if (character === '{') {
        if (depth > 0) {
          depth--
          continue
        }
        const declared = function_header(header(lines, index, text.slice(0, position)))
        if (declared) return { found: true, name: declared.name }
      }
    }
  }
  return { found: false, name: '' }
}

/**
 * The text before an opening brace, with the lines above it joined on while its
 * parentheses are still open: a parameter list can span lines.
 */
function header(lines, index, before) {
  let text = before
  const count = (value, character) => value.split(character).length - 1
  for (let joined = 0; joined < 5 && index - joined > 0; joined++) {
    if (count(text, ')') <= count(text, '(')) break
    text = `${code_only(lines[index - joined - 1])} ${text}`
  }
  return text.trim()
}

/** Whether the text before a brace declares a function, and its name. */
function function_header(text) {
  for (const pattern of [named_function, assigned_function, assigned_arrow]) {
    const match = pattern.exec(text)
    if (match) return { name: match[1] }
  }
  const match = method.exec(text)
  if (match && !block_keywords.has(match[1])) return { name: match[1] }
  if (anonymous_function.test(text)) return { name: '' }
  return null
}

/** Blanks out quoted text and a trailing line comment, so their braces are not counted. */
function code_only(text) {
  const blanked = text.replace(quoted, (match) => ' '.repeat(match.length))
  const comment = blanked.indexOf('//')
  return comment >= 0 ? blanked.slice(0, comment) : blanked
}
