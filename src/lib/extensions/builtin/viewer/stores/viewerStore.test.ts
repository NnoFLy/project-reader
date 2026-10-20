import { describe, expect, it } from "vitest"
import { createExtensionStorage, MemoryStorageBackend } from "$lib/core/storage"
import type {
    ViewerFileCapability,
    ViewerLibraryCapability,
    ViewerLibraryMutationCapability,
} from "../viewerHost"
import { ViewerStore } from "./viewerStore.svelte"

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
        onNodeInvalidated: () => () => undefined,
        isNodeDeleting: () => false,
        getIndexedTexts: async () => [],
        getUserNotes: async () => [],
        getBookmarks: async () => [],
        getPreviewUrl: async () => "",
        getFolderPath: () => "",
    }
    const mutations: ViewerLibraryMutationCapability = {
        releaseFileUrl: (id, url) => files.releaseFileUrl(id, url ?? ""),
        setActiveFileId() {},
        serializeBookMutation: async (_id, mutation) => mutation(),
        serializeMetadataMutation: async (mutation) => mutation(),
        saveIndexedTexts: async () => true,
        putUserNote: async () => "",
        deleteUserNote: async () => undefined,
        putBookmark: async () => "",
        deleteBookmark: async () => undefined,
        deleteBookmarks: async () => undefined,
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
    return { store, storage, savedBook, files, mutations, released, acquisitions }
}

describe("Viewer synchronization through the Reading workspace", () => {
    it("preserves restored reading position when acquiring a fresh source", async () => {
        const { store, storage, savedBook, acquisitions } = reader()
        await storage.set("book", savedBook)
        await store.configureStorage(storage)
        expect(store.getCurrentBook()).toMatchObject({ pageNumber: 7, url: "" })
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
        await storage.set("book", savedBook)
        await store.configureStorage(storage)
        let finish!: (url: string) => void
        files.getFileUrl = (id) =>
            id === "book"
                ? new Promise<string>((resolve) => {
                      finish = resolve
                  })
                : Promise.resolve("blob:next")
        const first = store.syncWithBooks()
        const second = store.syncWithBooks()
        await store.setCurrentBook({ ...savedBook, id: "next", name: "Next" })
        finish("blob:stale")
        await Promise.all([first, second])
        expect(store.getCurrentBook()).toMatchObject({ id: "next", url: "blob:next" })
        expect(released).toEqual(["blob:stale"])
        await store.dispose()
    })

    it("discards saved transient URLs and cleans up the reacquired claim", async () => {
        const { store, storage, savedBook, released } = reader()
        await storage.set("book", {
            ...savedBook,
            url: "blob:previous-process",
            previewDataUrl: "blob:previous-preview",
        })
        await store.configureStorage(storage)
        expect(store.getCurrentBook()).toMatchObject({ url: "", previewDataUrl: "" })
        await store.syncWithBooks()
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
