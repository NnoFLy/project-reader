import {
    ExtensionLifecycle,
    assertNamespacedId,
    belongsToExtension,
    createPermissionSet,
    extensionInfo,
    guardExtensionCapability,
    type AppExtension,
    type ExtensionContext,
    type ExtensionManifest,
    type ExtensionStorage,
    type PermissionSet,
} from "../extension-api"
import { DocumentService } from "../core/documents"
import { NotificationServiceImpl } from "../core/notifications"
import { createExtensionStorage, MemoryStorageBackend, type StorageBackend } from "../core/storage"
import { ContributionRegistry } from "./contribution-registry"
import { resolveDependencies } from "./dependency-resolution"
import { ExtensionActivationError, type LifecycleRecord } from "./lifecycle"

export interface ExtensionHostOptions {
    readonly extensions: readonly AppExtension[]
    readonly storage?: StorageBackend
    readonly notifications?: NotificationServiceImpl
    readonly documentService?: DocumentService
}

interface ExtensionRuntime {
    readonly extension: AppExtension
    readonly permissions: PermissionSet
    lifecycle: ExtensionLifecycle
    readonly storage: ExtensionStorage
    state: LifecycleRecord["state"]
    error?: ExtensionActivationError
    activation?: Promise<void>
    transition: Promise<void>
}

export class ExtensionHost {
    readonly contributions: ContributionRegistry
    readonly notifications: NotificationServiceImpl
    readonly documentService: DocumentService
    private readonly runtimes = new Map<string, ExtensionRuntime>()
    private readonly storage: StorageBackend
    private disposing = false
    private disposal?: Promise<void>
    constructor(options: ExtensionHostOptions) {
        this.storage = options.storage ?? new MemoryStorageBackend()
        this.notifications = options.notifications ?? new NotificationServiceImpl()
        this.documentService = options.documentService ?? new DocumentService()
        this.contributions = new ContributionRegistry(this.documentService.adapters)
        const validated = options.extensions.map((extension) => ({
            extension,
            permissions: validateManifest(extension.manifest),
        }))
        const { order } = resolveDependencies(validated.map(({ extension }) => extension.manifest))
        const byId = new Map(validated.map((value) => [value.extension.manifest.id, value]))
        for (const manifest of order) {
            const value = byId.get(manifest.id)
            if (!value) throw new Error(`No implementation for extension: ${manifest.id}`)
            this.runtimes.set(manifest.id, {
                extension: value.extension,
                permissions: value.permissions,
                lifecycle: new ExtensionLifecycle("enabled"),
                storage: createExtensionStorage(this.storage, manifest.id),
                state: "enabled",
                transition: Promise.resolve(),
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
        if (runtime.activation) return runtime.activation
        if (
            runtime.state === "failed" ||
            runtime.state === "disposed" ||
            runtime.state === "disabled"
        ) {
            throw new Error(`Extension is not enabled: ${extensionId}`)
        }

        const activation = this.enqueue(runtime, async () => {
            if (runtime.state === "active") return
            if (
                runtime.state === "failed" ||
                runtime.state === "disposed" ||
                runtime.state === "disabled"
            ) {
                throw new Error(`Extension is not enabled: ${extensionId}`)
            }
            await this.performActivation(runtime)
        })
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
        return this.enqueue(runtime, async () => {
            if (runtime.state === "disposed" || runtime.state === "disabled") return
            runtime.state = "disabled"
            await runtime.lifecycle.dispose()
            this.contributions.disposeExtension(extensionId)
        })
    }

    enable(extensionId: string): Promise<void> {
        const runtime = this.requireRuntime(extensionId)
        return this.enqueue(runtime, async () => {
            if (this.disposing || runtime.state === "disposed") {
                throw new Error(`Extension host is disposing: ${extensionId}`)
            }
            if (runtime.state !== "disabled" && runtime.state !== "failed") return
            runtime.lifecycle = new ExtensionLifecycle("enabled")
            runtime.state = "enabled"
            runtime.error = undefined
        })
    }

    dispose(): Promise<void> {
        if (this.disposal) return this.disposal
        this.disposing = true
        const runtimes = [...this.runtimes.values()]
        this.disposal = Promise.allSettled([
            this.documentService.closeAll(),
            Promise.all(
                runtimes.map((runtime) =>
                    this.enqueue(runtime, async () => {
                        runtime.state = "disposed"
                        await runtime.lifecycle.dispose()
                        this.contributions.disposeExtension(runtime.extension.manifest.id)
                    }),
                ),
            ),
        ]).then((results) => {
            this.contributions.dispose()
            const rejected = results.find(
                (result): result is PromiseRejectedResult => result.status === "rejected",
            )
            if (rejected) throw rejected.reason
        })
        return this.disposal
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
        try {
            for (const dependency of Object.keys(manifest.dependencies ?? {}))
                await this.activate(dependency)
            runtime.state = "activating"
            const registries = this.contributions.forExtension(
                manifest.id,
                runtime.permissions,
                runtime.storage,
            )
            const context: ExtensionContext = {
                extension: extensionInfo(manifest),
                permissions: runtime.permissions,
                commands: registries.commands,
                views: registries.views,
                settings: registries.settings,
                documents: registries.documents,
                storage: guardExtensionCapability(runtime.storage, runtime.permissions, "storage"),
                notifications: guardExtensionCapability(
                    this.notifications,
                    runtime.permissions,
                    "notifications",
                ),
                lifecycle: runtime.lifecycle,
            }
            await runtime.extension.activate(context)
            runtime.state = "active"
        } catch (cause) {
            runtime.error = new ExtensionActivationError(manifest.id, cause)
            runtime.state = "failed"
            await runtime.lifecycle.dispose()
            this.contributions.disposeExtension(manifest.id)
            this.notifications.error(`Extension ${manifest.name} failed to activate.`)
            throw runtime.error
        }
    }

    private enqueue(runtime: ExtensionRuntime, operation: () => Promise<void>): Promise<void> {
        const transition = runtime.transition.then(operation, operation)
        runtime.transition = transition.catch(() => undefined)
        return transition
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
    return keybinding.map((part) => part.trim().toLowerCase()).join("+")
}
