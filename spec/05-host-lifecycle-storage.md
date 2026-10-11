# Host lifecycle and storage

## 1. Lifecycle states

```text
discovered -> installed -> enabled -> activating -> active
                                       \-> failed
active -> disabled -> disposed
active -> uninstalling -> disposed
```

The first implementation needs the lifecycle for built-ins even though package installation is deferred. Built-ins begin in the discovered or installed state and are enabled by the application bootstrap.

## 2. Lifecycle requirements

- Activation is idempotent.
- Concurrent activation requests share one activation attempt.
- Activation errors are isolated to the extension.
- Every registered contribution is disposed on disable or failure.
- Dependencies activate before dependants.
- Dependency cycles are rejected before activation.
- Deactivation cancels outstanding work.
- The host records activation errors without exposing stack traces to untrusted UI.
- A disposed extension cannot register new contributions.
- Re-enabling an extension starts from a clean contribution set.

Activation, disposal, and cancellation need bounded timeouts for future Worker-backed extensions. A stuck extension must not block host shutdown.

## 3. Dependencies

Manifest dependencies are extension IDs with version ranges. The resolver must define:

- Version-range semantics.
- Missing dependency behavior.
- Disabled dependency behavior.
- Optional dependencies, if supported.
- Cycle diagnostics.
- Ordering for independent extensions.

A plugin may depend on a core contract, but it may not import another plugin to reach that contract.

## 4. Namespaced storage

Core provides extension-scoped storage:

```ts
const viewerStorage = context.storage.namespace("viewer")
const libraryStorage = context.storage.namespace("library")
```

The host prefixes and validates namespaces so one extension cannot access another extension's records. The API must not expose the raw Dexie instance.

Requirements:

- Storage operations are asynchronous.
- Each namespace has versioned migrations.
- Migrations are atomic or recoverable after interruption.
- Uninstalling an extension may remove its namespace only after confirmation.
- Extension data survives reload.
- Large document binaries remain managed by the core file service.
- Adapter caches are owned by the adapter namespace and can be cleared independently.
- Quota failures are surfaced as typed, recoverable errors.

Generic core records include files, folders, document source references, and extension metadata. Viewer records include progress, bookmarks, and notes. Library records include only library-specific metadata.

## 5. Resource and error handling

Core owns resource limits for file access, parsing, rendering, and storage. Extensions may request work through capability APIs but cannot bypass those limits.

Errors exposed to the UI contain a safe user-facing code and message. Diagnostic details remain in namespaced host logs. Document contents, raw file data, and stack traces must not be logged by default.
