# Extension API and contributions

## 1. Design rules

The public API is framework-neutral and capability-based. It must not import Svelte types. Native Svelte component types are an internal API for built-in extensions only.

Every registration method returns a `Disposable`. Disabling or failing an extension disposes every contribution registered through its context.

## 2. Manifest

Every extension, including built-ins, has a manifest:

```ts
export interface ExtensionManifest {
    readonly id: string
    readonly name: string
    readonly version: string
    readonly engine: string
    readonly entry: string
    readonly activationEvents: readonly ActivationEvent[]
    readonly permissions: readonly ExtensionPermission[]
    readonly dependencies?: Readonly<Record<string, string>>
    readonly contributes?: ExtensionContributions
}
```

Extension IDs use a reverse-domain or vendor namespace, for example:

```text
builtin.viewer
reader.pdf
community.epub
```

Command, view, setting, and adapter IDs must also be namespaced. An extension may register IDs only under its own namespace unless it is registering a documented shared capability.

## 3. Activation events

Initial activation events:

```ts
export type ActivationEvent =
    | { type: "startup" }
    | { type: "onCommand"; commandId: string }
    | { type: "onView"; viewId: string }
    | { type: "onDocumentType"; extension: string }
    | { type: "onLanguage"; language: string }
```

Activation is lazy where possible. Opening a PDF must not load PDF.js until the PDF extension is needed.

Activation must be idempotent. Concurrent activation requests resolve through one activation attempt rather than running the extension twice.

## 4. Extension context

```ts
export interface ExtensionContext {
    readonly extension: ExtensionInfo
    readonly commands: CommandRegistry
    readonly views: ViewRegistry
    readonly settings: SettingsRegistry
    readonly documents: DocumentAdapterRegistry
    readonly storage: ExtensionStorage
    readonly notifications: NotificationService
    readonly lifecycle: Lifecycle
}

export interface AppExtension {
    readonly manifest: ExtensionManifest
    activate(context: ExtensionContext): void | Promise<void>
}
```

The context is the only supported way for a plugin to access host capabilities. The host validates every contribution before registration. Invalid contributions fail activation without partially corrupting global state.

## 5. Contributions

The first contribution points are:

- Commands
- Keybindings
- Settings
- Views
- Document adapters
- Prompt providers
- Menus
- Notifications

### Commands

Commands are discoverable by Prompt and registered by namespaced string ID:

```ts
commands.register({
    id: "viewer.next-page",
    label: () => "Next page",
    keybinding: ["j", "arrowdown"],
    execute: () => viewer.nextPage(),
})
```

The old global `AppCommandPayloads` union is removed. Payload types remain local to a built-in plugin. Any payload crossing a future runtime boundary must use an explicitly versioned, serializable command contract.

Command registration must define:

- ID and display metadata.
- Optional keybindings and scope.
- Payload validation.
- Execution result and error behavior.
- Whether the command is available in the current context.

### Views

Views target host-defined slots:

```ts
type ViewSlot =
    | "workbench.sidebar"
    | "workbench.panel"
    | "viewer.toolbar"
    | "viewer.sidebar"
    | "prompt.result"
```

Built-ins may register native views internally:

```ts
views.registerNative({
    id: "viewer.outline",
    slot: "viewer.sidebar",
    component: OutlineSidebar,
})
```

Future installed extensions use a separate webview or custom-element contract. They do not inject arbitrary Svelte components.

## 6. Future wire compatibility

The built-in API may use callbacks and native objects. The future runtime API may not assume that those values cross a Worker boundary. Before runtime extensions are implemented, define separate wire-level DTOs for:

- Command metadata, payloads, and results.
- View messages and events.
- Document reads and rendered pages.
- Cancellation and timeouts.
- Errors and logs.

No PDF.js types, Svelte types, host stores, DOM nodes, or raw storage handles may cross the public boundary.
