import {
    ExtensionLifecycle,
    ProviderRecoveryBlockedError,
    assertNamespacedId,
    belongsToExtension,
    canonicalBuiltinId,
    createPermissionSet,
    extensionInfo,
    extensionNamespace,
    guardExtensionCapability,
    type AppExtension,
    type ExtensionContext,
    type ExtensionManifest,
    type ExtensionStorage,
    type LegacyMigrationCapability,
    type HostContext,
    type PermissionSet,
    type ProviderAvailability,
    type ProviderSnapshot,
} from "../extension-api"
import { DocumentService } from "../core/documents"
import { normalizeKeybinding, type HostCommandFacade } from "../core/commands"
import { NotificationServiceImpl } from "../core/notifications"
import { ContextualStatusServiceImpl } from "../core/contextual-status"
import { createExtensionStorage, MemoryStorageBackend, type StorageBackend } from "../core/storage"
import { ContributionRegistry } from "./contribution-registry"
import { ExtensionStorageLifetime } from "./storage-lifetime"
import { resolveDependencies } from "./dependency-resolution"
import { ExtensionActivationError, type LifecycleRecord } from "./lifecycle"

export interface ExtensionHostOptions {
    readonly extensions: readonly AppExtension[]
    readonly storage?: StorageBackend
    readonly notifications?: NotificationServiceImpl
    readonly documentService?: DocumentService
    readonly migration?: LegacyMigrationCapability
    readonly hostContext?: HostContext
    /** Presentation bound only; expiration does not prove storage quiescence. */
    readonly cleanupTimeoutMs?: number
}

interface ExtensionRuntime {
    readonly extension: AppExtension
    readonly permissions: PermissionSet
    lifecycle: ExtensionLifecycle
    storage: ExtensionStorage
    storageLifetime: ExtensionStorageLifetime
    state: LifecycleRecord["state"]
    error?: ExtensionActivationError
    activation?: Promise<void>
    generation: number
    intentRevision: number
    snapshot: ProviderSnapshot
}

export class ExtensionHost {
    readonly contributions: ContributionRegistry
    /** Shared host-owned command discovery and execution facade. */
    readonly commands: HostCommandFacade
    /** Shared prompt capability for host-owned chrome that conditionally mounts prompt views. */
    get prompt(): HostContext["prompt"] {
        return this.hostContext.prompt
    }
    get readingRecovery(): HostContext["readingRecovery"] {
        return this.hostContext.readingRecovery
    }
    readonly notifications: NotificationServiceImpl
    readonly contextualStatus: ContextualStatusServiceImpl
    readonly documentService: DocumentService
    private readonly runtimes = new Map<string, ExtensionRuntime>()
    private readonly storage: StorageBackend
    private readonly migration?: LegacyMigrationCapability
    private readonly hostContext: HostContext
    private readonly providerListeners = new Set<(provider: ProviderSnapshot) => void>()
    readonly providers: ProviderAvailability = {
        get: (id) => this.runtimes.get(id)?.snapshot,
        onDidChange: (listener) => {
            this.providerListeners.add(listener)
            return {
                dispose: () => {
                    this.providerListeners.delete(listener)
                },
            }
        },
    }
    private readonly publicationOwners = new Map<keyof HostContext, ExtensionLifecycle>()
    private readonly cleanupTimeoutMs: number
    private disposing = false
    private disposal?: Promise<void>
    constructor(options: ExtensionHostOptions) {
        this.cleanupTimeoutMs = options.cleanupTimeoutMs ?? 250
        this.storage =
            options.storage ??
            new MemoryStorageBackend({ signal: options.hostContext?.writeSignal })
        this.migration = options.migration
        this.notifications = options.notifications ?? new NotificationServiceImpl()
        this.contextualStatus = new ContextualStatusServiceImpl()
        this.documentService = options.documentService ?? new DocumentService()
        this.contributions = new ContributionRegistry(this.documentService.adapters)
        this.commands = this.contributions.globalCommands
        this.hostContext = {
            ...options.hostContext,
            commands: this.commands,
            providers: this.providers,
        }
        const validated = options.extensions.map((extension) => ({
            extension,
            permissions: validateManifest(extension.manifest),
        }))
        assertUniqueExtensionNamespaces(validated.map(({ extension }) => extension.manifest))
        const { order } = resolveDependencies(validated.map(({ extension }) => extension.manifest))
        const byId = new Map(validated.map((value) => [value.extension.manifest.id, value]))
        for (const manifest of order) {
            const value = byId.get(manifest.id)
            if (!value) throw new Error(`No implementation for extension: ${manifest.id}`)
            const lifecycle = new ExtensionLifecycle("enabled")
            const storageLifetime = new ExtensionStorageLifetime(this.storage, lifecycle.signal)
            this.runtimes.set(manifest.id, {
                extension: value.extension,
                permissions: value.permissions,
                lifecycle,
                storage: createExtensionStorage(storageLifetime, manifest.id),
                storageLifetime,
                state: "enabled",
                generation: 1,
                intentRevision: 0,
                snapshot: Object.freeze({
                    extensionId: manifest.id,
                    generation: 1,
                    state: "enabled",
                    signal: lifecycle.signal,
                }),
            })
        }
    }

