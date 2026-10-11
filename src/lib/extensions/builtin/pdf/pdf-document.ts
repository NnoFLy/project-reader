import * as pdfjs from "pdfjs-dist"
import pdfjsWorker from "pdfjs-dist/build/pdf.worker.min.mjs?url"
import type { TextContent } from "pdfjs-dist/types/src/display/api"
import type {
    DocumentCapability,
    DocumentMetadata,
    DocumentOutlineEntry,
    DocumentSource,
    PagedDocument,
    RenderOptions,
    RenderedPage,
    ReaderPage,
} from "$lib/document-model"
import { DOCUMENT_SOURCE_LIMITS, throwIfAborted } from "$lib/core/files"

export const PDF_RESOURCE_LIMITS = {
    maxFileBytes: 100 * 1024 * 1024,
    maxPages: 2_000,
    maxPageDimension: 10_000,
    maxCanvasPixels: 40_000_000,
} as const

export class PDFResourceLimitError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "PDFResourceLimitError"
    }
}

export function assertPdfFileSize(bytes: number): void {
    if (bytes > PDF_RESOURCE_LIMITS.maxFileBytes) {
        throw new PDFResourceLimitError(
            `PDF file exceeds the ${PDF_RESOURCE_LIMITS.maxFileBytes} byte limit`,
        )
    }
}

function assertPageNumber(pageNumber: number, pageCount: number): void {
    if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || pageNumber > pageCount) {
        throw new RangeError(`Page ${pageNumber} is outside the document`)
    }
}

function assertPageCount(pageCount: number): void {
    if (pageCount > PDF_RESOURCE_LIMITS.maxPages) {
        throw new PDFResourceLimitError(
            `PDF exceeds the ${PDF_RESOURCE_LIMITS.maxPages} page limit`,
        )
    }
}

function assertPageDimensions(width: number, height: number): void {
    if (
        width > PDF_RESOURCE_LIMITS.maxPageDimension ||
        height > PDF_RESOURCE_LIMITS.maxPageDimension
    ) {
        throw new PDFResourceLimitError(
            `PDF page exceeds the ${PDF_RESOURCE_LIMITS.maxPageDimension}px dimension limit`,
        )
    }
}

function assertCanvasPixels(width: number, height: number): void {
    if (width * height > PDF_RESOURCE_LIMITS.maxCanvasPixels) {
        throw new PDFResourceLimitError(
            `PDF page exceeds the ${PDF_RESOURCE_LIMITS.maxCanvasPixels} pixel canvas limit`,
        )
    }
}

function abortError(message: string): DOMException {
    return new DOMException(message, "AbortError")
}

if (typeof window !== "undefined" && !pdfjs.GlobalWorkerOptions.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = pdfjsWorker
}

export class PagedPdfDocument implements PagedDocument {
    readonly kind = "paged" as const
    readonly capabilities: ReadonlySet<DocumentCapability> = new Set([
        "text",
        "search",
        "outline",
        "annotations",
        "links",
        "selection",
        "thumbnails",
    ])
    private documentMetadata: DocumentMetadata = { title: null, author: null }
    get metadata(): DocumentMetadata {
        return this.documentMetadata
    }

    private pdfDoc: pdfjs.PDFDocumentProxy | null = null
    private loadingTask: pdfjs.PDFDocumentLoadingTask | null = null
    private closePromise: Promise<void> | null = null
    private closed = false
    private _pageCount = 0
    private readonly pageDimensions = new Map<number, { width: number; height: number }>()
    private readonly pageCache = new Map<number, string>()
    private readonly pagePromises = new Map<number, Promise<pdfjs.PDFPageProxy>>()
    private readonly pages = new Map<number, pdfjs.PDFPageProxy>()
    private outlineCache: readonly DocumentOutlineEntry[] | null = null
    private renderedQuality: number | null = null
    private renderGeneration = 0

    constructor(readonly source: DocumentSource) {}

    get pageCount(): number {
        return this._pageCount
    }

