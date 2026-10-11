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

export interface DocumentText {
    readonly items: readonly { readonly text: string }[]
}

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
}

export interface ReflowableDocument extends BaseReaderDocument {
    readonly kind: "reflowable"
    getSections(): Promise<readonly ReaderSection[]>
}
