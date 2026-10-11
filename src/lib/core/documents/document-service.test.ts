import { describe, expect, it, vi } from "vitest"
import type { DocumentAdapter, DocumentSource, OpenedDocument } from "$lib/document-model"
import { DocumentAdapterRegistry, DocumentService, UnsupportedDocumentError } from "."
import { createBoundedDocumentSource } from "$lib/core/files"
import { createFakeDocumentAdapter } from "./fake-document-adapter"

function source(name = "sample.fake"): DocumentSource {
    return createBoundedDocumentSource({
        id: "sample",
        name,
        size: 3,
        reader: { read: async () => new Uint8Array([1, 2, 3]).buffer },
    })
}

function closedDocument(onClose: () => void): OpenedDocument {
    return {
        kind: "reflowable",
        metadata: { title: null, author: null },
        capabilities: new Set(),
        async getSections() {
            return []
        },
        async close() {
            onClose()
        },
    }
}

describe("DocumentService", () => {
    it("routes through probes before opening and tracks close lifecycle", async () => {
        const registry = new DocumentAdapterRegistry()
        const close = vi.fn()
        const adapter: DocumentAdapter = {
            id: "test.probe",
            extensions: ["fake"],
            mimeTypes: [],
            probe: vi.fn(async () => ({ supported: true, confidence: 1 })),
            open: vi.fn(async () => closedDocument(close)),
        }
        registry.register(adapter)
        const service = new DocumentService(registry)

        const document = await service.open(source())
        expect(adapter.probe).toHaveBeenCalledOnce()
        expect(adapter.open).toHaveBeenCalledOnce()
        expect(service.openDocumentCount).toBe(1)
        await service.close(document)
        expect(close).toHaveBeenCalledOnce()
        expect(service.openDocumentCount).toBe(0)
    })

    it("uses the safe fake adapter and rejects unsupported sources", async () => {
        const service = new DocumentService()
        service.adapters.register(createFakeDocumentAdapter())
        const document = await service.open(source())
        expect(document.kind).toBe("paged")
        if (document.kind !== "paged") throw new Error("Expected fake document to be paged")
        expect(document.pageCount).toBe(2)
        await document.close()
        await expect(service.open(source("sample.unknown"))).rejects.toBeInstanceOf(
            UnsupportedDocumentError,
        )
    })
})
