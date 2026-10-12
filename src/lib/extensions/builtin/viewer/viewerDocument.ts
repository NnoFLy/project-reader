import type {
    DocumentOutlineEntry,
    PagedDocument,
    ReaderPage,
    DocumentSource,
} from "$lib/document-model"
import type { DocumentService } from "../../../core/documents"
import { createBlobDocumentSource, DOCUMENT_SOURCE_LIMITS } from "../../../core/files"
import { DocumentService as DocumentServiceImpl } from "../../../core/documents"

export type ViewerTextItem = { readonly text: string }

export interface ViewerPageLayerTarget {
    readonly textContainer: HTMLElement
    readonly annotationContainer: HTMLDivElement | null
    readonly onNavigate: (pageNumber: number) => void
    readonly signal?: AbortSignal
}

/**
 * The viewer-facing document capability. Format adapters remain responsible for
 * parsing and rendering; the viewer only relies on format-neutral page data.
 */
export interface ViewerDocument extends PagedDocument {
    getText(pageNumber: number): Promise<readonly ViewerTextItem[]>
    getOutline?(): Promise<readonly DocumentOutlineEntry[] | null>
    getAllPageDimensions?(
        signal?: AbortSignal,
    ): Promise<readonly { width: number; height: number }[]>
    validateRenderBounds?(quality?: number, signal?: AbortSignal): Promise<void>
    renderPageLayers?(pageNumber: number, target: ViewerPageLayerTarget): Promise<void>
}

export interface ViewerDocumentLoader {
    open(
        input: {
            readonly id: string
            readonly name: string
            readonly url: string
        },
        signal?: AbortSignal,
    ): Promise<ViewerDocument>
}

declare global {
    // The host may install its canonical service while wiring document adapters.
    // Keeping the seam here avoids importing an adapter implementation into Viewer.
    var __documentService: DocumentService | undefined
    var __viewerDocumentLoader: ViewerDocumentLoader | undefined
}

let defaultLoader: ViewerDocumentLoader | undefined
let defaultService: Promise<DocumentService> | undefined

async function getDefaultDocumentService(): Promise<DocumentService> {
    if (!defaultService) {
        defaultService = (async () => {
            const service = new DocumentServiceImpl()
            // The built-in adapter is a capability, so do not load its PDF.js
            // implementation until a document is actually opened.
            const { pdfDocumentAdapter } = await import("$lib/extensions/builtin/pdf")
            service.adapters.register(pdfDocumentAdapter)
            return service
        })()
    }
    return defaultService
}

function getDocumentService(): Promise<DocumentService> {
    return globalThis.__documentService
        ? Promise.resolve(globalThis.__documentService)
        : getDefaultDocumentService()
}

function asViewerDocument(service: DocumentService, document: PagedDocument): ViewerDocument {
    const candidate = document as PagedDocument & {
        getText?: (pageNumber: number) => Promise<readonly ViewerTextItem[]>
        getOutline?: () => Promise<readonly DocumentOutlineEntry[] | null>
        getAllPageDimensions?: (
            signal?: AbortSignal,
        ) => Promise<readonly { width: number; height: number }[]>
        validateRenderBounds?: (quality?: number, signal?: AbortSignal) => Promise<void>
    }
    if (!candidate.getText)
        throw new Error("The selected document does not support text extraction")
    return {
        get kind() {
            return document.kind
        },
        get metadata() {
            return document.metadata
        },
        get capabilities() {
            return document.capabilities
        },
        get pageCount() {
            return document.pageCount
        },
        getText: (pageNumber) => candidate.getText!(pageNumber),
        getPage: (pageNumber) => document.getPage(pageNumber),
        renderPage: (pageNumber, options) => document.renderPage(pageNumber, options),
        getOutline: candidate.getOutline ? () => candidate.getOutline!() : undefined,
        getAllPageDimensions: candidate.getAllPageDimensions
            ? (signal) => candidate.getAllPageDimensions!(signal)
            : undefined,
        validateRenderBounds: candidate.validateRenderBounds
            ? (quality, signal) => candidate.validateRenderBounds!(quality, signal)
            : undefined,
        close: () => service.close(document),
    }
}

function createServiceLoader(): ViewerDocumentLoader {
    return {
        async open(input, signal) {
            const response = await fetch(input.url, { signal })
            if (!response.ok) throw new Error(`Failed to read document source (${response.status})`)
            const blob = await response.blob()
            const source: DocumentSource = createBlobDocumentSource({
                id: input.id,
                name: input.name,
                blob,
                mimeType: blob.type || undefined,
            })
            const service = await getDocumentService()
            const document = await service.open(source, signal)
            if (document.kind !== "paged") {
                await service.close(document)
                throw new Error(`Document adapter returned a non-paged document for ${input.name}`)
            }
            return asViewerDocument(service, document)
        },
    }
}

export function getViewerDocumentLoader(): ViewerDocumentLoader {
    const loader = globalThis.__viewerDocumentLoader
    if (loader) return loader
    if (!defaultLoader) defaultLoader = createServiceLoader()
    return defaultLoader
}

export function getViewerPageCount(document: ViewerDocument): number {
    return document.pageCount
}

export async function getViewerPage(
    document: ViewerDocument,
    pageNumber: number,
): Promise<ReaderPage> {
    return document.getPage(pageNumber)
}

export function assertDocumentFileSize(bytes: number): void {
    if (bytes <= DOCUMENT_SOURCE_LIMITS.maxFileBytes) return
    const error = new Error(
        `Document source exceeds the ${DOCUMENT_SOURCE_LIMITS.maxFileBytes} byte limit`,
    )
    error.name = "DocumentSourceLimitError"
    throw error
}

export function isDocumentResourceLimitError(error: unknown): boolean {
    return (
        error instanceof Error &&
        (error.name === "PDFResourceLimitError" || error.name === "DocumentSourceLimitError")
    )
}

export async function renderViewerPageLayers(
    document: ViewerDocument,
    pageNumber: number,
    target: ViewerPageLayerTarget,
): Promise<void> {
    if (document.renderPageLayers) {
        await document.renderPageLayers(pageNumber, target)
        return
    }

    target.textContainer.replaceChildren()
    const items = await document.getText(pageNumber)
    for (const item of items) {
        if (target.signal?.aborted) return
        const span = globalThis.document.createElement("span")
        span.textContent = item.text
        target.textContainer.append(span)
    }
}

export function flattenViewerOutline(
    outline: readonly DocumentOutlineEntry[] | null | undefined,
): DocumentOutlineEntry[] | null {
    return outline ? [...outline] : null
}
