import type { DocumentOutlineEntry, PagedDocument, ReaderPage } from "$lib/document-model"

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
    // The host installs this capability while wiring its document adapters.
    // Keeping the seam here avoids importing an adapter implementation into Viewer.
    var __viewerDocumentLoader: ViewerDocumentLoader | undefined
}

export function getViewerDocumentLoader(): ViewerDocumentLoader {
    const loader = globalThis.__viewerDocumentLoader
    if (!loader) {
        throw new Error("Viewer document capability is not configured")
    }
    return loader
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