    async load(signal?: AbortSignal): Promise<this> {
        this.assertOpen()
        assertPdfFileSize(this.source.size)
        const data = await this.readSource(signal)
        throwIfAborted(signal)
        try {
            this.loadingTask = pdfjs.getDocument({ data })
            this.pdfDoc = await this.loadingTask.promise
            this.loadingTask = null
            this._pageCount = this.pdfDoc.numPages
            assertPageCount(this._pageCount)
            if (this._pageCount > 0) await this.getPageDimension(1)
            try {
                const metadata = await this.pdfDoc.getMetadata()
                const info = metadata.info as Record<string, unknown> | undefined
                this.documentMetadata = {
                    title: typeof info?.Title === "string" ? info.Title : null,
                    author: typeof info?.Author === "string" ? info.Author : null,
                    subject: typeof info?.Subject === "string" ? info.Subject : null,
                    pageCount: this._pageCount,
                }
            } catch {
                this.documentMetadata = { title: null, author: null, pageCount: this._pageCount }
            }
            return this
        } catch (error) {
            if (error instanceof PDFResourceLimitError) throw error
            if (signal?.aborted) throw signal.reason ?? abortError("Loading PDF was cancelled")
            throw new Error(
                `Failed to parse PDF document: ${error instanceof Error ? error.message : error}`,
            )
        }
    }

    async getPage(pageNumber: number): Promise<ReaderPage> {
        this.assertOpen()
        const dimensions = await this.getPageDimension(pageNumber)
        return { pageNumber, ...dimensions }
    }

    async renderPage(pageNumber: number, options: RenderOptions = {}): Promise<RenderedPage> {
        const quality = options.quality ?? options.scale ?? 1
        const url = await this.getCanvasPage(pageNumber, quality, options.signal)
        const dimensions = await this.getPageDimension(pageNumber)
        return {
            pageNumber,
            url,
            width: dimensions.width * quality,
            height: dimensions.height * quality,
            mimeType: "image/webp",
        }
    }

    async getPageDimension(
        pageNumber: number,
        bypassCache = false,
    ): Promise<{ width: number; height: number }> {
        this.assertOpen()
        assertPageNumber(pageNumber, this._pageCount)
        if (!bypassCache && this.pageDimensions.has(pageNumber)) {
            return this.pageDimensions.get(pageNumber)!
        }
        const page = bypassCache
            ? await this.getRequiredPdfDoc().getPage(pageNumber)
            : await this.getPageProxy(pageNumber)
        try {
            const viewport = page.getViewport({ scale: 1 })
            assertPageDimensions(viewport.width, viewport.height)
            const dimensions = { width: viewport.width, height: viewport.height }
            this.pageDimensions.set(pageNumber, dimensions)
            return dimensions
        } finally {
            if (bypassCache) page.cleanup()
        }
    }

    async getAllPageDimensions(
        signal?: AbortSignal,
    ): Promise<readonly { width: number; height: number }[]> {
        this.assertOpen()
        assertPageCount(this._pageCount)
        const dimensions: { width: number; height: number }[] = []
        for (let first = 1; first <= this._pageCount; first += 4) {
            throwIfAborted(signal)
            const last = Math.min(first + 3, this._pageCount)
            const chunk = await Promise.all(
                Array.from({ length: last - first + 1 }, (_, index) =>
                    this.getPageDimension(first + index, true),
                ),
            )
            throwIfAborted(signal)
            dimensions.push(...chunk)
        }
        return dimensions
    }

    async validateRenderBounds(quality = 1, signal?: AbortSignal): Promise<void> {
        const dimensions = await this.getAllPageDimensions(signal)
        for (const { width, height } of dimensions) {
            throwIfAborted(signal)
            assertCanvasPixels(width * quality, height * quality)
        }
    }

    async getTextContent(pageNumber: number): Promise<TextContent> {
        const page = await this.getPageProxy(pageNumber)
        return page.getTextContent()
    }

    async getText(pageNumber: number): Promise<readonly { readonly text: string }[]> {
        const text = await this.getTextContent(pageNumber)
        return text.items.map((item) => ({
            text: "str" in item && typeof item.str === "string" ? item.str : "",
        }))
    }