    get records(): readonly LifecycleRecord[] {
        return [...this.runtimes.values()].map(({ extension, state, error }) => ({
            manifest: extension.manifest,
            state,
            error: error && {
                code: error.code,
                message: error.safeMessage,
                extensionId: error.extensionId,
            },
        }))
    }

    record(extensionId: string): LifecycleRecord | undefined {
        const runtime = this.runtimes.get(extensionId)
        return (
            runtime && {
                manifest: runtime.extension.manifest,
                state: runtime.state,
                error: runtime.error && {
                    code: runtime.error.code,
                    message: runtime.error.safeMessage,
                    extensionId: runtime.error.extensionId,
                },
            }
        )
    }

    async start(): Promise<void> {
        const startup = [...this.runtimes.values()]
            .filter(({ extension }) =>
                extension.manifest.activationEvents.some((event) => event.type === "startup"),
            )
            .map(({ extension }) => extension.manifest.id)
        await Promise.allSettled(startup.map((id) => this.activate(id)))
    }

    async activate(extensionId: string): Promise<void> {
        if (this.disposing) throw new Error("Extension host is disposing")
        const runtime = this.runtimes.get(extensionId)
        if (!runtime) throw new Error(`Unknown extension: ${extensionId}`)
        if (runtime.state === "active") return
        if (
            runtime.state === "failed" ||
            runtime.state === "disposed" ||
            runtime.state === "disabled"
        ) {
            throw new Error(`Extension is not enabled: ${extensionId}`)
        }

        if (runtime.activation) return runtime.activation
        const activation = Promise.resolve().then(() => this.performActivation(runtime))
        runtime.activation = activation
        try {
            await activation
        } finally {
            if (runtime.activation === activation) runtime.activation = undefined
        }
    }

    async activateForCommand(commandId: string): Promise<void> {
        await this.activateForEvent(
            (event) => event.type === "onCommand" && event.commandId === commandId,
        )
    }

    async activateForView(viewId: string): Promise<void> {
        await this.activateForEvent((event) => event.type === "onView" && event.viewId === viewId)
    }

    async activateForDocumentType(extension: string): Promise<void> {
        await this.activateForEvent(
            (event) => event.type === "onDocumentType" && event.extension === extension,
        )
    }

    disable(extensionId: string): Promise<void> {
        const runtime = this.requireRuntime(extensionId)
        if (runtime.state === "disposed" || runtime.state === "disabled") {
            // Repeated disable still supersedes an enable waiting for obsolete work.
            runtime.intentRevision++
            return Promise.resolve()
        }
        return this.invalidate(runtime, "disabled")
    }

