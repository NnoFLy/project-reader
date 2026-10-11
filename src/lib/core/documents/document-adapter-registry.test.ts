import { describe, expect, it } from "vitest"
import type { DocumentAdapter } from "$lib/document-model"
import { DocumentAdapterRegistry } from "./document-adapter-registry"

const adapter = (id: string): DocumentAdapter => ({
    id,
    extensions: ["test"],
    mimeTypes: ["application/test"],
    probe: async () => ({ supported: true }),
    open: async () => ({
        kind: "reflowable",
        metadata: { title: null, author: null },
        capabilities: new Set(),
        close: async () => undefined,
        getSections: async () => [],
    }),
})

describe("DocumentAdapterRegistry", () => {
    it("registers adapters for the document service and removes only its own registration", () => {
        const registry = new DocumentAdapterRegistry()
        const first = adapter("test.first")
        const second = adapter("test.second")
        const firstDisposable = registry.register(first)
        registry.register(second)

        expect(registry.list()).toEqual([first, second])
        firstDisposable.dispose()
        expect(registry.get(first.id)).toBeUndefined()
        expect(registry.get(second.id)).toBe(second)
    })

    it("rejects empty and duplicate adapter IDs", () => {
        const registry = new DocumentAdapterRegistry()
        expect(() => registry.register(adapter(" "))).toThrow("ID is required")
        registry.register(adapter("test.same"))
        expect(() => registry.register(adapter("test.same"))).toThrow("already registered")
    })
})
