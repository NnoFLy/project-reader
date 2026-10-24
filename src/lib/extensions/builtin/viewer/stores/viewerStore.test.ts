import { describe, expect, it } from "vitest"
import { createExtensionStorage, MemoryStorageBackend } from "$lib/core/storage"
import type {
    ViewerFileCapability,
    ViewerLibraryCapability,
    ViewerLibraryMutationCapability,
} from "../viewerHost"
import { ViewerStore } from "./viewerStore.svelte"
import { ReadingStorage } from "../readingStorage"

function reader() {
    const released: string[] = []
    const acquisitions: string[] = []
    const nodes = {
        book: { id: "book", name: "Book", type: "file" as const, updatedAt: 1, metadata: {} },
        next: { id: "next", name: "Next", type: "file" as const, updatedAt: 1, metadata: {} },
    }
    const files: ViewerFileCapability = {
        nodes,
        isLockedMap: {},
        getFileUrl: async (id) => {
            acquisitions.push(id)
            return `blob:${id}`
        },
        restoreFileAccess: async () => undefined,
        requestRelink() {},
        waitForRelink: async () => undefined,
        releaseFileUrl: (_id, url) => {
            released.push(url)
            return true
        },
        getContentGeneration: () => 0,
        isCurrentContent: () => true,
        isCurrentFileUrl: () => true,
        clearForwardHistory() {},
    }
    let invalidate: (id: string) => void = () => undefined
    const library: ViewerLibraryCapability = {
        ...files,
        isLockedMap: {},
        allFiles: Object.values(nodes),
        initialized: true,
        isDisposed: false,
        onNodesDeleted: () => () => undefined,
        onNodesDeleting: () => () => undefined,
        onNodeRelinked: () => () => undefined,
        onContentRestored: () => () => undefined,
        onNodeInvalidated: (listener) => {
            invalidate = listener
            return () => undefined
        },
        isNodeDeleting: () => false,
        getIndexedTexts: async () => [],
        getPreviewUrl: async () => "",
        getFolderPath: () => "",
    }
    const mutations: ViewerLibraryMutationCapability = {
        releaseFileUrl: (id, url) => files.releaseFileUrl(id, url ?? ""),
        setActiveFileId() {},
        serializeBookMutation: async (_id, mutation) => mutation(),
        serializeMetadataMutation: async (mutation) => mutation(),
        saveIndexedTexts: async () => true,
        revokePreviewUrl() {},
        invalidatePreview: async () => undefined,
        updateFile: async () => undefined,
        pushForwardHistory() {},
        clearForwardHistory() {},
    }
    const store = new ViewerStore({ files, library, mutations })
    const storage = createExtensionStorage(new MemoryStorageBackend(), "builtin.viewer").namespace(
        "viewer",
    )
    const savedBook = {
        id: "book",
        name: "Book",
        pageNumber: 7,
        scrollPosition: 0.35,
        totalPages: 12,
        updatedAt: 1,
        url: "",
    }
    return {
        store,
        storage,
        savedBook,
        files,
        library,
        mutations,
        released,
        acquisitions,
        invalidate: (id: string) => invalidate(id),
    }
}

