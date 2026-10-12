import type { AppExtension, DocumentAdapter, ExtensionManifest } from "../../extension-api"
import { DocumentService } from "../../core/documents"
import { getDocumentExtension, type DocumentSource, type OpenedDocument } from "$lib/document-model"
import { ExtensionHost, type ExtensionHostOptions } from "../../extension-host"
import { getViewerDocumentLoader, installViewerDocumentService } from "./viewer/viewerDocument"
import { activateLibrary, libraryStore } from "./library"
import { activatePrompt } from "./prompt"
import { activateSettings } from "./settings"
import { activateViewer, type ViewerFileCapability } from "./viewer"

// The built-in library owns file handles, object URLs, and relink state. Expose that
// singleton through the viewer's narrow host capability instead of creating another store.
const builtinViewerFileCapability: ViewerFileCapability = {
    get nodes() {
        return libraryStore.nodes as ViewerFileCapability["nodes"]
    },
    get fileUrls() {
        return libraryStore.fileUrls
    },
    get isLockedMap() {
        return libraryStore.isLockedMap
    },
    getFileUrl: (id) => libraryStore.getFileUrl(id),
    restoreFileAccess: (id) => libraryStore.restoreFileAccess(id),
    waitForRelink: (id) => libraryStore.waitForRelink(id),
    revokeFileUrl: (id, url) => libraryStore.revokeFileUrl(id, url),
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
): ExtensionManifest => ({
    id,
    name,
    version: "0.0.1",
    engine: ">=0.0.1",
    entry: `builtin/${id.replace("builtin.", "")}`,
    activationEvents,
    permissions: ["commands", "documents", "notifications", "settings", "storage", "views"],
    contributes,
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
    manifest("builtin.viewer", "Viewer", [{ type: "startup" }], {
        views: [{ id: "viewer.reader", slot: "viewer.toolbar", title: "Viewer" }],
    }),
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
        activate: activateLibrary,
    },
    {
        manifest: BUILTIN_MANIFESTS[1],
        activate: activatePrompt,
    },
    {
        manifest: BUILTIN_MANIFESTS[2],
        activate: (context) => activateViewer(context, builtinViewerFileCapability),
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
}

export { getViewerDocumentLoader as getBuiltinDocumentLoader }
export { ExtensionHost }
