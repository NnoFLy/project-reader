# Application writer ownership

The browser entry point is `createBrowserApplication()` in
`src/lib/app/bootstrap.ts`. `AppShell.svelte` owns it and mounts **both** AppChrome
and route children only while it is ready. This also protects a direct `/viewer`
load. Do not construct a second host in a route or a plugin.

## Gate API

```ts
import { createBrowserApplication } from "$lib/app/bootstrap"

const writer = createBrowserApplication()
const subscription = writer.onStateChange((state) => {
    // Render host-owned feedback unless state is "running".
})
await writer.start()
if (writer.ready) {
    // writer.application is the owned, activated Application.
    await writer.executeCommand("some.registered.command", payload)
}
await writer.stop()
subscription.dispose()
```

- `state`: `idle`, `acquiring`, `starting`, `running`, `blocked`, `unsupported`,
  `failed`, `stopping`, `stopped`, or `recovery-required`.
- `ready`: true only for the current live writer. `application` is undefined
  otherwise. `executeCommand()` rejects when not ready.
- `start()`: shares an outstanding startup promise. A blocked/failed/stopped
  attempt can retry with a new controller, storage backend and host; a live owner
  is never displaced. Expected failures resolve with a feedback state, not private
  exception details. Startup checks actual startup-extension activation records;
  `ExtensionHost.start()` resolving its `allSettled` is not sufficient.
- `stop()`: immediately disables readiness and revokes persistence, then returns
  a shared, bounded shutdown-presentation promise. Resolution does **not** prove
  physical quiescence when state is `recovery-required`.
- `onStateChange(listener)`: returns a disposable subscription.

Default presentation deadlines are 3 seconds for acquisition, 15 seconds for
startup, and 3 seconds for shutdown. Startup failure may additionally await the
bounded shutdown phase. No continuous spinner or indefinite queued takeover is
used. `recovery-required` deliberately requires reload/closure rather than
reusing a partially disposed host. Later native completion may release the lock,
but does not revive that host or re-enable same-page retry.

`BrowserApplicationOptions` supports deadline overrides and an explicit
`storage(lifetime)` factory, migration capability, and host context for **trusted
test composition**. Injected storage must honor the lifetime; injected migration
must share it for native writes/opens. Production passes no overrides and requires
IndexedDB. Absence of durable storage never silently creates an available
in-memory Library.

The existing `createBuiltinApplication()` remains a trusted, ungated composition
API for isolated hosts/tests. It does not acquire a competing lock. Browser code
must use `createBrowserApplication()`, not this lower-level factory.

## One lock, one persistence lifetime

`WriterApplication` requests exactly one stable name:

```text
${location.origin}:project-reader:library:vfs-extension-storage:writer
```

This identifies the current single Library backed by `vfs-extension-storage`,
not a browser tab, route, plugin, or Reading session. Origin scoping matches the
actual IndexedDB Library. A future change to Library identity must update this
composition deliberately; callers must not choose unrelated lock names for the
same data.

The atomic request is `navigator.locks.request(name,
{ mode: "exclusive", ifAvailable: true }, callback)`. There is no `steal`, advisory
localStorage flag, queued acquisition, or unrestricted fallback. A null lock
means `blocked`. Web Locks forbids combining `signal` with `ifAvailable`, so the
bounded attempt uses an internal abort signal and permanently invalidates its
callback. A late acquisition returns immediately without constructing a host.
Missing, throwing, rejecting, or stuck exclusion fails closed. Unexpected request
settlement while running also revokes the host.

Once granted, the callback stays pending for the writer lifetime. Only then does
bootstrap construct the real application, backend and host. One
`IndexedDBWriteLifetime` is shared by the IndexedDB backend, existing Library
migration, and `HostContext.writeSignal`. Viewer reading/search persistence
inherits that same storage and signal through host contracts: **do not add a
Viewer lock or revive a revoked signal**.

Shutdown first marks the attempt inactive and aborts its controller synchronously.
The callback's holding promise resolves **only after** the shared
`lifetime.whenQuiescent()` proves pending native opens and physical write/schema
transactions terminal. A timeout, transaction `abort()` returning, or host
`dispose()` resolving is not that proof. A blocked native schema open can retain
the lock indefinitely; bounded recovery feedback must not timeout-release it.
Host disposal is independently bounded for presentation and cannot publish an
obsolete Application as running. Once persistence is fenced, disposal may finish
after lock release without authorizing old writes.

`pagehide` synchronously disables the UI and revokes this lifetime before
asynchronous teardown. `pageshow` with `persisted` triggers a safe reload, never
re-enabling a BFCache host. Visibility changes do not release ownership. Browser
closure/crash releases native Web Locks and terminates that execution context;
normal live-window recovery still uses a new atomic attempt.

## Feedback and verification

Blocked feedback has the heading **“Library is open in another window”**, a live
`role="status"` region, and `[data-writer-state="blocked"]`. Native **Try again**
and **Reload page** buttons provide keyboard recovery. Retry remains mounted and
uses `aria-disabled` while pending so keyboard focus survives an unsuccessful
retry. Other stable states are observable through the same data attribute.
Feedback uses existing reading surfaces, typography, focus colors and spacing;
actions wrap on narrow screens. Headings, instructions and actions use the English
and Russian Paraglide catalogs. Failures do not display raw exception details.

`tests/integration/writer-startup.test.ts` exercises application startup with real
builtin hosts and the Reading workspace, mocking external Web Locks, clocks and
selected native IndexedDB events. Supporting UI checks in
`writer-startup-ui.test.ts` verify route/chrome suppression, safe feedback and
retry focus. These deterministic checks are **not** evidence of cross-window
browser exclusion.

`tests/integration/writer-browser.test.ts` starts the real application and Chromium
with multiple pages in one profile, sharing the same origin and IndexedDB Library.
It verifies simultaneous startup, live-owner retry, orderly closure, renderer
crash recovery, reload/back navigation, narrow-screen keyboard retry, revoked
owner saves after handover, unavailable Web Locks, and preservation of existing
file contents and unsupported records. Back navigation exercises the browser's
normal cache policy; the test does not require that Chromium chooses BFCache.

Run `pnpm test tests/integration/writer-browser.test.ts`. It uses
`CHROMIUM_PATH` (default `/usr/sbin/chromium`) and skips when that executable is
absent. CI must provide Chromium to retain native exclusion coverage. Set
`WRITER_TEST_URL` to an existing development server to avoid starting a second
one. Supporting native persistence tests in `writer-persistence.test.ts` verify
transaction abort/drain and late database opens/upgrades.

Writer exclusion protects application consistency, **not a hostile same-origin
execution sandbox**. Trusted composition code must not bypass the host backend,
write signal or gate. Browser extensions, arbitrary same-origin scripts and
manually constructed ungated hosts are not isolated by this protocol. Acquisition
adds no database reset, bulk purge, or reading-data migration; existing Library
and unsupported old records remain subject to the existing preservation policy.
