# Deferred runtime extensions

This specification records constraints for a later project. It is not part of the first plugin migration.

## 1. Trust model

The initial runtime-extension model assumes trusted extension code. A browser Worker provides a responsiveness and execution boundary, not a complete malicious-code sandbox.

An extension running as arbitrary JavaScript in a same-origin Worker may still access platform APIs such as `fetch`, IndexedDB, Cache Storage, and messaging. Therefore:

- Permission declarations must not be presented as protection against hostile code.
- A future hardened mode requires a separate threat model and security review.
- Signing, source trust, origin isolation, CSP, and package policy are unresolved requirements for hostile-extension support.

## 2. Deferred execution model

When runtime extensions are implemented, extension logic may run in a Worker and communicate through a versioned RPC protocol. Installed extensions must not receive direct access to:

- The host DOM or Svelte internals.
- The host IndexedDB instance.
- Raw `FileSystemFileHandle` objects.
- Unrestricted host modules.

Host capabilities are exposed through RPC proxies. All values crossing the boundary must be serializable or explicitly transferable.

The protocol must define:

- Handshake and API version negotiation.
- Request IDs and cancellation.
- Timeouts and resource quotas.
- Transferable binary data.
- Backpressure for document reads and rendering.
- Structured errors.
- Worker crash and restart behavior.
- Disposal and in-flight request handling.

## 3. Runtime UI

Installed UI extensions may contribute controlled webviews or custom-element surfaces. They do not inject arbitrary Svelte components into the host.

Before implementation, define:

- Sandbox and origin behavior.
- CSP and allowed asset sources.
- Message validation and origin checks.
- Navigation and download restrictions.
- Theme, localization, sizing, and accessibility behavior.
- Cleanup when a view or extension is disabled.

## 4. Package installation

A later package store may support local files and configured HTTPS sources. Marketplace discovery is out of scope.

A package may contain:

```text
extension.json
extension.js
assets/
ui/
```

The future installer must:

- Validate manifest shape and IDs.
- Validate engine compatibility.
- Enforce package and asset size limits.
- Validate declared permissions.
- Verify integrity or signatures according to the trust policy.
- Store packages offline for later activation.
- Never execute package code during download or manifest inspection.
- Require explicit confirmation before enabling a newly installed extension.
- Support update rollback and removal of broken packages.

The package transport must be abstracted behind `ExtensionPackageStore`.

## 5. Permissions

Candidate permissions are:

```ts
export type ExtensionPermission =
    | "storage"
    | "document.read"
    | "document.write"
    | "ui.webview"
    | "network"
    | "clipboard"
```

The host can enforce permissions for host-provided capabilities. It cannot reliably restrict arbitrary browser API usage by same-origin extension code. A hardened mode must solve that problem before claiming hostile-extension protection.

## 6. Go/no-go criteria

Runtime implementation must wait until the project has:

- A reviewed wire protocol.
- A documented trust model.
- A package integrity and update policy.
- Worker crash and cleanup tests.
- Permission enforcement tests at every host API boundary.
- Webview origin and CSP tests.
- A test extension that registers a command and document adapter without importing application paths.
