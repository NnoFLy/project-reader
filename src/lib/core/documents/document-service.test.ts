import { describe, expect, it, vi } from "vitest"
import type { DocumentAdapter, DocumentSource, OpenedDocument } from "$lib/document-model"
import { DocumentAdapterRegistry, DocumentService, UnsupportedDocumentError } from "."
import { createBoundedDocumentSource } from "$lib/core/files"
import { createFakeDocumentAdapter } from "./fake-document-adapter"

function source(name = "sample.fake", close?: () => Promise<void>): DocumentSource {
    return {
        ...createBoundedDocumentSource({
            id: "sample",
            name,
            size: 3,
            reader: { read: async () => new Uint8Array([1, 2, 3]).buffer },
        }),
        close,
    }
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

    it("closes a document when cancellation happens after adapter open", async () => {
        const registry = new DocumentAdapterRegistry()
        const close = vi.fn()
        const controller = new AbortController()
        const adapter: DocumentAdapter = {
            id: "test.cancelled-open",
            extensions: ["fake"],
            mimeTypes: [],
            probe: vi.fn(async () => ({ supported: true })),
            open: vi.fn(async () => {
                controller.abort()
                return closedDocument(close)
            }),
        }
        registry.register(adapter)
        const service = new DocumentService(registry)

        await expect(service.open(source(), controller.signal)).rejects.toMatchObject({
            name: "AbortError",
        })
        expect(close).toHaveBeenCalledOnce()
        expect(service.openDocumentCount).toBe(0)
    })

    it("removes a document from tracking when close fails", async () => {
        const registry = new DocumentAdapterRegistry()
        const document: OpenedDocument = {
            ...closedDocument(() => undefined),
            async close() {
                throw new Error("close failed")
            },
        }
        const adapter: DocumentAdapter = {
            id: "test.close-failure",
            extensions: ["fake"],
            mimeTypes: [],
            probe: vi.fn(async () => ({ supported: true })),
            open: vi.fn(async () => document),
        }
        registry.register(adapter)
        const service = new DocumentService(registry)
        await service.open(source())

        await expect(service.close(document)).rejects.toThrow("close failed")
        expect(service.openDocumentCount).toBe(0)
    })

    it("closes every tracked document when one cleanup fails", async () => {
        const registry = new DocumentAdapterRegistry()
        const firstClose = vi.fn(async () => {
            throw new Error("first close failed")
        })
        const secondClose = vi.fn()
        const documents: OpenedDocument[] = [
            { ...closedDocument(firstClose), close: firstClose },
            { ...closedDocument(secondClose), close: secondClose },
        ]
        const adapter: DocumentAdapter = {
            id: "test.close-all",
            extensions: ["fake"],
            mimeTypes: [],
            probe: vi.fn(async () => ({ supported: true })),
            open: vi.fn(async () => documents.shift()!),
        }
        registry.register(adapter)
        const service = new DocumentService(registry)
        await service.open(source())
        await service.open(source("second.fake"))

        await expect(service.closeAll()).rejects.toThrow("first close failed")
        expect(firstClose).toHaveBeenCalledOnce()
        expect(secondClose).toHaveBeenCalledOnce()
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

    it("closes the source when probing fails or no adapter supports it", async () => {
        const close = vi.fn(async () => undefined)
        const registry = new DocumentAdapterRegistry()
        registry.register({
            id: "test.probe-failure",
            extensions: ["fake"],
            mimeTypes: [],
            probe: vi.fn(async () => {
                throw new Error("probe failed")
            }),
            open: vi.fn(),
        })
        const service = new DocumentService(registry)

        await expect(service.open(source("sample.fake", close))).rejects.toThrow("probe failed")
        expect(close).toHaveBeenCalledOnce()

        await expect(
            new DocumentService().open(source("sample.unknown", close)),
        ).rejects.toBeInstanceOf(UnsupportedDocumentError)
        expect(close).toHaveBeenCalledTimes(2)
    })
})
