import type {
    AppExtension,
    DocumentSource as ExtensionDocumentSource,
    ExtensionManifest,
} from "../../extension-api"
import { ExtensionHost, type ExtensionHostOptions } from "../../extension-host"
import type { DocumentSource as PdfDocumentSource } from "$lib/document-model"
import { pdfDocumentAdapter } from "./pdf"
import { activateLibrary } from "./library"
import { activatePrompt } from "./prompt"
import { activateSettings } from "./settings"
import { activateViewer } from "./viewer"

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

const pdfExtensionSource = (source: ExtensionDocumentSource): PdfDocumentSource => ({
    id: source.id,
    name: source.name ?? source.id,
    size: source.size ?? 0,
    mimeType: "application/pdf",
    read: async (offset, length, signal) => {
        signal?.throwIfAborted()
        const bytes = await source.read(offset, length)
        signal?.throwIfAborted()
        return bytes.slice().buffer
    },
})

const openPdfDocument = async (source: ExtensionDocumentSource) => {
    const document = await pdfDocumentAdapter.open(pdfExtensionSource(source))
    return {
        id: source.id,
        kind: document.kind,
        close: () => document.close(),
    }
}

const activatePdf = (context: Parameters<AppExtension["activate"]>[0]): void => {
    context.documents.register({
        id: "builtin.pdf.document",
        extensions: ["pdf"],
        open: openPdfDocument,
    })
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
        adapters: [{ id: "builtin.pdf.document", extensions: ["pdf"], open: openPdfDocument }],
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
        activate: activateViewer,
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

export { ExtensionHost }
