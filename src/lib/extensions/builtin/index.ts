import type { AppExtension, DocumentAdapter, ExtensionManifest } from "../../extension-api"
import { DocumentService } from "../../core/documents"
import { getDocumentExtension, type DocumentSource, type OpenedDocument } from "$lib/document-model"
import { ExtensionHost, type ExtensionHostOptions } from "../../extension-host"
import { getViewerDocumentLoader, installViewerDocumentService } from "./viewer/viewerDocument"
import { activateLibrary, libraryStore, requestLibraryRelink, LibraryRelinkHost } from "./library"
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
const builtinViewerLibraryCapability: ViewerLibraryCapability = {
    get nodes() {
        return readonlyRecord(libraryStore.nodes) as ViewerLibraryCapability["nodes"]
    },
    get allFiles() {
        return immutableSnapshot(libraryStore.allFiles) as ViewerLibraryCapability["allFiles"]
    },
    get isLockedMap() {
        return readonlyRecord(libraryStore.isLockedMap) as ViewerLibraryCapability["isLockedMap"]
    },
    get initialized() {
        return libraryStore.initialized
    },
    get isDisposed() {
        return libraryStore.isDisposed
    },
    getFileUrl: (id) => libraryStore.getFileUrl(id),
    getContentGeneration: (id) => libraryStore.getContentGeneration(id),
    isCurrentContent: (id, generation) => libraryStore.isCurrentContent(id, generation),
    isCurrentFileUrl: (id, url, generation) => libraryStore.isCurrentFileUrl(id, url, generation),
    onNodesDeleted: (listener) => libraryStore.onNodesDeleted(listener),
    onNodesDeleting: (listener) => libraryStore.onNodesDeleting(listener),
    onNodeRelinked: (listener) => libraryStore.onNodeRelinked(listener),
    onContentRestored: (listener) => libraryStore.onContentRestored(listener),
    onNodeInvalidated: (listener) => libraryStore.onNodeInvalidated(listener),
    isNodeDeleting: (id) => libraryStore.isNodeDeleting(id),
    getIndexedTexts: (bookId) => libraryStore.getIndexedTexts(bookId),
    getUserNotes: (bookId) => libraryStore.getUserNotes(bookId),
    getBookmarks: () => libraryStore.getBookmarks(),
    getPreviewUrl: (id) => libraryStore.getPreviewUrl(id),
    getFolderPath: (id) => libraryStore.getFolderPath(id),
}

const builtinViewerLibraryMutations: ViewerLibraryMutationCapability = {
    releaseFileUrl: (id, url) => libraryStore.revokeFileUrl(id, url),
    setActiveFileId: (id) => {
        libraryStore.activeFileId = id
    },
    serializeBookMutation: (id, mutation) => libraryStore.serializeBookMutation(id, mutation),
    serializeMetadataMutation: (mutation) => libraryStore.serializeMetadataMutation(mutation),
    saveIndexedTexts: (id, records, generation) =>
        libraryStore.saveIndexedTexts(id, records as never[], generation),
    putUserNote: (note) => libraryStore.putUserNote(note),
    deleteUserNote: (id) => libraryStore.deleteUserNote(id),
    putBookmark: (bookmark) => libraryStore.putBookmark(bookmark),
    deleteBookmark: (id) => libraryStore.deleteBookmark(id),
    deleteBookmarks: (ids) => libraryStore.deleteBookmarks(ids),
    revokePreviewUrl: (id) => libraryStore.revokePreviewUrl(id),
    invalidatePreview: (id) => libraryStore.invalidatePreview(id),
    updateFile: (id, changes, ...options) =>
        libraryStore.updateFile(
            id,
            changes,
            options[0] as boolean | undefined,
            options[1] as number | undefined,
        ),
    pushForwardHistory: (id) => libraryStore.pushForwardHistory(id),
    clearForwardHistory: () => libraryStore.clearForwardHistory(),
}

const builtinViewerFileCapability: ViewerFileCapability = {
    get nodes() {
        return readonlyRecord(libraryStore.nodes) as ViewerFileCapability["nodes"]
    },
    get isLockedMap() {
        return readonlyRecord(libraryStore.isLockedMap) as ViewerFileCapability["isLockedMap"]
    },
    getFileUrl: (id) => libraryStore.getFileUrl(id),
    restoreFileAccess: (id) => libraryStore.restoreFileAccess(id),
    requestRelink: (id) => requestLibraryRelink(id),
    waitForRelink: (id) => libraryStore.waitForRelink(id),
    releaseFileUrl: (id, url) => libraryStore.revokeFileUrl(id, url),
    getContentGeneration: (id) => libraryStore.getContentGeneration(id),
    isCurrentContent: (id, generation) => libraryStore.isCurrentContent(id, generation),
    isCurrentFileUrl: (id, url, generation) => libraryStore.isCurrentFileUrl(id, url, generation),
    clearForwardHistory: () => libraryStore.clearForwardHistory(),
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
        views: [{ id: "library.page", slot: "workbench.panel", title: "Library" }],
    }),
    manifest("builtin.prompt", "Prompt", [{ type: "startup" }], {
        views: [{ id: "prompt.palette", slot: "prompt.result", title: "Command palette" }],
    }),
    manifest(
        "builtin.viewer",
        "Viewer",
        [{ type: "startup" }],
        { views: [{ id: "viewer.reader", slot: "viewer.toolbar", title: "Viewer" }] },
        { "builtin.library": "*" },
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

const builtinExtensions: readonly AppExtension[] = [
    {
        manifest: BUILTIN_MANIFESTS[0],
        activate: (context) =>
            activateLibrary(context, context.host?.prompt?.promptStore, () =>
                installViewerDocumentService(undefined),
            ),
    },
    {
        manifest: BUILTIN_MANIFESTS[1],
        activate: activatePrompt,
    },
    {
        manifest: BUILTIN_MANIFESTS[2],
        activate: (context) =>
            activateViewer(
                context,
                builtinViewerFileCapability,
                builtinViewerLibraryCapability,
                builtinViewerLibraryMutations,
                undefined,
                LibraryRelinkHost,
            ),
    },
    {
        manifest: BUILTIN_MANIFESTS[3],
        activate: activateSettings,
    },
    {
        manifest: BUILTIN_MANIFESTS[4],
        activate: activatePdf,
    },
]

export function createBuiltinHost(
    options: Omit<ExtensionHostOptions, "extensions"> = {},
): ExtensionHost {
    return new ExtensionHost({ ...options, extensions: builtinExtensions })
}

/** Install the host-owned document capability used by the built-in viewer. */
export function installBuiltinDocumentService(
    documentService: DocumentService,
    activateForDocumentType: (extension: string) => Promise<void>,
): void {
    const documentCapability = {
        async open(source: DocumentSource, signal?: AbortSignal): Promise<OpenedDocument> {
            const extension = getDocumentExtension(source.name)
            if (extension) await activateForDocumentType(extension)
            return documentService.open(source, signal)
        },
        close: (document: OpenedDocument) => documentService.close(document),
    }
    installViewerDocumentService(documentCapability)
    installDocumentService(documentCapability)
}

export { getViewerDocumentLoader as getBuiltinDocumentLoader }
export { ExtensionHost }
