import type {
    AppExtension,
    DocumentAdapter,
    ExtensionManifest,
    ProviderAvailability,
} from "../../extension-api"
import { DocumentService } from "../../core/documents"
import { getDocumentExtension, type DocumentSource, type OpenedDocument } from "$lib/document-model"
import { ExtensionHost, type ExtensionHostOptions } from "../../extension-host"
import {
    createServiceLoader,
    getViewerDocumentLoader,
    installViewerDocumentService,
} from "./viewer/viewerDocument"
import { activateLibrary, libraryStore, LibraryRelinkHost } from "./library"
import { RelinkRequestState } from "./library/state/relinkRequest.svelte"
import { installDocumentService } from "./library/state/libraryStore.svelte"
import { activatePrompt } from "./prompt"
import { activateSettings } from "./settings"
import {
    activateViewer,
    type ViewerFileCapability,
    type ViewerLibraryCapability,
    type ViewerLibraryMutationCapability,
} from "./viewer"

const immutableSnapshot = (value: unknown): unknown => {
    if (!value || typeof value !== "object") return value
    if (Array.isArray(value)) return Object.freeze(value.map(immutableSnapshot))
    return Object.freeze(
        Object.fromEntries(
            Object.entries(value).map(([key, entry]) => [key, immutableSnapshot(entry)]),
        ),
    )
}

const readonlyRecord = <T extends object>(record: T): Readonly<T> =>
    immutableSnapshot(record) as Readonly<T>