    async getOutline(): Promise<readonly DocumentOutlineEntry[] | null> {
        this.assertOpen()
        if (this.outlineCache) return this.outlineCache
        const outline = await this.getRequiredPdfDoc().getOutline()
        if (!outline) return null
        const entries: DocumentOutlineEntry[] = []
        const flatten = async (items: any[], depth: number): Promise<void> => {
            for (const item of items) {
                let pageNumber: number | undefined
                if (item.dest) pageNumber = await this.resolveDestinationToPage(item.dest)
                entries.push({ title: String(item.title ?? ""), depth, pageNumber })
                if (Array.isArray(item.items)) await flatten(item.items, depth + 1)
            }
        }
        await flatten(outline, 0)
        this.outlineCache = entries
        return entries
    }

    async getAnnotations(pageNumber: number): Promise<readonly unknown[]> {
        return (await this.getPageProxy(pageNumber).then((page) =>
            page.getAnnotations(),
        )) as unknown[]
    }

    async getCanvasPage(pageNumber: number, quality = 1, signal?: AbortSignal): Promise<string> {
        this.assertOpen()
        assertPageNumber(pageNumber, this._pageCount)
        throwIfAborted(signal)
        if (this.renderedQuality !== null && this.renderedQuality !== quality) {
            this.clearPageCache()
            this.renderGeneration += 1
        }
        this.renderedQuality = quality
        const generation = this.renderGeneration
        const cached = this.pageCache.get(pageNumber)
        if (cached) return cached

        const page = await this.getPageProxy(pageNumber)
        let renderTask: pdfjs.RenderTask | undefined
        try {
            const viewport = page.getViewport({ scale: quality })
            const baseViewport = page.getViewport({ scale: 1 })
            assertPageDimensions(baseViewport.width, baseViewport.height)
            assertCanvasPixels(viewport.width, viewport.height)
            if (typeof document === "undefined") throw new Error("Canvas rendering is unavailable")
            const canvas = document.createElement("canvas")
            const context = canvas.getContext("2d")
            if (!context) throw new Error("Could not create a canvas rendering context")
            canvas.width = viewport.width
            canvas.height = viewport.height
            const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1
            canvas.style.width = `${viewport.width / dpr}px`
            canvas.style.height = `${viewport.height / dpr}px`
            context.imageSmoothingEnabled = true
            context.imageSmoothingQuality = "high"
            renderTask = page.render({ canvasContext: context, viewport })
            const onAbort = () => renderTask?.cancel()
            signal?.addEventListener("abort", onAbort)
            try {
                await renderTask.promise
            } finally {
                signal?.removeEventListener("abort", onAbort)
            }
            throwIfAborted(signal)
            if (generation !== this.renderGeneration || this.renderedQuality !== quality) {
                throw abortError("Rendering was superseded")
            }
            const blob = await this.canvasToBlob(canvas, signal)
            const url = URL.createObjectURL(blob)
            if (generation !== this.renderGeneration || this.renderedQuality !== quality) {
                URL.revokeObjectURL(url)
                throw abortError("Rendering was superseded")
            }
            const winner = this.pageCache.get(pageNumber)
            if (winner) {
                URL.revokeObjectURL(url)
                return winner
            }
            this.pageCache.set(pageNumber, url)
            while (this.pageCache.size > 16) {
                const oldest = this.pageCache.keys().next().value
                if (oldest === undefined) break
                const oldUrl = this.pageCache.get(oldest)
                if (oldUrl) URL.revokeObjectURL(oldUrl)
                this.pageCache.delete(oldest)
            }
            return url
        } catch (error) {
            if (signal?.aborted || (error as { name?: string })?.name === "AbortError") throw error
            if ((error as { name?: string })?.name === "RenderingCancelledException") throw error
            throw error instanceof PDFResourceLimitError
                ? error
                : new Error(
                      `Failed to render page visual: ${error instanceof Error ? error.message : error}`,
                  )
        }
    }

