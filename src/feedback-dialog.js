/**
 * A small dialog that asks the user what happened.
 *
 * It needs no framework and no stylesheet: every style is set through the element's
 * style object, which a strict content security policy allows where a <style>
 * element or a style attribute would be blocked. It lives in a shadow root, so the
 * page's own CSS neither breaks it nor is touched by it.
 */

export const default_feedback_labels = {
  title: 'Something went wrong',
  subtitle: 'Tell us what you were doing. It helps us fix it.',
  name: 'Name',
  email: 'Email',
  message: 'What happened?',
  submit: 'Send',
  cancel: 'Cancel',
  sending: 'Sending…',
  success: 'Thank you. Your message was sent.',
  failure: 'The message could not be sent. Please try again.',
}

const colors = {
  overlay: 'rgba(9, 9, 11, 0.6)',
  panel: '#18181b',
  border: 'rgba(255, 255, 255, 0.1)',
  text: '#f4f4f5',
  muted: '#a1a1aa',
  input: '#09090b',
  accent: '#e11d48',
  success: '#34d399',
  error: '#fda4af',
}

function element(tag, style = {}, properties = {}) {
  const node = document.createElement(tag)
  Object.assign(node.style, style)
  Object.assign(node, properties)
  return node
}

function field(label_text, control) {
  const label = element('label', { display: 'block', marginTop: '12px', fontSize: '13px', color: colors.muted })
  label.textContent = label_text
  Object.assign(control.style, {
    display: 'block',
    boxSizing: 'border-box',
    width: '100%',
    marginTop: '4px',
    padding: '8px 10px',
    border: `1px solid ${colors.border}`,
    borderRadius: '6px',
    background: colors.input,
    color: colors.text,
    font: 'inherit',
    fontSize: '14px',
  })
  label.append(control)
  return label
}

function button(text, primary) {
  return element(
    'button',
    {
      padding: '8px 14px',
      borderRadius: '6px',
      border: primary ? 'none' : `1px solid ${colors.border}`,
      background: primary ? colors.accent : 'transparent',
      color: colors.text,
      font: 'inherit',
      fontSize: '14px',
      fontWeight: '600',
      cursor: 'pointer',
    },
    { textContent: text, type: primary ? 'submit' : 'button' },
  )
}

/**
 * Opens the dialog. `submit` receives { name, email, message } and resolves when
 * the feedback was stored; the dialog resolves to true once it was, and to false
 * when the user closed it without sending.
 *
 * @param {{ submit: (values: object) => Promise<boolean>, labels?: object, name?: string, email?: string }} options
 * @returns {Promise<boolean>}
 */
export function open_feedback_dialog({ submit, labels = {}, name = '', email = '' }) {
  if (typeof document === 'undefined') return Promise.resolve(false)
  const text = { ...default_feedback_labels, ...labels }
  const previous_focus = document.activeElement

  return new Promise((resolve) => {
    const host = element('div')
    const root = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host

    const overlay = element('div', {
      position: 'fixed',
      inset: '0',
      zIndex: '2147483647',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      padding: '16px',
      background: colors.overlay,
      fontFamily: 'system-ui, -apple-system, "Segoe UI", sans-serif',
    })
    const form = element('form', {
      boxSizing: 'border-box',
      width: '100%',
      maxWidth: '420px',
      padding: '20px',
      borderRadius: '12px',
      border: `1px solid ${colors.border}`,
      background: colors.panel,
      color: colors.text,
      boxShadow: '0 20px 50px rgba(0, 0, 0, 0.5)',
    })
    form.setAttribute('role', 'dialog')
    form.setAttribute('aria-modal', 'true')
    form.setAttribute('aria-labelledby', 'bugfree-feedback-title')

    const title = element('h2', { margin: '0', fontSize: '17px', fontWeight: '600' }, { id: 'bugfree-feedback-title' })
    title.textContent = text.title
    const subtitle = element('p', { margin: '6px 0 0', fontSize: '13px', color: colors.muted })
    subtitle.textContent = text.subtitle

    const name_input = element('input', {}, { type: 'text', value: name, autocomplete: 'name', maxLength: 120 })
    const email_input = element('input', {}, { type: 'email', value: email, autocomplete: 'email', maxLength: 255 })
    const message_input = element('textarea', { resize: 'vertical', minHeight: '96px' }, { required: true, maxLength: 5000 })

    const status = element('p', { minHeight: '18px', margin: '10px 0 0', fontSize: '13px' })
    status.setAttribute('role', 'status')

    const actions = element('div', { display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '12px' })
    const cancel = button(text.cancel, false)
    const send = button(text.submit, true)
    actions.append(cancel, send)

    form.append(title, subtitle, field(text.name, name_input), field(text.email, email_input), field(text.message, message_input), status, actions)
    overlay.append(form)
    root.append(overlay)
    document.body.append(host)

    let settled = false
    function close(result) {
      if (settled) return
      settled = true
      document.removeEventListener('keydown', on_key, true)
      host.remove()
      previous_focus?.focus?.()
      resolve(result)
    }

    // Escape closes; Tab stays inside the dialog.
    function on_key(event) {
      if (event.key === 'Escape') {
        event.preventDefault()
        close(false)
        return
      }
      if (event.key !== 'Tab') return
      const focusable = [name_input, email_input, message_input, cancel, send]
      const active = root.activeElement || document.activeElement
      const index = focusable.indexOf(active)
      if (event.shiftKey && index <= 0) {
        event.preventDefault()
        send.focus()
      } else if (!event.shiftKey && index === focusable.length - 1) {
        event.preventDefault()
        name_input.focus()
      }
    }
    document.addEventListener('keydown', on_key, true)

    overlay.addEventListener('click', (event) => {
      if (event.target === overlay) close(false)
    })
    cancel.addEventListener('click', () => close(false))

    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      const message = message_input.value.trim()
      if (!message) {
        message_input.focus()
        return
      }
      send.disabled = true
      send.textContent = text.sending
      status.textContent = ''

      let sent = false
      try {
        sent = await submit({ name: name_input.value.trim(), email: email_input.value.trim(), message })
      } catch {
        sent = false
      }

      if (sent) {
        status.style.color = colors.success
        status.textContent = text.success
        setTimeout(() => close(true), 1500)
        return
      }
      status.style.color = colors.error
      status.textContent = text.failure
      send.disabled = false
      send.textContent = text.submit
    })

    ;(name ? message_input : name_input).focus()
  })
}
