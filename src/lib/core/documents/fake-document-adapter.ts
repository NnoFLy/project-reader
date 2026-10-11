import type {
    DocumentAdapter,
    DocumentMetadata,
    DocumentSource,
    OpenedDocument,
    PagedDocument,
    ProbeResult,
    RenderOptions,
    RenderedPage,
    ReaderPage,
} from "$lib/document-model"

export interface FakeDocumentOptions {
    readonly id?: string
    readonly extension?: string
    readonly mimeType?: string
    readonly pageCount?: number
    readonly metadata?: Partial<DocumentMetadata>
}

class FakePagedDocument implements PagedDocument {
    readonly kind = "paged" as const
    readonly capabilities = new Set<"text">()
    readonly metadata: DocumentMetadata
    readonly pageCount: number
    private closed = false

    constructor(
        private readonly source: DocumentSource,
        options: FakeDocumentOptions,
    ) {
        this.pageCount = options.pageCount ?? 2
        this.metadata = {
            title: options.metadata?.title ?? source.name,
            author: options.metadata?.author ?? null,
            ...options.metadata,
            pageCount: this.pageCount,
        }
    }

    async getPage(pageNumber: number): Promise<ReaderPage> {
        this.assertOpen()
        this.assertPage(pageNumber)
        return { pageNumber, width: 600, height: 800 }
    }

    async renderPage(pageNumber: number, options: RenderOptions = {}): Promise<RenderedPage> {
        this.assertOpen()
        this.assertPage(pageNumber)
        options.signal?.throwIfAborted()
        return {
            pageNumber,
            url: `fake://${encodeURIComponent(this.source.id)}/${pageNumber}`,
            width: 600 * (options.scale ?? 1),
            height: 800 * (options.scale ?? 1),
            mimeType: "image/fake",
        }
    }

    async close(): Promise<void> {
        if (this.closed) return
        this.closed = true
        await this.source.close?.()
    }

    private assertOpen(): void {
        if (this.closed) throw new Error("Fake document is closed")
    }

    private assertPage(pageNumber: number): void {
        if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > this.pageCount) {
            throw new RangeError(`Page ${pageNumber} is outside the document`)
        }
    }
}

export class FakeDocumentAdapter implements DocumentAdapter {
    readonly id: string
    readonly extensions: readonly string[]
    readonly mimeTypes: readonly string[]
    private readonly options: FakeDocumentOptions

    constructor(options: FakeDocumentOptions = {}) {
        this.options = options
        this.id = options.id ?? "test.fake"
        this.extensions = [options.extension ?? "fake"]
        this.mimeTypes = [options.mimeType ?? "application/x-fake-document"]
    }

    async probe(source: DocumentSource, signal?: AbortSignal): Promise<ProbeResult> {
        signal?.throwIfAborted()
        const extension = source.name.toLowerCase().endsWith(`.${this.extensions[0]}`)
        const mime = source.mimeType?.toLowerCase() === this.mimeTypes[0].toLowerCase()
        return { supported: extension || mime, confidence: extension && mime ? 1 : 0.5 }
    }

    async open(source: DocumentSource, signal?: AbortSignal): Promise<OpenedDocument> {
        signal?.throwIfAborted()
        return new FakePagedDocument(source, this.options)
    }
}

export function createFakeDocumentAdapter(options: FakeDocumentOptions = {}): FakeDocumentAdapter {
    return new FakeDocumentAdapter(options)
}