// The built-in library owns file handles, object URLs, and relink state. Expose only the
// viewer's read capability and its explicitly typed mutation operations.
function viewerCapabilities(
    getStore: () => typeof libraryStore,
    providers: ProviderAvailability,
    request: RelinkRequestState,
) {
    type Store = typeof libraryStore
    const subscriptions = new Set<(available: boolean) => void>()
    const subscriptionMethods = new Set([
        "onNodesDeleted",
        "onNodesDeleting",
        "onNodeRelinked",
        "onContentRestored",
        "onNodeInvalidated",
    ])
    const urlOwners = new Map<string, Store>()
    const previewOwners = new Map<string, { owner: Store; id: string; leases: number }>()
    const providerSubscription = providers.onDidChange((provider) => {
        if (provider.extensionId === "builtin.library")
            for (const rebind of subscriptions) rebind(provider.state === "active")
    })
    // Capabilities keep their identity while the owning Library store is replaced.
    const store = new Proxy({} as Store, {
        get: (_, key: keyof Store) => {
            const target = getStore()
            if (key === "isDisposed")
                return providers.get("builtin.library")?.state !== "active" || target.isDisposed
            const value = target[key]
            if (typeof value !== "function") return value
            if (subscriptionMethods.has(key))
                return (listener: (...args: unknown[]) => void) => {
                    let stop: (() => void) | undefined
                    const rebind = (available: boolean) => {
                        stop?.()
                        stop = undefined
                        if (!available) return
                        const owner = getStore()
                        const lifetime = providers.get("builtin.library")!.signal
                        const subscribe = owner[key] as (
                            callback: (...args: unknown[]) => void,
                        ) => () => void
                        stop = subscribe.call(owner, (...args) => {
                            if (!lifetime.aborted && getStore() === owner) listener(...args)
                        })
                    }
                    subscriptions.add(rebind)
                    rebind(providers.get("builtin.library")?.state === "active")
                    return () => {
                        stop?.()
                        subscriptions.delete(rebind)
                    }
                }
            if (key === "getPreviewUrl")
                return async (id: string) => {
                    const lifetime = providers.get("builtin.library")!.signal
                    lifetime.throwIfAborted()
                    const url = await target.getPreviewUrl(id)
                    if (lifetime.aborted) {
                        if (url && target.previewUrls[id] === url) target.revokePreviewUrl(id)
                        lifetime.throwIfAborted()
                    }
                    if (url) {
                        const existing = previewOwners.get(url)
                        previewOwners.set(url, {
                            owner: target,
                            id,
                            leases: (existing?.leases ?? 0) + 1,
                        })
                    }
                    return url
                }
            if (key === "getFileUrl" || key === "restoreFileAccess")
                return async (id: string) => {
                    const lifetime = providers.get("builtin.library")!.signal
                    lifetime.throwIfAborted()
                    const url = await target[key](id)
                    if (lifetime.aborted) {
                        if (url) target.revokeFileUrl(id, url)
                        lifetime.throwIfAborted()
                    }
                    if (url) urlOwners.set(url, target)
                    return url
                }
            return value.bind(target)
        },
        set: (_, key: keyof Store, value) => Reflect.set(getStore(), key, value),
    })
    const releaseFileUrl = (id: string, url?: string) => {
        const owner = (url && urlOwners.get(url)) || getStore()
        if (url) urlOwners.delete(url)
        return owner.revokeFileUrl(id, url)
    }
    const fenceMutation = <T>(mutation: () => Promise<T>) => {
        const lifetime = providers.get("builtin.library")!.signal
        return () => {
            lifetime.throwIfAborted()
            return mutation()
        }
    }
    // Reading operations capture immutable node identity. Repeated capability reads must
    // retain each unchanged node, not create a fresh identity on every access.
    const nodeSnapshots = new Map<string, { source: string; node: unknown }>()
    const snapshotNodes = () =>
        Object.fromEntries(
            Object.entries(store.nodes).map(([id, node]) => {
                const source = JSON.stringify(node)
                let snapshot = nodeSnapshots.get(id)
                if (!snapshot || snapshot.source !== source) {
                    snapshot = { source, node: immutableSnapshot(node) }
                    nodeSnapshots.set(id, snapshot)
                }
                return [id, snapshot.node]
            }),
        )
    const builtinViewerLibraryCapability: ViewerLibraryCapability = {
        get nodes() {
            return snapshotNodes() as ViewerLibraryCapability["nodes"]
        },
        get allFiles() {
            return immutableSnapshot(store.allFiles) as ViewerLibraryCapability["allFiles"]
        },
        get isLockedMap() {
            return readonlyRecord(store.isLockedMap) as ViewerLibraryCapability["isLockedMap"]
        },
        get initialized() {
            return store.initialized
        },
        get isDisposed() {
            return store.isDisposed
        },
        getFileUrl: (id) => store.getFileUrl(id),
        getContentGeneration: (id) => store.getContentGeneration(id),
        isCurrentContent: (id, generation) => store.isCurrentContent(id, generation),
        isCurrentFileUrl: (id, url, generation) => store.isCurrentFileUrl(id, url, generation),
        onNodesDeleted: (listener) => store.onNodesDeleted(listener),
        onNodesDeleting: (listener) => store.onNodesDeleting(listener),
        onNodeRelinked: (listener) => store.onNodeRelinked(listener),
        onContentRestored: (listener) => store.onContentRestored(listener),
        onNodeInvalidated: (listener) => store.onNodeInvalidated(listener),
        isNodeDeleting: (id) => store.isNodeDeleting(id),
        getIndexedTexts: (bookId) => store.getIndexedTexts(bookId),
        getPreviewUrl: (id) => store.getPreviewUrl(id),
        getFolderPath: (id) => store.getFolderPath(id),
    }

    const builtinViewerLibraryMutations: ViewerLibraryMutationCapability = {
        releaseFileUrl,
        setActiveFileId: (id) => {
            store.activeFileId = id
        },
        serializeBookMutation: (id, mutation) =>
            store.serializeBookMutation(id, fenceMutation(mutation)),
        serializeMetadataMutation: (mutation) =>
            store.serializeMetadataMutation(fenceMutation(mutation)),
        saveIndexedTexts: (id, records, generation) =>
            store.saveIndexedTexts(id, records as never[], generation),
        revokePreviewUrl: (id, url) => {
            const lease = url && previewOwners.get(url)
            if (!lease || lease.id !== id) return
            if (--lease.leases === 0) previewOwners.delete(url)
            if (lease.owner.previewUrls[id] === url) lease.owner.revokePreviewUrl(id)
        },
        invalidatePreview: (id) => store.invalidatePreview(id),
        updateFile: (id, changes, ...options) =>
            store.updateFile(
                id,
                changes,
                options[0] as boolean | undefined,
                options[1] as number | undefined,
            ),
        pushForwardHistory: (id) => store.pushForwardHistory(id),
        clearForwardHistory: () => store.clearForwardHistory(),
    }

    const builtinViewerFileCapability: ViewerFileCapability = {
        get nodes() {
            return snapshotNodes() as ViewerFileCapability["nodes"]
        },
        get isLockedMap() {
            return readonlyRecord(store.isLockedMap) as ViewerFileCapability["isLockedMap"]
        },
        getFileUrl: (id) => store.getFileUrl(id),
        restoreFileAccess: (id) => store.restoreFileAccess(id),
        requestRelink: (id) => request.request(id),
        waitForRelink: (id) => store.waitForRelink(id),
        releaseFileUrl,
        getContentGeneration: (id) => store.getContentGeneration(id),
        isCurrentContent: (id, generation) => store.isCurrentContent(id, generation),
        isCurrentFileUrl: (id, url, generation) => store.isCurrentFileUrl(id, url, generation),
        clearForwardHistory: () => store.clearForwardHistory(),
    }

    return {
        files: builtinViewerFileCapability,
        library: builtinViewerLibraryCapability,
        mutations: builtinViewerLibraryMutations,
        dispose: () => {
            providerSubscription.dispose()
            for (const rebind of subscriptions) rebind(false)
            subscriptions.clear()
        },
    }
}

const manifest = (
    id: string,
    name: string,
    activationEvents: ExtensionManifest["activationEvents"],
    contributes: ExtensionManifest["contributes"] = undefined,
    dependencies: ExtensionManifest["dependencies"] = undefined,
): ExtensionManifest => ({
    id,
    name,
    version: "0.0.1",
    engine: ">=0.0.1",
    entry: `builtin/${id.replace("builtin.", "")}`,
    activationEvents,
    permissions: ["commands", "documents", "notifications", "settings", "storage", "views"],
    contributes,
    dependencies,
})

