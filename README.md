# @subnomic/bugfree-js

The bugfree SDK for browser applications: plain pages, Vue, React and any other
framework. It reports uncaught errors and rejected promises with the steps that
led to them, and resolves minified frames back to your source.

```sh
npm install @subnomic/bugfree-js    # or: bun add @subnomic/bugfree-js
```

It runs in the browser; it does not report from Node.js.

## Setup

```js
// bugfree.js
import { create_bugfree } from '@subnomic/bugfree-js'

export const bugfree = create_bugfree({
  dsn: import.meta.env.VITE_BUGFREE_DSN, // http://<key>@host:3000/ingest
  environment: import.meta.env.MODE,
  release: 'web@1.4.0',
})

// window.onerror + unhandledrejection, and breadcrumbs for fetch, XHR,
// clicks, page changes and the console
bugfree.install()
```

An empty `dsn` disables the SDK: nothing is installed and every call is a no-op.

### Vue

Pass the application and the router to `install` instead, before mounting.
Component errors then go through Vue's `errorHandler`, and route changes become
breadcrumbs:

```js
const app = createApp(App)
bugfree.install(app, router)
app.use(router).mount('#app')
```

### React

Errors React does not catch reach the global handlers. Errors an error boundary
catches stay inside React; report them from the root (React 19):

```jsx
createRoot(document.getElementById('root'), {
  onCaughtError(error, info) {
    bugfree.capture_exception(error, { extra: { component_stack: info.componentStack } })
    console.error(error)
  },
}).render(<App />)
```

### Other frameworks

`install()` sees every error that reaches the page. Where a framework catches
errors itself, such as Angular's `ErrorHandler`, call `capture_exception` there.

## Capturing

```js
bugfree.capture_exception(error, { tags: { step: 'checkout' } })
bugfree.capture_message('cart recovered', { level: 'info' })

bugfree.set_user({ id: user.id, email: user.email })
bugfree.set_tag('plan', 'team')
bugfree.add_breadcrumb({ category: 'ui', message: 'clicked pay' })

await bugfree.flush()   // before navigating away
```

Both capture calls return a promise of the event id (`null` when nothing was
sent); `bugfree.last_event_id()` has it as soon as the call returns, to show the
user as a reference. An error created with `{ cause }` lists its causes on the
issue.

### User feedback

```js
// A dialog that asks what happened, tied to the latest captured event
await bugfree.show_feedback_dialog({ labels: { title: 'Sorry, that did not work' } })

// Or from a form of your own
await bugfree.capture_feedback({ message, email })
```

Every event carries the browser context under `extra.browser`: viewport and
screen size, language, online state and connection type.

Clicks are recorded by selector only (tag, id, classes, `name` or
`aria-label`), never by the text on the page. When the page is left, events still
waiting are handed to `sendBeacon`. A `429` answer pauses sending for as long as
its `Retry-After` asks, a minute when it names no time.

## Original source instead of minified frames

Browser stack traces point at the bundle (`/assets/index-abc.js:1:24815`).
The SDK downloads that file's `.map`, decodes the mappings itself and reads
the original code from `sourcesContent`, so the issue page shows your original
file (`.vue`, `.tsx`, `.js`), the real line number and the surrounding code.

Enable source maps in the build:

```js
// vite.config.js
build: { sourcemap: true }
```

Frames that cannot be resolved (no map published, or a generated line with no
mapping) are sent as-is — an error is never dropped because of a missing map.

> Published source maps are readable by anyone who can load the app. If that
> is not acceptable, upload them to the release on your bugfree server instead,
> leave them out of the deployment and set `resolve_source_maps: false`.

## Options

| Option | Default | Meaning |
|---|---|---|
| `environment` | `'production'` | Environment tag. |
| `release` | `''` | Release tag used for grouping and regressions. |
| `sample_rate` | `1` | Fraction of events to send. |
| `source_context_lines` | `5` | Lines shown around the failing line. |
| `resolve_source_maps` | `true` | Resolve minified frames through `.map` files. |
| `max_breadcrumbs` | `30` | Ring buffer size. |
| `dedupe_window_ms` | `10000` | Same error is sent once per window. |
| `ignore_errors` | `[]` | Strings or RegExps; drops errors whose `Type: message` matches. |
| `traces_sample_rate` | `0` | Share of page loads and navigations timed, with requests as spans and web vitals. |
| `replays_on_error_sample_rate` | `0` | Share of page loads that keep their last minute of session replay and send it with an error. |
| `replays_session_sample_rate` | `0` | Share of page loads recorded as a session replay from start to end. |
| `replay_mask_all_text` | `true` | Mask every text in replays (input values are always masked). |
| `profiles_sample_rate` | `0` | Share of timed transactions profiled with the JS Self-Profiling API (Chromium, page served with `Document-Policy: js-profiling`). |
| `trace_propagation_targets` | `[]` | Other origins whose requests carry the `traceparent` header. |
| `track_sessions` | `true` | Report every page load as a session of the release, for release health. |
| `deny_urls` | `[]` | Strings or RegExps; drops errors thrown by scripts at these addresses. |
| `before_send` | `null` | Return `null` to drop, or edit the event. |
| `debug` | `false` | Warn to the console about SDK problems. |

## Tests

```sh
node --test test/*.test.mjs
```

## Releasing

The SDK is published to `github.com/subnomic/bugfree-js-sdk`, with this
directory as that repository's root, and to npm, by the bugfree release: one
release on the bugfree repository's Releases page with the tag `v0.9.0` publishes
the server and both SDKs at that version. Raise `version` in `package.json` and
`VERSION` in `src/index.js` with the others.

The release workflow checks that both versions match the tag, runs the tests,
pushes this directory to that repository as one commit, tags it there as `v0.9.0`
and publishes the package to npm (under `next` for a pre-release).

## License

MIT, see [`LICENSE`](LICENSE).