describe("Viewer synchronization through the Reading workspace", () => {
    it("preview invalidation preserves current-source annotation access but content supersession fences it", async () => {
        const { store, storage, files, library, invalidate } = reader()
        await store.configureStorage(storage)
        await store.workspace.open("book")
        invalidate("book")
        const input = {
            pageNumber: 1,
            start: 0,
            end: 4,
            text: "Text",
            noteContent: "Note",
            color: "yellow" as const,
            association: { contentHash: null, verification: "unverified" as const },
        }
        expect((await store.workspace.createNote("book", input)).ok).toBe(true)
        files.getContentGeneration = () => 1
        files.isCurrentContent = (_id, generation) => generation === 1
        library.getContentGeneration = files.getContentGeneration
        library.isCurrentContent = files.isCurrentContent
        invalidate("book")
        expect((await store.workspace.createNote("book", input)).ok).toBe(false)
        await store.dispose()
    })

    it.each(["deleted", "stale-url", "inactive"])(
        "does not exempt %s resources from invalidation",
        async (condition) => {
            const { store, storage, files, library, invalidate } = reader()
            await store.configureStorage(storage)
            await store.workspace.open("book")
            if (condition === "deleted") library.isNodeDeleting = () => true
            if (condition === "stale-url") library.isCurrentFileUrl = () => false
            if (condition === "inactive") await store.workspace.open("next")
            invalidate("book")
            expect(
                (
                    await store.workspace.createNote("book", {
                        pageNumber: 1,
                        start: 0,
                        end: 4,
                        text: "Text",
                        noteContent: "Note",
                        color: "yellow",
                        association: { contentHash: null, verification: "unverified" },
                    })
                ).ok,
            ).toBe(false)
            expect(files.nodes.book).toBeDefined()
            await store.dispose()
        },
    )

    it("preserves restored reading position when acquiring a fresh source", async () => {
        const { store, storage, acquisitions } = reader()
        const reading = new ReadingStorage(storage)
        await reading.writeCurrent("book")
        await reading.writeDocument("book", {
            pageNumber: 7,
            scrollPosition: 0.35,
            scale: 2,
            layout: "split",
        })
        await store.configureStorage(storage)
        expect(store.getCurrentBook()).toMatchObject({ pageNumber: 7, url: "blob:book" })
        expect(store.scale).toBe(2)
        expect(store.layout).toBe("split")
        await store.syncWithBooks()
        expect(store.getCurrentBook()).toMatchObject({
            pageNumber: 7,
            scrollPosition: 0.35,
            url: "blob:book",
        })
        expect(acquisitions).toEqual(["book"])
        await store.dispose()
    })

    it("shares synchronization and never publishes it over a newer document selection", async () => {
        const { store, storage, savedBook, files, released } = reader()
        await store.configureStorage(storage)
        await store.workspace.open("book")
        files.isCurrentContent = () => false
        let finish!: (url: string) => void
        files.getFileUrl = (id) =>
            id === "book"
                ? new Promise<string>((resolve) => {
                      finish = resolve
                  })
                : Promise.resolve("blob:next")
        files.isCurrentContent = (_id, generation) => generation === 1
        files.getContentGeneration = () => 1
        const first = store.syncWithBooks()
        const second = store.syncWithBooks()
        await store.setCurrentBook({ ...savedBook, id: "next", name: "Next" })
        finish("blob:stale")
        await Promise.all([first, second])
        expect(store.getCurrentBook()).toMatchObject({ id: "next", url: "blob:next" })
        expect(released).toEqual(["blob:book", "blob:stale"])
        await store.dispose()
    })

    it("ignores and preserves legacy whole-book records without acquiring their sources", async () => {
        const { store, storage, savedBook, released, acquisitions, files } = reader()
        await storage.set("book", {
            ...savedBook,
            url: "blob:previous-process",
            previewDataUrl: "blob:previous-preview",
        })
        await store.configureStorage(storage)
        expect(store.getCurrentBook()).toBeNull()
        await store.syncWithBooks()
        expect(acquisitions).toEqual([])
        files.nodes.book!.metadata.pageNumber = 9
        await store.workspace.open("book")
        expect(store.getCurrentBook()).toMatchObject({ pageNumber: 1, scrollPosition: 0 })
        await store.flushReadingState()
        expect(await storage.get("book")).toMatchObject({
            pageNumber: 7,
            url: "blob:previous-process",
        })
        await store.dispose()
        expect(released).toEqual(["blob:book"])
    })

    it("does not access Library resources from late metadata callbacks after disposal", async () => {
        const { store, savedBook, mutations, files } = reader()
        await store.dispose()
        files.getContentGeneration = () => {
            throw new Error("Disposed access")
        }
        mutations.updateFile = async () => {
            throw new Error("Disposed mutation")
        }
        await expect(store.updateBook(savedBook)).resolves.toBeUndefined()
    })
})