// Keep the contribution itself format-neutral so importing the host does not import PDF.js.
// The adapter implementation is loaded only after the PDF extension is activated and opened.
const builtinPdfAdapter: DocumentAdapter = {
    id: "builtin.pdf.document",
    extensions: ["pdf"],
    mimeTypes: ["application/pdf"],
    async probe(source, signal) {
        const { pdfDocumentAdapter } = await import("./pdf")
        return pdfDocumentAdapter.probe(source, signal)
    },
    async open(source, signal) {
        const { pdfDocumentAdapter } = await import("./pdf")
        return pdfDocumentAdapter.open(source, signal)
    },
}

const activatePdf = (context: Parameters<AppExtension["activate"]>[0]): void => {
    context.documents.register(builtinPdfAdapter)
}

export const BUILTIN_MANIFESTS = [
    manifest("builtin.library", "Library", [{ type: "startup" }], {
        views: [
            { id: "library.page", slot: "workbench.panel", title: "Library" },
            { id: "library.status", slot: "host.status", title: "Library status" },
        ],
    }),
    manifest("builtin.prompt", "Prompt", [{ type: "startup" }], {
        views: [
            { id: "prompt.palette", slot: "prompt.result", title: "Command palette" },
            { id: "prompt.help", slot: "prompt.result", title: "Keyboard shortcuts" },
        ],
    }),
    manifest(
        "builtin.viewer",
        "Viewer",
        [{ type: "startup" }],
        {
            views: [
                { id: "viewer.reader", slot: "viewer.toolbar", title: "Viewer" },
                { id: "viewer.status", slot: "host.status", title: "Viewer status" },
            ],
        },
        { "builtin.library": "*", "builtin.settings": "*" },
    ),
    manifest("builtin.settings", "Settings", [{ type: "startup" }], {
        views: [{ id: "settings.panel", slot: "workbench.sidebar", title: "Settings" }],
        settings: [
            { id: "settings.theme", label: "Theme", defaultValue: "system" },
            { id: "settings.layout", label: "Layout", defaultValue: "scroll" },
        ],
    }),
    manifest("builtin.pdf", "PDF", [{ type: "onDocumentType", extension: "pdf" }], {
        adapters: [builtinPdfAdapter],
    }),
] as const

export function createBuiltinHost(
    options: Omit<ExtensionHostOptions, "extensions"> = {},
): ExtensionHost {
    const documentService = options.documentService ?? new DocumentService()
    let host: ExtensionHost
    let store: typeof libraryStore
    const request = new RelinkRequestState()
    const documentCapability = {
        async open(source: DocumentSource, signal?: AbortSignal): Promise<OpenedDocument> {
            const extension = getDocumentExtension(source.name)
            if (extension) await host.activateForDocumentType(extension)
            return documentService.open(source, signal)
        },
        close: (document: OpenedDocument) => documentService.close(document),
    }
    const clearViewerDocuments = installViewerDocumentService(documentCapability)
    const clearLibraryDocuments = installDocumentService(documentCapability)
    const loader = {
        ...createServiceLoader(documentCapability),
        requiredProviders(name: string): readonly string[] {
            const extension = getDocumentExtension(name)
            return BUILTIN_MANIFESTS.filter((manifest) =>
                manifest.activationEvents.some(
                    (event) => event.type === "onDocumentType" && event.extension === extension,
                ),
            ).map((manifest) => manifest.id)
        },
    }
    const extensions: readonly AppExtension[] = [
        {
            manifest: BUILTIN_MANIFESTS[0],
            activate: async (context) => {
                const activatedStore = await activateLibrary(
                    context,
                    context.host?.prompt?.promptStore,
                    () => {
                        clearViewerDocuments()
                        clearLibraryDocuments()
                    },
                    documentCapability,
                    request,
                )
                if (!context.lifecycle.isDisposed()) store = activatedStore
            },
        },
        { manifest: BUILTIN_MANIFESTS[1], activate: activatePrompt },
        {
            manifest: BUILTIN_MANIFESTS[2],
            activate: (context) => {
                const capabilities = viewerCapabilities(() => store, host.providers, request)
                context.lifecycle.onDispose(capabilities.dispose)
                const RelinkHost: typeof LibraryRelinkHost = (anchor, props) =>
                    LibraryRelinkHost(anchor, { ...props, store, request })
                return activateViewer(
                    context,
                    capabilities.files,
                    capabilities.library,
                    capabilities.mutations,
                    undefined,
                    RelinkHost,
                    loader,
                )
            },
        },
        { manifest: BUILTIN_MANIFESTS[3], activate: activateSettings },
        { manifest: BUILTIN_MANIFESTS[4], activate: activatePdf },
    ]
    host = new ExtensionHost({ ...options, documentService, extensions })
    return host
}

export { getViewerDocumentLoader as getBuiltinDocumentLoader }
export { ExtensionHost }
