import {
    ExtensionLifecycle,
    assertNamespacedId,
    belongsToExtension,
    extensionInfo,
    type AppExtension,
    type ExtensionContext,
    type ExtensionManifest,
    type ExtensionStorage,
} from "../extension-api"
import { NotificationServiceImpl } from "../core/notifications"
import { createExtensionStorage, MemoryStorageBackend, type StorageBackend } from "../core/storage"
import { ContributionRegistry } from "./contribution-registry"
import { resolveDependencies } from "./dependency-resolution"
import { ExtensionActivationError, type LifecycleRecord } from "./lifecycle"

export interface ExtensionHostOptions {
    readonly extensions: readonly AppExtension[]
    readonly storage?: StorageBackend
    readonly notifications?: NotificationServiceImpl
}

interface ExtensionRuntime {
    readonly extension: AppExtension
    lifecycle: ExtensionLifecycle
    readonly storage: ExtensionStorage
    state: LifecycleRecord["state"]
    error?: ExtensionActivationError
    activation?: Promise<void>
}

export class ExtensionHost {
    readonly contributions = new ContributionRegistry()
    readonly notifications: NotificationServiceImpl
    private readonly runtimes = new Map<string, ExtensionRuntime>()
    private readonly storage: StorageBackend
    constructor(options: ExtensionHostOptions) {
        this.storage = options.storage ?? new MemoryStorageBackend()
        this.notifications = options.notifications ?? new NotificationServiceImpl()
        const manifests = options.extensions.map((extension) => {
            validateManifest(extension.manifest)
            return extension.manifest
        })
        const { order } = resolveDependencies(manifests)
        const byId = new Map(
            options.extensions.map((extension) => [extension.manifest.id, extension]),
        )
        for (const manifest of order) {
            const extension = byId.get(manifest.id)
            if (!extension) throw new Error(`No implementation for extension: ${manifest.id}`)
            this.runtimes.set(manifest.id, {
                extension,
                lifecycle: new ExtensionLifecycle("enabled"),
                storage: createExtensionStorage(this.storage, manifest.id),
                state: "enabled",
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

        runtime.activation = this.performActivation(runtime)
        try {
            await runtime.activation
        } finally {
            runtime.activation = undefined
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

    async disable(extensionId: string): Promise<void> {
        const runtime = this.requireRuntime(extensionId)
        runtime.state = "disabled"
        await runtime.lifecycle.dispose()
        this.contributions.disposeExtension(extensionId)
    }

    async enable(extensionId: string): Promise<void> {
        const runtime = this.requireRuntime(extensionId)
        if (runtime.state !== "disabled" && runtime.state !== "failed") return
        runtime.lifecycle = new ExtensionLifecycle("enabled")
        runtime.state = "enabled"
        runtime.error = undefined
    }

    async dispose(): Promise<void> {
        const runtimes = [...this.runtimes.values()]
        await Promise.all(
            runtimes.map(async (runtime) => {
                runtime.state = "disposed"
                await runtime.lifecycle.dispose()
                this.contributions.disposeExtension(runtime.extension.manifest.id)
            }),
        )
        this.contributions.dispose()
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
            const registries = this.contributions.forExtension(manifest.id)
            const context: ExtensionContext = {
                extension: extensionInfo(manifest),
                commands: registries.commands,
                views: registries.views,
                settings: registries.settings,
                documents: registries.documents,
                storage: runtime.storage,
                notifications: this.notifications,
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

    private requireRuntime(extensionId: string): ExtensionRuntime {
        const runtime = this.runtimes.get(extensionId)
        if (!runtime) throw new Error(`Unknown extension: ${extensionId}`)
        return runtime
    }
}

function validateManifest(manifest: ExtensionManifest): void {
    assertNamespacedId(manifest.id, "extension")
    for (const field of ["name", "version", "engine", "entry"] as const) {
        if (!manifest[field].trim())
            throw new Error(`Extension ${manifest.id} has an empty ${field}`)
    }
    for (const dependency of Object.keys(manifest.dependencies ?? {})) {
        assertNamespacedId(dependency, "dependency")
    }
    for (const event of manifest.activationEvents) {
        if (event.type === "onCommand" || event.type === "onView") {
            assertNamespacedId(
                event.type === "onCommand" ? event.commandId : event.viewId,
                event.type,
            )
            if (
                !belongsToExtension(
                    event.type === "onCommand" ? event.commandId : event.viewId,
                    manifest.id,
                )
            ) {
                throw new Error(`Activation event is outside extension namespace ${manifest.id}`)
            }
        }
    }
    const contributions = manifest.contributes
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
    }
}