    async close(): Promise<void> {
        if (this.closePromise) return this.closePromise
        this.closed = true
        this.closePromise = (async () => {
            const errors: unknown[] = []
            const attempt = async (operation: () => void | Promise<void>): Promise<void> => {
                try {
                    await operation()
                } catch (error) {
                    errors.push(error)
                }
            }

            await attempt(() => this.clearPageCache())
            for (const page of this.pages.values()) {
                await attempt(() => {
                    page.cleanup()
                })
            }
            this.pages.clear()
            this.pagePromises.clear()
            const loadingTask = this.loadingTask
            const pdfDoc = this.pdfDoc
            this.loadingTask = null
            this.pdfDoc = null
            await attempt(async () => loadingTask?.destroy())
            await attempt(async () => pdfDoc?.destroy())
            // Source cleanup is independent from PDF.js cleanup. In particular,
            // a failed destroy must not leak a file handle or object URL.
            await attempt(async () => this.source.close?.())
            if (errors.length > 0) throw errors[0]
        })()
        return this.closePromise
    }

    private async readSource(signal?: AbortSignal): Promise<Uint8Array> {
        const maxChunk = Math.min(DOCUMENT_SOURCE_LIMITS.maxReadBytes, 4 * 1024 * 1024)
        const data = new Uint8Array(this.source.size)
        let offset = 0
        while (offset < this.source.size) {
            throwIfAborted(signal)
            const expected = Math.min(maxChunk, this.source.size - offset)
            const chunk = new Uint8Array(await this.source.read(offset, expected, signal))
            if (chunk.byteLength === 0)
                throw new Error("Document source ended before its declared size")
            data.set(chunk, offset)
            offset += chunk.byteLength
        }
        return data
    }

    private async canvasToBlob(canvas: HTMLCanvasElement, signal?: AbortSignal): Promise<Blob> {
        throwIfAborted(signal)
        return new Promise((resolve, reject) => {
            const onAbort = () => reject(abortError("Rendering was cancelled"))
            signal?.addEventListener("abort", onAbort, { once: true })
            canvas.toBlob(
                (blob) => {
                    signal?.removeEventListener("abort", onAbort)
                    if (signal?.aborted) return reject(abortError("Rendering was cancelled"))
                    if (!blob) return reject(new Error("Failed to create a page image"))
                    resolve(blob)
                },
                "image/webp",
                0.9,
            )
        })
    }

    private async resolveDestinationToPage(dest: string | unknown[]): Promise<number | undefined> {
        let explicit: any[] | null = null
        if (typeof dest === "string") explicit = await this.getRequiredPdfDoc().getDestination(dest)
        else if (Array.isArray(dest)) explicit = dest
        const reference = explicit?.[0]
        if (!reference) return undefined
        if (typeof reference === "number") return reference + 1
        return (await this.getRequiredPdfDoc().getPageIndex(reference)) + 1
    }

    private async getPageProxy(pageNumber: number): Promise<pdfjs.PDFPageProxy> {
        this.assertOpen()
        assertPageNumber(pageNumber, this._pageCount)
        const cached = this.pages.get(pageNumber)
        if (cached) return cached
        const pending = this.pagePromises.get(pageNumber)
        if (pending) return pending
        const promise = this.getRequiredPdfDoc()
            .getPage(pageNumber)
            .then((page) => {
                this.pages.set(pageNumber, page)
                this.pagePromises.delete(pageNumber)
                while (this.pages.size > 16) {
                    const oldest = this.pages.keys().next().value
                    if (oldest === undefined) break
                    this.pages.get(oldest)?.cleanup()
                    this.pages.delete(oldest)
                }
                return page
            })
            .catch((error) => {
                this.pagePromises.delete(pageNumber)
                throw error
            })
        this.pagePromises.set(pageNumber, promise)
        return promise
    }

    private getRequiredPdfDoc(): pdfjs.PDFDocumentProxy {
        if (this.closed || !this.pdfDoc) throw new Error("PDF document is not open")
        return this.pdfDoc
    }

    private assertOpen(): void {
        if (this.closed) throw new Error("PDF document is closed")
    }

    private clearPageCache(): void {
        for (const url of this.pageCache.values()) URL.revokeObjectURL(url)
        this.pageCache.clear()
    }
}

export { PagedPdfDocument as PDFDocument }
