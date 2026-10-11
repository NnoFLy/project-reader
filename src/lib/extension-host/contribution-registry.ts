import {
    assertNamespacedId,
    belongsToExtension,
    type CommandRegistry,
    type Disposable,
    type DocumentAdapter,
    type DocumentAdapterRegistry,
    type RegisteredDocumentAdapter,
    type RegisteredView,
    type SettingsRegistry,
    type ViewContribution,
    type ViewRegistry,
    type ViewSlot,
} from "../extension-api"
import { DocumentAdapterRegistry as CoreDocumentAdapterRegistry } from "../core/documents"
import { CommandRegistryImpl } from "../core/commands"
import { SettingsRegistryImpl } from "../core/settings"
import type { DocumentAdapter as CoreDocumentAdapter } from "../document-model"

class ViewRegistryImpl implements ViewRegistry {
    private readonly views = new Map<string, RegisteredView>()
    private disposed = false

    constructor(private readonly extensionId: string) {}

    register(view: ViewContribution): Disposable {
        return this.add({ ...view, kind: "host" })
    }

    registerNative(view: import("../extension-api").NativeViewContribution): Disposable {
        return this.add(view)
    }

    get(viewId: string): RegisteredView | undefined {
        return this.views.get(viewId)
    }

    list(slot?: ViewSlot): readonly RegisteredView[] {
        return [...this.views.values()].filter((view) => !slot || view.slot === slot)
    }

    dispose(): void {
        this.disposed = true
        this.views.clear()
    }

    private add(
        view: ViewContribution & { kind: "native" | "host"; component?: unknown },
    ): Disposable {
        if (this.disposed) throw new Error(`View registry for ${this.extensionId} is disposed`)
        assertNamespacedId(view.id, "view")
        if (!belongsToExtension(view.id, this.extensionId)) {
            throw new Error(`View ${view.id} is outside extension namespace ${this.extensionId}`)
        }
        if (this.views.has(view.id)) throw new Error(`View is already registered: ${view.id}`)
        this.views.set(view.id, { ...view, extensionId: this.extensionId })
        let active = true
        return {
            dispose: () => {
                if (!active) return
                active = false
                this.views.delete(view.id)
            },
        }
    }
}

class DocumentAdapterRegistryImpl implements DocumentAdapterRegistry {
    private readonly adapters = new Map<string, RegisteredDocumentAdapter>()
    private disposed = false

    constructor(
        private readonly extensionId: string,
        private readonly coreRegistry: CoreDocumentAdapterRegistry,
    ) {}

    register(adapter: DocumentAdapter): Disposable {
        if (this.disposed) throw new Error(`Document registry for ${this.extensionId} is disposed`)
        assertNamespacedId(adapter.id, "adapter")
        if (!belongsToExtension(adapter.id, this.extensionId)) {
            throw new Error(
                `Adapter ${adapter.id} is outside extension namespace ${this.extensionId}`,
            )
        }
        if (
            !adapter.extensions.length ||
            adapter.extensions.some((value) => !value || value.startsWith("."))
        ) {
            throw new Error(`Adapter ${adapter.id} must declare file extensions`)
        }
        if (this.adapters.has(adapter.id))
            throw new Error(`Adapter is already registered: ${adapter.id}`)
        const registered = { ...adapter, extensionId: this.extensionId }
        const coreDisposable = this.coreRegistry.register(registered as CoreDocumentAdapter)
        this.adapters.set(adapter.id, registered)
        let active = true
        return {
            dispose: () => {
                if (!active) return
                active = false
                coreDisposable.dispose()
                if (this.adapters.get(adapter.id) === registered) this.adapters.delete(adapter.id)
            },
        }
    }

    get(adapterId: string): RegisteredDocumentAdapter | undefined {
        return this.adapters.get(adapterId)
    }

    findForExtension(extension: string): readonly RegisteredDocumentAdapter[] {
        const normalized = extension.toLowerCase().replace(/^\./, "")
        return [...this.adapters.values()].filter((adapter) =>
            adapter.extensions.some(
                (value) => value.toLowerCase().replace(/^\./, "") === normalized,
            ),
        )
    }

    list(): readonly RegisteredDocumentAdapter[] {
        return [...this.adapters.values()]
    }

    dispose(): void {
        if (this.disposed) return
        this.disposed = true
        for (const adapter of this.adapters.values()) this.coreRegistry.unregister(adapter.id)
        this.adapters.clear()
    }
}

export interface ExtensionRegistries {
    readonly commands: CommandRegistry
    readonly views: ViewRegistry
    readonly settings: SettingsRegistry
    readonly documents: DocumentAdapterRegistry
    dispose(): void
}

export class ContributionRegistry {
    private readonly registries = new Map<string, ExtensionRegistries>()

    constructor(
        private readonly coreDocumentAdapters: CoreDocumentAdapterRegistry = new CoreDocumentAdapterRegistry(),
    ) {}

    forExtension(extensionId: string): ExtensionRegistries {
        const existing = this.registries.get(extensionId)
        if (existing) return existing
        const commands = new CommandRegistryImpl(extensionId)
        const views = new ViewRegistryImpl(extensionId)
        const settings = new SettingsRegistryImpl(extensionId)
        const documents = new DocumentAdapterRegistryImpl(extensionId, this.coreDocumentAdapters)
        const registries: ExtensionRegistries = {
            commands,
            views,
            settings,
            documents,
            dispose: () => {
                commands.dispose()
                views.dispose()
                settings.dispose()
                documents.dispose()
                this.registries.delete(extensionId)
            },
        }
        this.registries.set(extensionId, registries)
        return registries
    }

    listCommands(): readonly import("../extension-api").RegisteredCommand[] {
        return [...this.registries.values()].flatMap((value) => value.commands.list())
    }

    listViews(slot?: ViewSlot): readonly RegisteredView[] {
        return [...this.registries.values()].flatMap((value) => value.views.list(slot))
    }

    listAdapters(): readonly RegisteredDocumentAdapter[] {
        return [...this.registries.values()].flatMap((value) => value.documents.list())
    }

    disposeExtension(extensionId: string): void {
        this.registries.get(extensionId)?.dispose()
    }

    dispose(): void {
        for (const registry of this.registries.values()) registry.dispose()
    }
}
