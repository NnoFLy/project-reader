export interface Disposable {
    dispose(): void | Promise<void>
}

export type Unsubscribe = Disposable

const NAMESPACE_PATTERN = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/

export function isNamespacedId(id: string): boolean {
    const separator = id.indexOf(".")
    return separator > 0 && separator < id.length - 1 && NAMESPACE_PATTERN.test(id)
}

export function assertNamespacedId(id: string, kind = "contribution"): void {
    if (!isNamespacedId(id)) throw new Error(`Invalid namespaced ${kind} ID: ${id}`)
}

export function extensionNamespace(extensionId: string): string {
    assertNamespacedId(extensionId, "extension")
    return extensionId.split(".").at(-1) as string
}

export function belongsToExtension(id: string, extensionId: string): boolean {
    if (!isNamespacedId(id)) return false
    const namespace = extensionNamespace(extensionId)
    return id.startsWith(`${extensionId}.`) || id.startsWith(`${namespace}.`)
}

export type ActivationEvent =
    | { readonly type: "startup" }
    | { readonly type: "onCommand"; readonly commandId: string }
    | { readonly type: "onView"; readonly viewId: string }
    | { readonly type: "onDocumentType"; readonly extension: string }
    | { readonly type: "onLanguage"; readonly language: string }

export type ExtensionPermission =
    | "storage"
    | "notifications"
    | "commands"
    | "views"
    | "documents"
    | "settings"

export interface ExtensionContributions {
    readonly commands?: readonly CommandContribution[]
    readonly keybindings?: readonly KeybindingContribution[]
    readonly settings?: readonly SettingContribution[]
    readonly views?: readonly ViewContribution[]
    readonly adapters?: readonly DocumentAdapterContribution[]
}

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

export interface ExtensionInfo {
    readonly id: string
    readonly name: string
    readonly version: string
    readonly engine: string
}

export interface AppExtension {
    readonly manifest: ExtensionManifest
    activate(context: ExtensionContext): void | Promise<void>
}

export interface ExtensionContext {
    readonly extension: ExtensionInfo
    /** Permissions are supplied by the host; manually created contexts may omit them. */
    readonly permissions?: import("./permissions").PermissionSet
    readonly commands: import("./commands").CommandRegistry
    readonly views: import("./views").ViewRegistry
    readonly settings: import("./settings").SettingsRegistry
    readonly documents: import("./documents").DocumentAdapterRegistry
    readonly storage: import("./storage").ExtensionStorage
    readonly notifications: import("./notifications").NotificationService
    readonly lifecycle: Lifecycle
}

export type LifecycleState =
    | "discovered"
    | "installed"
    | "enabled"
    | "activating"
    | "active"
    | "failed"
    | "disabled"
    | "uninstalling"
    | "disposed"

export interface Lifecycle {
    readonly state: LifecycleState
    onDispose(listener: () => void | Promise<void>): Disposable
    isDisposed(): boolean
}

export interface CommandContribution {
    readonly id: string
    readonly label: string | (() => string)
    readonly keybinding?: readonly string[]
    readonly scope?: string
    readonly execute: (payload?: unknown) => unknown | Promise<unknown>
    readonly isEnabled?: (context?: unknown) => boolean | Promise<boolean>
    readonly validatePayload?: (payload: unknown) => boolean
}

export interface KeybindingContribution {
    readonly commandId: string
    readonly keybinding: readonly string[]
    readonly when?: (context?: unknown) => boolean
}

export interface ViewContribution {
    readonly id: string
    readonly slot: import("./views").ViewSlot
    readonly title?: string | (() => string)
}

export type DocumentAdapterContribution = import("$lib/document-model").DocumentAdapter

export interface SettingContribution<T = unknown> {
    readonly id: string
    readonly label: string | (() => string)
    readonly defaultValue: T
    readonly validate?: (value: unknown) => value is T
}

export function extensionInfo(manifest: ExtensionManifest): ExtensionInfo {
    return {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        engine: manifest.engine,
    }
}

export function disposeAll(disposables: readonly Disposable[]): Promise<void> {
    return Promise.allSettled(disposables.map((disposable) => disposable.dispose())).then(
        () => undefined,
    )
}
