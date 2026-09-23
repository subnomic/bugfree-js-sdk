/**
 * Records what the page looked like and what the user did, so the moments before
 * an error can be watched again.
 *
 * The recording is a snapshot of the DOM followed by the changes to it (added and
 * removed nodes, attributes, text), scrolls, pointer moves and clicks, each with
 * the time it happened. The player rebuilds the page from them.
 *
 * Privacy comes first: text is masked by default and input values always are,
 * scripts are never recorded, and media sources are dropped so a replay does not
 * load the user's pictures.
 */

// Tags whose content is never recorded.
const skipped_tags = new Set(['SCRIPT', 'NOSCRIPT', 'TEMPLATE'])
// Attributes that load media; dropped so a replay shows placeholders.
const media_attributes = new Set(['src', 'srcset', 'poster'])
// Attributes holding an address, recorded after scrub_url.
const url_attributes = new Set(['href', 'action'])
// How often pointer moves are sampled (ms).
const mouse_interval = 50
// A recording that changes faster than this is paused: a page animating its whole
// DOM would otherwise build a recording nobody can store.
const max_events_per_second = 2000

/** Replaces every visible character with an asterisk. */
export function mask_text(text) {
  return text.replace(/[^\s]/g, '*')
}

/**
 * @param {{ mask_all_text?: boolean, on_event: (event: object) => void, now?: () => number }} options
 *
 * scrub_url rewrites the page's address and the links and form targets recorded.
 */
