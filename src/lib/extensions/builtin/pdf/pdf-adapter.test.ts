import { describe, expect, it, vi } from "vitest"
import { createBoundedDocumentSource } from "$lib/core/files"
import { assertPdfFileSize, PDF_RESOURCE_LIMITS } from "./pdf-document"
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
    it("probes the PDF signature using a bounded read", async () => {
        const { source: documentSource, read } = source(new TextEncoder().encode("%PDF-1.7"))
        const result = await new PdfDocumentAdapter().probe(documentSource)
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
})
