import type {
    DocumentOutlineEntry,
    OpenedDocument,
    PagedDocument,
    ReflowableDocument,
    ReaderPage,
    DocumentSource,
} from "$lib/document-model"
import { createBlobDocumentSource, DOCUMENT_SOURCE_LIMITS } from "../../../core/files"

export type ViewerTextItem = { readonly text: string }

export interface ViewerDocumentErrorDiagnostic {
    readonly name: string
    readonly message: string
}

const SAFE_DOCUMENT_ERROR_NAMES = new Set([
    "AbortError",
    "DocumentOpenError",
    "DocumentSourceLimitError",
    "PDFDocumentError",
    "PDFRenderError",
    "PDFResourceLimitError",
    "UnsupportedDocumentError",
])

/** Returns a safe diagnostic without exposing adapter messages, URLs, or document content. */
export function getViewerDocumentErrorDiagnostic(
    error: unknown,
    fallback = "Unable to open document",
): ViewerDocumentErrorDiagnostic {
    if (!(error instanceof Error)) return { name: "DocumentError", message: fallback }
    const name = SAFE_DOCUMENT_ERROR_NAMES.has(error.name) ? error.name : "DocumentError"
    const message =
        error.name === "AbortError"
            ? "Document operation was cancelled"
            : error.name === "UnsupportedDocumentError"
              ? "This document format is not supported"
              : error.name === "DocumentSourceLimitError" || error.name === "PDFResourceLimitError"
                ? "Document exceeds a configured resource limit"
                : error.name === "PDFDocumentError"
                  ? "Unable to read the PDF document"
                  : error.name === "PDFRenderError"
                    ? "Unable to render the document page"
                    : fallback
    return { name, message }
}

export interface ViewerPageLayerTarget {
    readonly textContainer: HTMLElement
    readonly annotationContainer: HTMLDivElement | null
    readonly onNavigate: (pageNumber: number) => void
    readonly signal?: AbortSignal
}

/** Optional, format-neutral capabilities attached by a paged adapter. */
export interface ViewerPagedExtras {
    /** Text extraction is optional; rendering must not depend on it. */
    getText?: (pageNumber: number) => Promise<readonly ViewerTextItem[]>
    getOutline?(): Promise<readonly DocumentOutlineEntry[] | null>
    validateRenderBounds?(quality?: number, signal?: AbortSignal): Promise<void>
    renderPageLayers?(pageNumber: number, target: ViewerPageLayerTarget): Promise<void>
}

/** A paged document as consumed by the bitmap viewer. */
export type ViewerPagedDocument = PagedDocument & ViewerPagedExtras

/** A reflowable document retains sections and never exposes paged-only fields. */
export type ViewerReflowDocument = ReflowableDocument

/** The viewer preserves the document model's discriminated union. */
export type ViewerDocument = ViewerPagedDocument | ViewerReflowDocument

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

/** The host-owned document capability consumed by the viewer. */
export interface ViewerDocumentService {
    open(source: DocumentSource, signal?: AbortSignal): Promise<OpenedDocument>
    close(document: OpenedDocument): Promise<void>
}

let installedDocumentService: ViewerDocumentService | undefined
let defaultLoader: ViewerDocumentLoader | undefined

/** Install the canonical host capability before viewer documents are opened. */
export function installViewerDocumentService(service: ViewerDocumentService | undefined): void {
    installedDocumentService = service
    defaultLoader = undefined
}

function requireDocumentService(): ViewerDocumentService {
    if (!installedDocumentService) {
        throw new Error("The application document service has not been installed")
    }
    return installedDocumentService
}

function asViewerDocument(
    service: ViewerDocumentService,
    document: OpenedDocument,
): ViewerDocument {
    if (document.kind === "reflowable") {
        return {
            kind: "reflowable",
            metadata: document.metadata,
            capabilities: document.capabilities,
            getSections: () => document.getSections(),
            close: () => service.close(document),
        }
    }

    const candidate = document as PagedDocument & ViewerPagedExtras
    return {
        kind: "paged",
        metadata: document.metadata,
        capabilities: document.capabilities,
        pageCount: document.pageCount,
        getPage: (pageNumber) => document.getPage(pageNumber),
        renderPage: (pageNumber, options) => document.renderPage(pageNumber, options),
        getText: candidate.getText ? (pageNumber) => candidate.getText!(pageNumber) : undefined,
        getOutline: candidate.getOutline ? () => candidate.getOutline!() : undefined,
        validateRenderBounds: candidate.validateRenderBounds
            ? (quality, signal) => candidate.validateRenderBounds!(quality, signal)
            : undefined,
        renderPageLayers: candidate.renderPageLayers
            ? (pageNumber, target) => candidate.renderPageLayers!(pageNumber, target)
            : undefined,
        close: () => service.close(document),
    }
}

function createServiceLoader(service: ViewerDocumentService): ViewerDocumentLoader {
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
            const document = await service.open(source, signal)
            return asViewerDocument(service, document)
        },
    }
}

export function getViewerDocumentLoader(): ViewerDocumentLoader {
    if (!defaultLoader) defaultLoader = createServiceLoader(requireDocumentService())
    return defaultLoader
}

export function isViewerPagedDocument(document: ViewerDocument): document is ViewerPagedDocument {
    return document.kind === "paged"
}

export function getViewerPageCount(document: ViewerPagedDocument): number {
    return document.pageCount
}

export async function getViewerPage(
    document: ViewerPagedDocument,
    pageNumber: number,
): Promise<ReaderPage> {
    return document.getPage(pageNumber)
}

/** Loads generic page metadata for paged viewers without adapter-specific methods. */
export async function getViewerPageDimensions(
    document: ViewerPagedDocument,
    signal?: AbortSignal,
): Promise<readonly { width: number; height: number }[]> {
    const dimensions: { width: number; height: number }[] = []
    for (let pageNumber = 1; pageNumber <= document.pageCount; pageNumber += 1) {
        signal?.throwIfAborted()
        const page = await document.getPage(pageNumber)
        dimensions.push({ width: page.width, height: page.height })
    }
    return dimensions
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
    document: ViewerPagedDocument,
    pageNumber: number,
    target: ViewerPageLayerTarget,
): Promise<void> {
    if (document.renderPageLayers) {
        await document.renderPageLayers(pageNumber, target)
        return
    }

    target.textContainer.replaceChildren()
    if (!document.getText) return
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