export function create_recorder({ mask_all_text = true, on_event, now = () => Date.now(), scrub_url = (url) => url }) {
  const ids = new WeakMap()
  let next_id = 1
  let observer = null
  const listeners = []
  let window_start = 0
  let window_count = 0
  let throttled = false

  function id_of(node) {
    if (!ids.has(node)) ids.set(node, next_id++)
    return ids.get(node)
  }

  function emit(event) {
    const at = now()
    if (at - window_start > 1000) {
      window_start = at
      window_count = 0
      throttled = false
    }
    window_count += 1
    if (window_count > max_events_per_second) {
      throttled = true
      return
    }
    on_event({ ...event, t: at })
  }

  function in_style(node) {
    return node.parentNode?.nodeName === 'STYLE'
  }

  /** Serializes a node and everything under it. Returns null for what is not recorded. */
  function serialize(node) {
    switch (node.nodeType) {
      case 3: {
        // Text: masked unless it is a stylesheet, whose text is no personal data.
        const text = node.textContent || ''
        return { id: id_of(node), type: 'text', text: mask_all_text && !in_style(node) ? mask_text(text) : text }
      }
      case 1: {
        if (skipped_tags.has(node.nodeName)) return null
        const attributes = {}
        for (const attribute of node.attributes || []) {
          const name = attribute.name.toLowerCase()
          if (name.startsWith('on')) continue
          if (media_attributes.has(name) && node.nodeName !== 'LINK') continue
          attributes[name] = url_attributes.has(name) ? scrub_url(attribute.value) : attribute.value
        }
        // Stylesheets are loaded by the player from their absolute address.
        if (node.nodeName === 'LINK' && node.href) attributes.href = scrub_url(node.href)
        if ('value' in node && ['INPUT', 'TEXTAREA', 'SELECT'].includes(node.nodeName)) {
          attributes.value = node.type === 'checkbox' || node.type === 'radio' ? '' : mask_text(String(node.value || ''))
          if (node.checked) attributes.checked = ''
        }
        const children = []
        for (const child of node.childNodes) {
          const serialized = serialize(child)
          if (serialized) children.push(serialized)
        }
        return { id: id_of(node), type: 'element', tag: node.nodeName.toLowerCase(), attributes, children }
      }
      default:
        return null
    }
  }

  function snapshot() {
    const root = document.documentElement
    emit({
      type: 'snapshot',
      node: serialize(root),
      width: window.innerWidth,
      height: window.innerHeight,
      scroll_x: window.scrollX || 0,
      scroll_y: window.scrollY || 0,
      url: scrub_url(location.href),
    })
  }

  function on_mutations(records) {
    for (const record of records) {
      if (record.type === 'childList') {
        for (const node of record.removedNodes) {
          if (ids.has(node)) emit({ type: 'remove', id: ids.get(node) })
        }
        for (const node of record.addedNodes) {
          if (!node.parentNode || !ids.has(node.parentNode)) continue
          const serialized = serialize(node)
          if (!serialized) continue
          const next = node.nextSibling
          emit({ type: 'add', parent: ids.get(node.parentNode), next: next && ids.has(next) ? ids.get(next) : null, node: serialized })
        }
      } else if (record.type === 'attributes' && ids.has(record.target)) {
        const name = record.attributeName.toLowerCase()
        if (name.startsWith('on') || media_attributes.has(name)) continue
        const value = record.target.getAttribute(record.attributeName)
        emit({ type: 'attribute', id: ids.get(record.target), name, value: url_attributes.has(name) && value !== null ? scrub_url(value) : value })
      } else if (record.type === 'characterData' && ids.has(record.target)) {
        const text = record.target.textContent || ''
        emit({ type: 'text', id: ids.get(record.target), text: mask_all_text && !in_style(record.target) ? mask_text(text) : text })
      }
    }
  }

  function listen(target, name, handler, options) {
    target.addEventListener(name, handler, options)
    listeners.push(() => target.removeEventListener(name, handler, options))
  }

  function start() {
    if (typeof document === 'undefined' || typeof MutationObserver === 'undefined' || observer) return false
    snapshot()
    observer = new MutationObserver(on_mutations)
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true })

    let last_move = 0
    listen(document, 'mousemove', (event) => {
      if (event.timeStamp - last_move < mouse_interval) return
      last_move = event.timeStamp
      emit({ type: 'mouse', x: event.clientX, y: event.clientY })
    }, { passive: true, capture: true })
    listen(document, 'click', (event) => emit({ type: 'click', x: event.clientX, y: event.clientY }), { capture: true })
    listen(document, 'scroll', (event) => {
      const target = event.target === document ? document.scrollingElement || document.documentElement : event.target
      if (ids.has(target)) emit({ type: 'scroll', id: ids.get(target), x: target.scrollLeft, y: target.scrollTop })
    }, { passive: true, capture: true })
    listen(document, 'input', (event) => {
      const target = event.target
      if (!ids.has(target)) return
      const checkable = target.type === 'checkbox' || target.type === 'radio'
      emit({ type: 'input', id: ids.get(target), value: checkable ? '' : mask_text(String(target.value || '')), checked: Boolean(target.checked) })
    }, { capture: true })
    listen(window, 'resize', () => emit({ type: 'viewport', width: window.innerWidth, height: window.innerHeight }), { passive: true })
    return true
  }

  function stop() {
    observer?.disconnect()
    observer = null
    while (listeners.length) listeners.pop()()
  }

  return { start, stop, snapshot, is_throttled: () => throttled }
}

/**
 * Keeps the last stretch of a recording in memory: everything since the
 * second-to-last snapshot, with a new snapshot taken every checkout_ms, so what
 * is kept always starts with a full page and never grows beyond two stretches.
 */
export function create_replay_buffer({ checkout_ms = 30_000 } = {}) {
  let previous = []
  let current = []
  let last_checkout = 0

  return {
    push(event) {
      if (event.type === 'snapshot') {
        previous = current
        current = []
        last_checkout = event.t
      }
      current.push(event)
    },
    needs_checkout(at) {
      return last_checkout > 0 && at - last_checkout >= checkout_ms
    },
    /** Hands everything kept over and starts empty. */
    take() {
      const events = [...previous, ...current]
      previous = []
      current = []
      last_checkout = 0
      return events
    },
    size: () => previous.length + current.length,
  }
}
