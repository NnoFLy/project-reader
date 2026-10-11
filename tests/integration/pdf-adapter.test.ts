import { describe, expect, it } from "vitest"
import { DocumentService } from "$lib/core/documents"
import { createBoundedDocumentSource } from "$lib/core/files"
import { pdfDocumentAdapter } from "$lib/extensions/builtin/pdf"

function minimalPdf(): Uint8Array {
    const objects = [
        "1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n",
        "2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n",
        "3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>\nendobj\n",
        "4 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n",
    ]
    const encoder = new TextEncoder()
    const header = "%PDF-1.4\n"
    const offsets: number[] = []
    let body = header
    for (const object of objects) {
        offsets.push(encoder.encode(body).byteLength)
        body += object
    }
    const xrefOffset = encoder.encode(body).byteLength
    body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
    body += offsets.map((offset) => `${offset.toString().padStart(10, "0")} 00000 n \n`).join("")
    body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`
    return encoder.encode(body)
}

describe("PDF adapter integration", () => {
    it("opens a PDF through the generic DocumentService contract", async () => {
        const bytes = minimalPdf()
        const source = createBoundedDocumentSource({
            id: "integration-pdf",
            name: "sample.pdf",
            size: bytes.byteLength,
            mimeType: "application/pdf",
            reader: {
                read: async (offset, length) => bytes.slice(offset, offset + length).buffer,
            },
        })
        const service = new DocumentService()
        service.adapters.register(pdfDocumentAdapter)

        await expect(service.probe(source)).resolves.toEqual([pdfDocumentAdapter])
        const document = await service.open(source)
        expect(document.kind).toBe("paged")
        if (document.kind !== "paged") throw new Error("Expected a paged document")
        expect(document.pageCount).toBe(1)
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
        await expect(document.getPage(1)).resolves.toMatchObject({
            pageNumber: 1,
            width: 612,
            height: 792,
        })

        await service.close(document)
        expect(service.openDocumentCount).toBe(0)
    })
})
