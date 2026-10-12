import {
    assertNamespacedId,
    belongsToExtension,
    type CommandRegistry,
    type Disposable,
    type KeybindingContribution,
    type RegisteredCommand,
    type RegisteredSetting,
    type DocumentAdapter,
    type DocumentAdapterRegistry,
    type RegisteredDocumentAdapter,
    type RegisteredView,
    type SettingsRegistry,
    type ViewContribution,
    type ViewRegistry,
    type ViewSlot,
    createPermissionSet,
    type PermissionSet,
} from "../extension-api"
import { DocumentAdapterRegistry as CoreDocumentAdapterRegistry } from "../core/documents"
import { CommandRegistryImpl } from "../core/commands"
import { SettingsRegistryImpl, type SettingsStore } from "../core/settings"
import type { DocumentAdapter as CoreDocumentAdapter } from "../document-model"

class ViewRegistryImpl implements ViewRegistry {
    private readonly views = new Map<string, RegisteredView>()
    private disposed = false

    constructor(
        private readonly extensionId: string,
        private readonly permissions: PermissionSet,
    ) {}

    register(view: ViewContribution): Disposable {
        this.assertUsable()
        this.permissions.require("views")
        return this.add({ ...view, kind: "host" })
    }

    registerNative(view: import("../extension-api").NativeViewContribution): Disposable {
        this.assertUsable()
        this.permissions.require("views")
        return this.add(view)
    }

    get(viewId: string): RegisteredView | undefined {
        this.permissions.require("views")
        return this.views.get(viewId)
    }

    list(slot?: ViewSlot): readonly RegisteredView[] {
        this.permissions.require("views")
        return this.listForHost(slot)
    }

    listForHost(slot?: ViewSlot): readonly RegisteredView[] {
        return [...this.views.values()].filter((view) => !slot || view.slot === slot)
    }

    dispose(): void {
        this.disposed = true
        this.views.clear()
    }

    private add(
        view: ViewContribution & { kind: "native" | "host"; component?: unknown },
    ): Disposable {
        this.assertUsable()
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

    private assertUsable(): void {
        if (this.disposed) throw new Error(`View registry for ${this.extensionId} is disposed`)
    }
}

class DocumentAdapterRegistryImpl implements DocumentAdapterRegistry {
    private readonly adapters = new Map<string, RegisteredDocumentAdapter>()
    private disposed = false

    constructor(
        private readonly extensionId: string,
        private readonly coreRegistry: CoreDocumentAdapterRegistry,
        private readonly permissions: PermissionSet,
    ) {}

    register(adapter: DocumentAdapter): Disposable {
        if (this.disposed) throw new Error(`Document registry for ${this.extensionId} is disposed`)
        this.permissions.require("documents")
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
        this.permissions.require("documents")
        return this.adapters.get(adapterId)
    }

    findForExtension(extension: string): readonly RegisteredDocumentAdapter[] {
        this.permissions.require("documents")
        const normalized = extension.toLowerCase().replace(/^\./, "")
        return [...this.adapters.values()].filter((adapter) =>
            adapter.extensions.some(
                (value) => value.toLowerCase().replace(/^\./, "") === normalized,
            ),
        )
    }

    list(): readonly RegisteredDocumentAdapter[] {
        this.permissions.require("documents")
        return this.listForHost()
    }

    listForHost(): readonly RegisteredDocumentAdapter[] {
        return [...this.adapters.values()]
    }

    dispose(): void {
        if (this.disposed) return
        this.disposed = true
        for (const adapter of this.adapters.values()) this.coreRegistry.unregister(adapter.id)
        this.adapters.clear()
    }
}

class PermissionedCommandRegistry implements CommandRegistry {
    constructor(
        private readonly delegate: CommandRegistry & Disposable,
        private readonly permissions: PermissionSet,
    ) {}

    register(command: import("../extension-api").CommandContribution): Disposable {
        this.permissions.require("commands")
        return this.delegate.register(command)
    }

    registerKeybinding(binding: KeybindingContribution): Disposable {
        this.permissions.require("commands")
        return this.delegate.registerKeybinding(binding)
    }

    get(commandId: string): RegisteredCommand | undefined {
        this.permissions.require("commands")
        return this.delegate.get(commandId)
    }

