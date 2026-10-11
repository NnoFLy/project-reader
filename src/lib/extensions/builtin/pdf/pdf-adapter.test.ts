import { describe, expect, it, vi } from "vitest"
import { createBoundedDocumentSource } from "$lib/core/files"
import { assertPdfFileSize, PDF_RESOURCE_LIMITS, PagedPdfDocument } from "./pdf-document"
import { PdfDocumentAdapter } from "./pdf-adapter"

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

    it("enforces the PDF file boundary", () => {
        expect(() => assertPdfFileSize(PDF_RESOURCE_LIMITS.maxFileBytes)).not.toThrow()
        expect(() => assertPdfFileSize(PDF_RESOURCE_LIMITS.maxFileBytes + 1)).toThrow("byte limit")
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
