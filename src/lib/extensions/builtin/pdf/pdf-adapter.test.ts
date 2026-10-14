import { describe, expect, it, vi } from "vitest"
import { createBoundedDocumentSource } from "$lib/core/files"
import { assertPdfFileSize, PDF_RESOURCE_LIMITS, PagedPdfDocument } from "./pdf-document"
import { PdfDocumentAdapter } from "./pdf-adapter"

const { getDocument } = vi.hoisted(() => ({ getDocument: vi.fn() }))
vi.mock("pdfjs-dist", () => ({ GlobalWorkerOptions: {}, getDocument }))

function source(bytes: Uint8Array, name = "sample.pdf") {
    const read = vi.fn(
        async (offset: number, length: number) => bytes.slice(offset, offset + length).buffer,
    )
    return {
        source: createBoundedDocumentSource({
            id: "pdf",
            name,
            size: bytes.byteLength,
            mimeType: "application/pdf",
            reader: { read },
            maxReadBytes: 16,
        }),
        read,
    }
}

describe("built-in PDF adapter boundary", () => {
    it("uses a namespaced ID and probes the PDF signature using a bounded read", async () => {
        const adapter = new PdfDocumentAdapter()
        expect(adapter.id).toBe("builtin.pdf.adapter")
        const { source: documentSource, read } = source(new TextEncoder().encode("%PDF-1.7"))
        const result = await adapter.probe(documentSource)
        expect(result).toMatchObject({ supported: true, format: "pdf" })
        expect(read).toHaveBeenCalledWith(0, 5, undefined)
    })

    it("does not identify arbitrary data as PDF", async () => {
        const { source: documentSource } = source(new TextEncoder().encode("hello"))
        await expect(new PdfDocumentAdapter().probe(documentSource)).resolves.toMatchObject({
            supported: false,
        })
    })

    it("does not advertise unsupported document capabilities", () => {
        const document = new PagedPdfDocument(
            createBoundedDocumentSource({
                id: "pdf-capabilities",
                name: "sample.pdf",
                size: 0,
                reader: { read: async () => new ArrayBuffer(0) },
            }),
        )

        expect(document.capabilities).toEqual(
            new Set([
                "text",
                "search",
                "outline",
                "annotations",
                "links",
                "selection",
                "thumbnails",
            ]),
        )
        expect(document).toHaveProperty("getAnnotations")
    })

    it("enforces the PDF file boundary", () => {
        expect(() => assertPdfFileSize(PDF_RESOURCE_LIMITS.maxFileBytes)).not.toThrow()
        expect(() => assertPdfFileSize(PDF_RESOURCE_LIMITS.maxFileBytes + 1)).toThrow("byte limit")
    })

    it("keeps source failure details internal when loading a PDF", async () => {
        const sourceError = new Error("private source URL and parser details")
        const document = new PagedPdfDocument(
            createBoundedDocumentSource({
                id: "pdf-load-failure",
                name: "sample.pdf",
                size: 1,
                reader: { read: async () => Promise.reject(sourceError) },
            }),
        )

        await expect(document.load()).rejects.toMatchObject({
            message: "Failed to parse PDF document",
            cause: sourceError,
        })
    })

    it("closes its source once when close is called repeatedly", async () => {
        const close = vi.fn(async () => undefined)
        const document = new PagedPdfDocument(
            createBoundedDocumentSource({
                id: "pdf-close",
                name: "sample.pdf",
                size: 0,
                reader: { read: async () => new ArrayBuffer(0), close },
            }),
        )

        await Promise.all([document.close(), document.close()])
        expect(close).toHaveBeenCalledOnce()
    })

    it("waits for an in-flight load before closing the source", async () => {
        let resolveRead!: (value: ArrayBuffer) => void
        const read = vi.fn(
            () =>
                new Promise<ArrayBuffer>((resolve) => {
                    resolveRead = resolve
                }),
        )
        const close = vi.fn(async () => undefined)
        const document = new PagedPdfDocument(
            createBoundedDocumentSource({
                id: "pdf-load-close",
                name: "sample.pdf",
                size: 1,
                reader: { read, close },
            }),
        )
        const loading = document.load()
        const closing = document.close()
        resolveRead(new Uint8Array([0]).buffer)

        await expect(loading).rejects.toThrow()
        await expect(closing).resolves.toBeUndefined()
        expect(close).toHaveBeenCalledOnce()
        expect(getDocument).not.toHaveBeenCalled()
    })

    it("destroys a pending PDF.js load before waiting for it to settle", async () => {
        let rejectLoad!: (error: Error) => void
        let taskCreated!: () => void
        const created = new Promise<void>((resolve) => {
            taskCreated = resolve
        })
        const promise = new Promise<never>((_resolve, reject) => {
            rejectLoad = reject
        })
        const destroy = vi.fn(async () => {
            rejectLoad(new Error("load cancelled"))
        })
        getDocument.mockImplementationOnce(() => {
            taskCreated()
            return { promise, destroy }
        })
        const { source: documentSource } = source(new Uint8Array([0]))
        const document = new PagedPdfDocument(documentSource)
        const loading = document.load()
        const rejected = expect(loading).rejects.toThrow("Failed to parse PDF document")
        await created
        await document.close()
        await rejected
        expect(destroy).toHaveBeenCalledOnce()
        getDocument.mockClear()
    })

    it("cancels tracked render tasks before PDF.js cleanup", async () => {
        const document = new PagedPdfDocument(
            createBoundedDocumentSource({
                id: "pdf-render-close",
                name: "sample.pdf",
                size: 0,
                reader: { read: async () => new ArrayBuffer(0) },
            }),
        )
        const cancel = vi.fn()
        ;(document as unknown as { renderTasks: Set<{ cancel: () => void }> }).renderTasks.add({
            cancel,
        })

        await document.close()

        expect(cancel).toHaveBeenCalledOnce()
    })

    it("maps PDF viewport transforms into generic text and link geometry", async () => {
        const document = new PagedPdfDocument(
            createBoundedDocumentSource({
                id: "pdf-geometry",
                name: "sample.pdf",
                size: 0,
                reader: { read: async () => new ArrayBuffer(0) },
            }),
        )
        const page = {
            getViewport: vi.fn(() => ({
                width: 100,
                height: 80,
                transform: [0, 1, 1, 0, 0, 0],
                convertToViewportRectangle: (_rect: number[]) => [20, 30, 10, 50],
            })),
            getTextContent: vi.fn(async () => ({
                items: [
                    { str: "rotated", transform: [1, 0, 0, 10, 10, 20], width: 30, height: 10 },
                ],
            })),
            getAnnotations: vi.fn(async () => [
                { subtype: "Link", rect: [1, 2, 3, 4], url: "https://example.com/" },
            ]),
        }
        const internals = document as unknown as {
            _pageCount: number
            pdfDoc: object
            pages: Map<number, object>
        }
        internals._pageCount = 1
        internals.pdfDoc = {}
        internals.pages.set(1, page)

        await expect(document.getText(1)).resolves.toMatchObject([
            { text: "rotated", x: 20, y: 10, width: 10, height: 30, angle: 90 },
        ])
        await expect(document.getAnnotations(1)).resolves.toEqual([
            {
                type: "link",
                rect: { x: 10, y: 30, width: 10, height: 20 },
                url: "https://example.com/",
            },
        ])
    })

    it("still closes the source when PDF.js cleanup fails", async () => {
        const close = vi.fn(async () => undefined)
        const document = new PagedPdfDocument(
            createBoundedDocumentSource({
                id: "pdf-close-failure",
                name: "sample.pdf",
                size: 0,
                reader: { read: async () => new ArrayBuffer(0), close },
            }),
        )
        const internals = document as unknown as {
            loadingTask: { destroy: () => Promise<void> }
            pdfDoc: { destroy: () => Promise<void> }
        }
        internals.loadingTask = {
            destroy: vi.fn(async () => {
                throw new Error("loading task cleanup failed")
            }),
        }
        internals.pdfDoc = {
            destroy: vi.fn(async () => {
                throw new Error("document cleanup failed")
            }),
        }

        await expect(document.close()).rejects.toThrow("loading task cleanup failed")
        expect(close).toHaveBeenCalledOnce()
    })
})