    async enable(extensionId: string): Promise<void> {
        const runtime = this.requireRuntime(extensionId)
        if (this.disposing || runtime.state === "disposed")
            throw new Error(`Extension host is disposing: ${extensionId}`)
        if (runtime.state !== "disabled" && runtime.state !== "failed") return
        const previous = runtime.lifecycle
        const intentRevision = ++runtime.intentRevision
        let quiescent = false
        await this.bounded(
            Promise.all([
                Promise.allSettled([runtime.activation]),
                runtime.storageLifetime.whenQuiescent(),
            ]).then(() => {
                quiescent = true
            }),
        )
        if (!quiescent) throw new ProviderRecoveryBlockedError(extensionId)
        if (this.disposing) throw new Error(`Extension host is disposing: ${extensionId}`)
        if (runtime.lifecycle !== previous || runtime.intentRevision !== intentRevision) return
        runtime.lifecycle = new ExtensionLifecycle("enabled")
        runtime.storageLifetime = new ExtensionStorageLifetime(
            this.storage,
            runtime.lifecycle.signal,
        )
        runtime.storage = createExtensionStorage(runtime.storageLifetime, extensionId)
        runtime.generation++
        runtime.error = undefined
        runtime.activation = undefined
        this.setState(runtime, "enabled")
    }

    dispose(): Promise<void> {
        if (this.disposal) return this.disposal
        this.disposing = true
        let complete!: () => void
        let fail!: (error: unknown) => void
        this.disposal = new Promise<void>((resolve, reject) => {
            complete = resolve
            fail = reject
        })
        const cleanups = [...this.runtimes.values()].map((runtime) =>
            this.invalidate(runtime, "disposed"),
        )
        const documents = this.documentService.dispose()
        void this.bounded(Promise.allSettled([documents, ...cleanups]))
            .then(() => {
                this.contextualStatus.reset()
                this.contributions.dispose()
                this.providerListeners.clear()
            })
            .then(complete, fail)
        return this.disposal
    }

    private setState(runtime: ExtensionRuntime, state: LifecycleRecord["state"]): void {
        runtime.state = state
        runtime.lifecycle.setState(state)
        runtime.snapshot = Object.freeze({
            extensionId: runtime.extension.manifest.id,
            generation: runtime.generation,
            state,
            signal: runtime.lifecycle.signal,
        })
        for (const listener of this.providerListeners) {
            try {
                listener(runtime.snapshot)
            } catch {
                /* Observers cannot prevent invalidation. */
            }
        }
    }

    private invalidate(
        runtime: ExtensionRuntime,
        state: "disabled" | "failed" | "disposed",
    ): Promise<void> {
        runtime.intentRevision++
        const lifecycle = runtime.lifecycle
        runtime.state = state
        const cleanup = lifecycle.dispose()
        const id = runtime.extension.manifest.id
        this.contextualStatus.forExtension(id).clear()
        this.contributions.disposeExtension(id)
        for (const [key, owner] of this.publicationOwners) {
            if (owner !== lifecycle) continue
            Reflect.set(this.hostContext, key, undefined)
            this.publicationOwners.delete(key)
        }
        this.setState(runtime, state)
        return this.bounded(cleanup)
    }

