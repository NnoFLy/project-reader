import type { AppExtension, DocumentAdapter, ExtensionManifest } from "../../extension-api"
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
function viewerCapabilities(store: typeof libraryStore, request: RelinkRequestState) {
    const builtinViewerLibraryCapability: ViewerLibraryCapability = {
        get nodes() {
            return readonlyRecord(store.nodes) as ViewerLibraryCapability["nodes"]
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
        getUserNotes: (bookId) => store.getUserNotes(bookId),
        getBookmarks: () => store.getBookmarks(),
        getPreviewUrl: (id) => store.getPreviewUrl(id),
        getFolderPath: (id) => store.getFolderPath(id),
    }

    const builtinViewerLibraryMutations: ViewerLibraryMutationCapability = {
        releaseFileUrl: (id, url) => store.revokeFileUrl(id, url),
        setActiveFileId: (id) => {
            store.activeFileId = id
        },
        serializeBookMutation: (id, mutation) => store.serializeBookMutation(id, mutation),
        serializeMetadataMutation: (mutation) => store.serializeMetadataMutation(mutation),
        saveIndexedTexts: (id, records, generation) =>
            store.saveIndexedTexts(id, records as never[], generation),
        putUserNote: (note) => store.putUserNote(note),
        deleteUserNote: (id) => store.deleteUserNote(id),
        putBookmark: (bookmark) => store.putBookmark(bookmark),
        deleteBookmark: (id) => store.deleteBookmark(id),
        deleteBookmarks: (ids) => store.deleteBookmarks(ids),
        revokePreviewUrl: (id) => store.revokePreviewUrl(id),
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
            return readonlyRecord(store.nodes) as ViewerFileCapability["nodes"]
        },
        get isLockedMap() {
            return readonlyRecord(store.isLockedMap) as ViewerFileCapability["isLockedMap"]
        },
        getFileUrl: (id) => store.getFileUrl(id),
        restoreFileAccess: (id) => store.restoreFileAccess(id),
        requestRelink: (id) => request.request(id),
        waitForRelink: (id) => store.waitForRelink(id),
        releaseFileUrl: (id, url) => store.revokeFileUrl(id, url),
        getContentGeneration: (id) => store.getContentGeneration(id),
        isCurrentContent: (id, generation) => store.isCurrentContent(id, generation),
        isCurrentFileUrl: (id, url, generation) => store.isCurrentFileUrl(id, url, generation),
        clearForwardHistory: () => store.clearForwardHistory(),
    }

    return {
        files: builtinViewerFileCapability,
        library: builtinViewerLibraryCapability,
        mutations: builtinViewerLibraryMutations,
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
    const loader = createServiceLoader(documentCapability)
    const extensions: readonly AppExtension[] = [
        {
            manifest: BUILTIN_MANIFESTS[0],
            activate: async (context) => {
                store = await activateLibrary(
                    context,
                    context.host?.prompt?.promptStore,
                    () => {
                        clearViewerDocuments()
                        clearLibraryDocuments()
                    },
                    documentCapability,
                    request,
                )
            },
        },
        { manifest: BUILTIN_MANIFESTS[1], activate: activatePrompt },
        {
            manifest: BUILTIN_MANIFESTS[2],
            activate: (context) => {
                const capabilities = viewerCapabilities(store, request)
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