    list(): readonly RegisteredCommand[] {
        this.permissions.require("commands")
        return this.delegate.list()
    }

    execute(commandId: string, payload?: unknown, context?: unknown): Promise<unknown> {
        this.permissions.require("commands")
        return this.delegate.execute(commandId, payload, context)
    }

    dispose(): void {
        this.delegate.dispose()
    }
}

class PermissionedSettingsRegistry implements SettingsRegistry {
    constructor(
        private readonly delegate: SettingsRegistry & Disposable,
        private readonly permissions: PermissionSet,
    ) {}

    register<T>(setting: import("../extension-api").SettingContribution<T>): Disposable {
        this.permissions.require("settings")
        return this.delegate.register(setting)
    }

    get<T = unknown>(settingId: string): RegisteredSetting<T> | undefined {
        this.permissions.require("settings")
        return this.delegate.get(settingId)
    }

    list(): readonly RegisteredSetting[] {
        this.permissions.require("settings")
        return this.delegate.list()
    }

    getValue<T>(settingId: string): Promise<T> {
        this.permissions.require("settings")
        return this.delegate.getValue(settingId)
    }

    setValue<T>(settingId: string, value: T): Promise<void> {
        this.permissions.require("settings")
        return this.delegate.setValue(settingId, value)
    }

    dispose(): void {
        this.delegate.dispose()
    }
}

export interface ExtensionRegistries {
    readonly commands: CommandRegistry
    readonly views: ViewRegistry
    readonly settings: SettingsRegistry
    readonly documents: DocumentAdapterRegistry
    dispose(): void
}

interface InternalExtensionRegistries extends ExtensionRegistries {
    readonly hostCommands: CommandRegistry
    readonly hostViews: ViewRegistryImpl
    readonly hostDocuments: DocumentAdapterRegistryImpl
}

// Direct registry construction is retained for tests and host integrations; omitted
// permissions must not grant an extension any capability.
const defaultPermissions = createPermissionSet([])

export class ContributionRegistry {
    private readonly registries = new Map<string, InternalExtensionRegistries>()

    constructor(
        private readonly coreDocumentAdapters: CoreDocumentAdapterRegistry = new CoreDocumentAdapterRegistry(),
    ) {}

    forExtension(
        extensionId: string,
        permissions: PermissionSet = defaultPermissions,
        settingsStore?: SettingsStore,
    ): ExtensionRegistries {
        const existing = this.registries.get(extensionId)
        if (existing) return existing
        const hostCommands = new CommandRegistryImpl(extensionId)
        const hostViews = new ViewRegistryImpl(extensionId, permissions)
        const hostSettings = new SettingsRegistryImpl(extensionId, settingsStore)
        const hostDocuments = new DocumentAdapterRegistryImpl(
            extensionId,
            this.coreDocumentAdapters,
            permissions,
        )
        const commands = new PermissionedCommandRegistry(hostCommands, permissions)
        const settings = new PermissionedSettingsRegistry(hostSettings, permissions)
        const registries: InternalExtensionRegistries = {
            commands,
            views: hostViews,
            settings,
            documents: hostDocuments,
            hostCommands,
            hostViews,
            hostDocuments,
            dispose: () => {
                hostCommands.dispose()
                hostViews.dispose()
                hostSettings.dispose()
                hostDocuments.dispose()
                this.registries.delete(extensionId)
            },
        }
        this.registries.set(extensionId, registries)
        return registries
    }

    listCommands(): readonly import("../extension-api").RegisteredCommand[] {
        return [...this.registries.values()].flatMap((value) => value.hostCommands.list())
    }

    listViews(slot?: ViewSlot): readonly RegisteredView[] {
        return [...this.registries.values()].flatMap((value) => value.hostViews.listForHost(slot))
    }

    listAdapters(): readonly RegisteredDocumentAdapter[] {
        return [...this.registries.values()].flatMap((value) => value.hostDocuments.listForHost())
    }

    disposeExtension(extensionId: string): void {
        this.registries.get(extensionId)?.dispose()
    }

    dispose(): void {
        for (const registry of this.registries.values()) registry.dispose()
    }
}