    private async bounded(operation: Promise<unknown>): Promise<void> {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
            await Promise.race([
                operation,
                new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, this.cleanupTimeoutMs)
                }),
            ])
        } finally {
            clearTimeout(timer)
        }
    }

    private async activateForEvent(
        predicate: (event: ExtensionManifest["activationEvents"][number]) => boolean,
    ): Promise<void> {
        const candidates = [...this.runtimes.values()].filter(({ extension }) =>
            extension.manifest.activationEvents.some(predicate),
        )
        await Promise.all(candidates.map(({ extension }) => this.activate(extension.manifest.id)))
    }

    private async performActivation(runtime: ExtensionRuntime): Promise<void> {
        const manifest = runtime.extension.manifest
        const lifecycle = runtime.lifecycle
        const current = () =>
            !this.disposing && runtime.lifecycle === lifecycle && !lifecycle.isDisposed()
        try {
            if (!current()) return
            for (const dependency of Object.keys(manifest.dependencies ?? {}))
                await this.activate(dependency)
            if (!current()) return
            this.setState(runtime, "activating")
            if (!current()) return
            const registries = this.contributions.forExtension(
                manifest.id,
                runtime.permissions,
                runtime.storage,
            )
            const hostContext = this.hostContext
            const publish = <K extends keyof HostContext>(key: K, value: HostContext[K]) => {
                if (!current()) return
                this.publicationOwners.set(key, lifecycle)
                hostContext[key] = value
            }
            const liveCapability = <T extends object>(capability: T): T =>
                new Proxy(capability, {
                    get: (target, key) => {
                        const value = Reflect.get(target, key, target)
                        if (typeof value !== "function") return value
                        return (...args: unknown[]) => {
                            if (!current())
                                throw new Error(`Extension context is disposed: ${manifest.id}`)
                            return Reflect.apply(value, target, args)
                        }
                    },
                })
            const status = this.contextualStatus.forExtension(manifest.id)
            const context: ExtensionContext = {
                extension: extensionInfo(manifest),
                permissions: runtime.permissions,
                host: {
                    ...hostContext,
                    commands: liveCapability(this.commands),
                    contextualStatus: {
                        publish: (value) => {
                            const publication = current() ? status.publish(value) : undefined
                            return {
                                dispose: () => {
                                    if (current()) publication?.dispose()
                                },
                            }
                        },
                        clear: () => {
                            if (current()) status.clear()
                        },
                    },
                    // Forward mutable services to the shared host, including late installation
                    // and disposal, without sharing the extension-scoped status publisher.
                    get prompt() {
                        return current() ? hostContext.prompt : undefined
                    },
                    set prompt(value: HostContext["prompt"]) {
                        publish("prompt", value)
                    },
                    get readingSummaries() {
                        return current() ? hostContext.readingSummaries : undefined
                    },
                    set readingSummaries(value: HostContext["readingSummaries"]) {
                        publish("readingSummaries", value)
                    },
                    get readingRecovery() {
                        return current() ? hostContext.readingRecovery : undefined
                    },
                    set readingRecovery(value: HostContext["readingRecovery"]) {
                        publish("readingRecovery", value)
                    },
                    get readingDisplay() {
                        return current() ? hostContext.readingDisplay : undefined
                    },
                    set readingDisplay(value: HostContext["readingDisplay"]) {
                        publish("readingDisplay", value)
                    },
                    get settings() {
                        return current() ? hostContext.settings : undefined
                    },
                    set settings(value: HostContext["settings"]) {
                        publish("settings", value)
                    },
                },
                commands: liveCapability(registries.commands),
                views: registries.views,
                settings: registries.settings,
                documents: registries.documents,
                storage: guardExtensionCapability(runtime.storage, runtime.permissions, "storage"),
                migration: this.migration,
                notifications: liveCapability(
                    guardExtensionCapability(
                        this.notifications,
                        runtime.permissions,
                        "notifications",
                    ),
                ),
                lifecycle,
            }
            await runtime.extension.activate(context)
            if (current()) this.setState(runtime, "active")
        } catch (cause) {
            if (!current()) return
            const error = new ExtensionActivationError(manifest.id, cause)
            runtime.error = error
            await this.invalidate(runtime, "failed")
            if (runtime.lifecycle === lifecycle)
                this.notifications.error(`Extension ${manifest.name} failed to activate.`)
            throw error
        }
    }

    private requireRuntime(extensionId: string): ExtensionRuntime {
        const runtime = this.runtimes.get(extensionId)
        if (!runtime) throw new Error(`Unknown extension: ${extensionId}`)
        return runtime
    }
}

