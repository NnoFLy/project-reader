// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest"
import { Blob as NodeBlob } from "node:buffer"
import { URL as NodeURL } from "node:url"
import { createExtensionStorage, MemoryStorageBackend } from "$lib/core/storage"
import type { ViewerPagedDocument } from "$lib/extensions/builtin/viewer/viewerDocument"
import { createBuiltinHost } from "$lib/extensions/builtin"
import * as viewerModule from "$lib/extensions/builtin/viewer/stores/viewerStore.svelte"
import * as searchModule from "$lib/extensions/builtin/viewer/stores/searchStore.svelte"

vi.hoisted(() => {
    // Seed before module evaluation to observe import-time preservation, not a cached import.
    localStorage.setItem("search_history", '["unsupported old query"]')
    window.matchMedia = (() => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
    })) as unknown as typeof window.matchMedia
})

vi.mock("$app/navigation", async (importOriginal) => ({
    ...(await importOriginal<typeof import("$app/navigation")>()),
    pushState: vi.fn(),
}))

afterEach(() => {
    localStorage.clear()
    vi.unstubAllGlobals()
})

it("preserves unsupported search history when the host modules are imported", () => {
    expect(localStorage.getItem("search_history")).toBe('["unsupported old query"]')
})

it("shares the host write lifetime with Reading workspace search and never revives disposed writers", async () => {
    vi.stubGlobal("Blob", NodeBlob)
    vi.stubGlobal("URL", NodeURL)
    const backend = new MemoryStorageBackend()
    const library = createExtensionStorage(backend, "builtin.library").namespace("library")
    await library.set("books.book", {
        id: "book",
        name: "Reading.fake",
        type: "file",
        parentId: null,
        createdAt: 1,
        updatedAt: 1,
        isPinned: false,
        size: 1,
        metadata: { pageNumber: 1 },
    })
    await library.set("fileContents.book", { id: "book", file: new Blob(["source"]) })
    async function startReader(signal?: AbortSignal) {
        const host = createBuiltinHost({ storage: backend, hostContext: { writeSignal: signal } })
        host.documentService.adapters.register({
            id: "integration.reader",
            extensions: ["fake"],
            mimeTypes: [],
            probe: async () => ({ supported: true }),
            open: async () => ({
                kind: "paged",
                metadata: { title: "Reading", author: null, pageCount: 1 },
                capabilities: new Set(),
                pageCount: 1,
                getPage: async (pageNumber) => ({ pageNumber, width: 600, height: 800 }),
                renderPage: async () => {
                    throw new Error("Not rendering in this test")
                },
                close: async () => undefined,
            }),
        })
        await host.start()
        const store = viewerModule.viewerStore
        // Search UI's document adapter receives the workspace-owned document.
        await expect(store.workspace.open("book")).resolves.toBe(true)
        const pdf = (await store.workspace.loadDocument()) as ViewerPagedDocument
        if (pdf?.kind !== "paged") throw new Error("Expected the Reading workspace document")
        const search = searchModule.searchStore
        search.initDocument({ pdf, bookId: "book" })
        return { host, search, pdf }
    }
    const controller = new AbortController()
    const first = await startReader(controller.signal)
    let second: Awaited<ReturnType<typeof startReader>> | undefined
    let third: Awaited<ReturnType<typeof startReader>> | undefined
    try {
        first.search.addToHistory("saved query")
        controller.abort()
        first.search.addToHistory("obsolete query")
        first.search.clearHistory()
        second = await startReader()
        expect(second.search.searchHistory).toEqual(["saved query"])
        await second.host.dispose()
        second.search.resetLifecycle()
        second.search.initDocument({ pdf: second.pdf, bookId: "book" })
        second.search.addToHistory("disposed writer")
        second.search.clearHistory()
        third = await startReader()
        expect(third.search.searchHistory).toEqual(["saved query"])
    } finally {
        await Promise.all([first.host.dispose(), second?.host.dispose(), third?.host.dispose()])
    }
})
