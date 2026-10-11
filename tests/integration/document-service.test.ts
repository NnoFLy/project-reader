import { describe, expect, it, vi } from "vitest"
import type { DocumentSource } from "$lib/document-model"
import { createBoundedDocumentSource } from "$lib/core/files"
import { DocumentAdapterRegistry, DocumentService } from "$lib/core/documents"
import { createFakeDocumentAdapter } from "$lib/core/documents/fake-document-adapter"

function source(name = "sample.fake", close = vi.fn(async () => undefined)): DocumentSource {
    return createBoundedDocumentSource({
        id: "sample",
        name,
        size: 3,
        mimeType: "application/x-fake-document",
        reader: {
            read: async () => new Uint8Array([1, 2, 3]).buffer,
            close,
        },
    })
}

describe("DocumentService integration", () => {
    it("routes a framework-neutral source through the fake adapter contract", async () => {
        const registry = new DocumentAdapterRegistry()
        const adapter = createFakeDocumentAdapter({
            id: "integration.fake",
            extension: "fake",
            mimeType: "application/x-fake-document",
            pageCount: 3,
        })
        registry.register(adapter)
        const service = new DocumentService(registry)
        const documentSource = source()

        expect(documentSource).toMatchObject({
            id: "sample",
            name: "sample.fake",
            size: 3,
            mimeType: "application/x-fake-document",
        })
        await expect(service.probe(documentSource)).resolves.toEqual([adapter])
        const document = await service.open(documentSource)
        expect(document.kind).toBe("paged")
        if (document.kind !== "paged") throw new Error("Expected a paged document")
        expect(document.pageCount).toBe(3)
        await expect(document.getPage(2)).resolves.toMatchObject({
            pageNumber: 2,
            width: 600,
            height: 800,
        })
        await service.close(document)
        expect(service.openDocumentCount).toBe(0)
        await expect(documentSource.read()).rejects.toThrow("Document source is closed")
    })
})
