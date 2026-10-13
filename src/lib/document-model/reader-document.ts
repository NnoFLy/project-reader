export type DocumentCapability =
    | "text"
    | "search"
    | "outline"
    | "annotations"
    | "links"
    | "selection"
    | "thumbnails"

export interface DocumentMetadata {
    readonly title: string | null
    readonly author: string | null
    readonly subject?: string | null
    readonly language?: string | null
    readonly pageCount?: number
    readonly [key: string]: unknown
}

export interface ReaderPage {
    readonly pageNumber: number
    readonly width: number
    readonly height: number
}

export interface ReaderSection {
    readonly id: string
    readonly title?: string
    readonly content: string
}

export interface RenderOptions {
    readonly scale?: number
    readonly quality?: number
    readonly signal?: AbortSignal
}

export interface RenderedPage {
    readonly pageNumber: number
    readonly url: string
    readonly width: number
    readonly height: number
    readonly mimeType: string
}

export interface DocumentOutlineEntry {
    readonly title: string
    readonly depth: number
    readonly pageNumber?: number
}

export interface DocumentTextItem {
    readonly text: string
    /** Position and size in the page's unscaled coordinate space. */
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
    readonly fontSize?: number
    readonly fontFamily?: string
    readonly hasEOL?: boolean
}

export interface DocumentText {
    readonly items: readonly DocumentTextItem[]
}

export interface DocumentAnnotationRect {
    readonly x: number
    readonly y: number
    readonly width: number
    readonly height: number
}

export interface DocumentLinkAnnotation {
    readonly type: "link"
    readonly rect: DocumentAnnotationRect
    /** An external URL already validated by the document adapter. */
    readonly url?: string
    /** A destination within this document. */
    readonly pageNumber?: number
    readonly label?: string
}

export type DocumentAnnotation = DocumentLinkAnnotation

export interface BaseReaderDocument {
    readonly kind: "paged" | "reflowable"
    readonly metadata: DocumentMetadata
    readonly capabilities: ReadonlySet<DocumentCapability>
    close(): Promise<void>
}

export type OpenedDocument = PagedDocument | ReflowableDocument

export interface PagedDocument extends BaseReaderDocument {
    readonly kind: "paged"
    readonly pageCount: number
    getPage(pageNumber: number): Promise<ReaderPage>
    renderPage(pageNumber: number, options?: RenderOptions): Promise<RenderedPage>
    getText?(pageNumber: number, signal?: AbortSignal): Promise<readonly DocumentTextItem[]>
    getAnnotations?(
        pageNumber: number,
        signal?: AbortSignal,
    ): Promise<readonly DocumentAnnotation[]>
    getOutline?(): Promise<readonly DocumentOutlineEntry[] | null>
    validateRenderBounds?(quality?: number, signal?: AbortSignal): Promise<void>
}

export interface ReflowableDocument extends BaseReaderDocument {
    readonly kind: "reflowable"
    getSections(): Promise<readonly ReaderSection[]>
}