function validateManifest(manifest: ExtensionManifest): PermissionSet {
    assertNamespacedId(manifest.id, "extension")
    for (const field of ["name", "version", "engine", "entry"] as const) {
        if (!manifest[field].trim())
            throw new Error(`Extension ${manifest.id} has an empty ${field}`)
    }
    const permissions = createPermissionSet(manifest.permissions)
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
        assertNamespacedId(dependency, "dependency")
    }
    for (const event of manifest.activationEvents) {
        if (event.type === "onCommand" || event.type === "onView") {
            const id = event.type === "onCommand" ? event.commandId : event.viewId
            assertNamespacedId(id, event.type)
            if (!belongsToExtension(id, manifest.id)) {
                throw new Error(`Activation event is outside extension namespace ${manifest.id}`)
            }
        }
    }
    const contributions = manifest.contributes
    const commandIds = new Set<string>()
    for (const command of contributions?.commands ?? []) {
        assertNamespacedId(command.id, "command")
        if (!belongsToExtension(command.id, manifest.id)) {
            throw new Error(
                `Contribution ${command.id} is outside extension namespace ${manifest.id}`,
            )
        }
        if ([...commandIds].some((id) => commandIdsShadow(id, command.id))) {
            throw new Error(`Command shadows an existing command: ${command.id}`)
        }
        commandIds.add(command.id)
    }
    const ids = new Set<string>()
    for (const contribution of [
        ...(contributions?.commands ?? []),
        ...(contributions?.settings ?? []),
        ...(contributions?.views ?? []),
        ...(contributions?.adapters ?? []),
    ]) {
        assertNamespacedId(contribution.id, "contribution")
        if (!belongsToExtension(contribution.id, manifest.id)) {
            throw new Error(
                `Contribution ${contribution.id} is outside extension namespace ${manifest.id}`,
            )
        }
        if (ids.has(contribution.id)) {
            throw new Error(`Contribution is already declared: ${contribution.id}`)
        }
        ids.add(contribution.id)
    }
    const bindings = new Set<string>()
    for (const binding of contributions?.keybindings ?? []) {
        assertNamespacedId(binding.commandId, "command")
        if (!belongsToExtension(binding.commandId, manifest.id)) {
            throw new Error(
                `Keybinding command ${binding.commandId} is outside extension namespace ${manifest.id}`,
            )
        }
        assertValidKeybinding(binding.keybinding, binding.commandId)
        const key = keybindingKey(binding.keybinding)
        if (bindings.has(key)) throw new Error(`Keybinding is already declared: ${key}`)
        bindings.add(key)
    }
    return permissions
}

function assertValidKeybinding(keybinding: readonly string[], commandId: string): void {
    if (!keybinding.length || keybinding.some((part) => !part.trim())) {
        throw new Error(`Command ${commandId} must declare a non-empty keybinding`)
    }
}

function keybindingKey(keybinding: readonly string[]): string {
    return normalizeKeybinding(keybinding.join("+"))
}

function assertUniqueExtensionNamespaces(manifests: readonly ExtensionManifest[]): void {
    const owners = new Map<string, string>()
    for (const manifest of manifests) {
        const namespace = extensionNamespace(manifest.id)
        const owner = owners.get(namespace)
        if (owner) {
            throw new Error(
                `Extension namespace is already registered: ${namespace} (${owner} and ${manifest.id})`,
            )
        }
        owners.set(namespace, manifest.id)
    }
}

function commandIdsShadow(left: string, right: string): boolean {
    const canonicalLeft = canonicalBuiltinId(left)
    const canonicalRight = canonicalBuiltinId(right)
    return (
        canonicalLeft === canonicalRight ||
        canonicalLeft.startsWith(`${canonicalRight}.`) ||
        canonicalRight.startsWith(`${canonicalLeft}.`)
    )
}
