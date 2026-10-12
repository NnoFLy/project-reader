import { beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("$app/environment", () => ({ browser: true }))

const {
    put,
    deleteRecord,
    get,
    serializeBookMutation,
    serializeMetadataMutation,
    bulkDelete,
    getAll,
    nodes,
    notifyDeleting,
    onNodesDeleting,
    initialized,
    disposed,
} = vi.hoisted(() => {
    const nodes: Record<string, { type: "file" }> = { "book-1": { type: "file" } }
    const disposed = { value: false }
    let deletingListener: ((ids: string[]) => void) | undefined
    return {
        put: vi.fn(async () => undefined),
        deleteRecord: vi.fn(async () => undefined),
        get: vi.fn(async () => undefined),
        serializeBookMutation: vi.fn(async (_bookId: string, mutation: () => Promise<unknown>) =>
            mutation(),
        ),
        serializeMetadataMutation: vi.fn(async (mutation: () => Promise<unknown>) => mutation()),
        bulkDelete: vi.fn(async () => undefined),
        getAll: vi.fn(async () => []),
        nodes,
        get allFiles() {
            return Object.entries(nodes).map(([id]) => ({ id, type: "file" as const }))
        },
        initialized: { value: true },
        disposed,
        notifyDeleting: (ids: string[]) => deletingListener?.(ids),
        onNodesDeleting: vi.fn((listener: (ids: string[]) => void) => {
            deletingListener = listener
        }),
    }
})

vi.mock("../viewerHost", () => ({
    viewerLibraryCapability: {
        nodes,
        get initialized() {
            return initialized.value
        },
        get isDisposed() {
            return disposed.value
        },
        get allFiles() {
            return Object.entries(nodes).map(([id]) => ({ id, type: "file" as const }))
        },
        onNodesDeleting,
        isNodeDeleting: vi.fn(() => false),
        getBookmarks: getAll,
        db: {
            bookmarks: {
                put,
                delete: deleteRecord,
                get,
                bulkDelete,
                getAll,
            },
        },
    },
    viewerLibraryMutationCapability: {
        serializeBookMutation,
        serializeMetadataMutation,
        putBookmark: put,
        deleteBookmark: deleteRecord,
        deleteBookmarks: bulkDelete,
    },
    isViewerLibraryCapabilityInstalled: () => true,
    getViewerLibraryCapability: () => undefined,
    getViewerLibraryMutationCapability: () => undefined,
}))

import { bookmarksStore } from "./bookmarksStore.svelte"

const bookmark = {
    id: "bookmark-1",
    bookId: "book-1",
    pageNumber: 2,
    name: "Chapter",
    createdAt: 1,
}

describe("bookmarksStore book deletion races", () => {
    beforeEach(() => {
        put.mockClear()
        deleteRecord.mockClear()
        get.mockReset()
        get.mockResolvedValue(undefined)
        serializeBookMutation.mockReset()
        serializeMetadataMutation.mockReset()
        serializeMetadataMutation.mockImplementation(async (mutation: () => Promise<unknown>) =>
            mutation(),
        )
        serializeBookMutation.mockImplementation(
            async (_bookId: string, mutation: () => Promise<unknown>) => mutation(),
        )
        bulkDelete.mockClear()
        getAll.mockReset()
        getAll.mockResolvedValue([])
        initialized.value = true
        disposed.value = false
        nodes["book-1"] = { type: "file" }
        bookmarksStore.bookmarks = [{ ...bookmark }]
    })

    it("does not bulk-delete bookmarks before VFS initialization", async () => {
        initialized.value = false
        getAll.mockResolvedValueOnce([bookmark] as any)

        await bookmarksStore.loadAllBookmarks()

        expect(bulkDelete).not.toHaveBeenCalled()
    })

    it("serializes stale cleanup through the VFS metadata boundary", async () => {
        const stale = { ...bookmark, id: "stale", bookId: "missing-book" }
        getAll.mockResolvedValueOnce([stale] as any)
        let releaseCleanup!: () => void
        serializeMetadataMutation.mockImplementationOnce(
            (mutation: () => Promise<unknown>) =>
                new Promise<boolean>(
                    (resolve) =>
                        (releaseCleanup = () => {
                            void mutation().then(() => resolve(true))
                        }),
                ),
        )

        const loading = bookmarksStore.loadAllBookmarks()
        await vi.waitFor(() => expect(serializeMetadataMutation).toHaveBeenCalledOnce())
        expect(bulkDelete).not.toHaveBeenCalled()

        releaseCleanup()
        await loading
        expect(bulkDelete).toHaveBeenCalledWith([stale.id])
    })

    it("does not let a delayed load hide a completed add", async () => {
        let resolveLoad!: (records: (typeof bookmark)[]) => void
        getAll.mockImplementationOnce(
            () =>
                new Promise<(typeof bookmark)[]>((resolve) => {
                    resolveLoad = resolve
                }) as any,
        )
        bookmarksStore.bookmarks = []
        const loading = bookmarksStore.loadAllBookmarks()
        await Promise.resolve()
        const adding = bookmarksStore.addBookmark("book-1", 1, "Added")
        resolveLoad([])

        await Promise.all([loading, adding])

        expect(bookmarksStore.bookmarks).toHaveLength(1)
        expect(bookmarksStore.bookmarks[0]).toMatchObject({ name: "Added" })
    })

    it("does not let a delayed load hide a completed update", async () => {
        let resolveLoad!: (records: (typeof bookmark)[]) => void
        getAll.mockImplementationOnce(
            () =>
                new Promise<(typeof bookmark)[]>((resolve) => {
                    resolveLoad = resolve
                }) as any,
        )
        const loading = bookmarksStore.loadAllBookmarks()
        await Promise.resolve()
        const updating = bookmarksStore.updateBookmark(bookmark.id, "Renamed")
        resolveLoad([])

        await Promise.all([loading, updating])

        expect(bookmarksStore.bookmarks[0]).toMatchObject({ name: "Renamed" })
    })

    it("does not write a bookmark for a missing book", async () => {
        delete nodes["book-1"]

        await expect(bookmarksStore.addBookmark("book-1", 1, "Missing")).resolves.toBeNull()
        expect(put).not.toHaveBeenCalled()
    })

    it("clears a successful deletion tombstone in finally", async () => {
        await bookmarksStore.deleteBookmark(bookmark.id)
        bookmarksStore.bookmarks = [{ ...bookmark }]

        await bookmarksStore.updateBookmark(bookmark.id, "Retried")

        expect(put).toHaveBeenCalledWith(
            expect.objectContaining({ id: bookmark.id, name: "Retried" }),
        )
    })

    it("clears a failed deletion tombstone so the bookmark can be updated", async () => {
        deleteRecord.mockRejectedValueOnce(new Error("delete failed"))

        await bookmarksStore.deleteBookmark(bookmark.id)
        await bookmarksStore.updateBookmark(bookmark.id, "Retried")

        expect(put).toHaveBeenCalledWith(
            expect.objectContaining({ id: bookmark.id, name: "Retried" }),
        )
    })

    it("removes a bookmark written after deletion starts", async () => {
        bookmarksStore.bookmarks = []
        let resolvePut!: () => void
        put.mockImplementationOnce(
            () =>
                new Promise<undefined>((resolve) => {
                    resolvePut = () => resolve(undefined)
                }),
        )
        const adding = bookmarksStore.addBookmark("book-1", 1, "Chapter")
        await Promise.resolve()
        delete nodes["book-1"]
        notifyDeleting(["book-1"])
        resolvePut()

        await expect(adding).resolves.toBeNull()
        // The active deletion tombstone owns cleanup; the pending add must not issue a
        // compensating raw delete of its own.
        expect(deleteRecord).not.toHaveBeenCalled()
    })

    it("serializes an orphan deletion without a live file node", async () => {
        bookmarksStore.bookmarks = []
        get.mockResolvedValueOnce({ ...bookmark, bookId: "missing-book" } as any)

        await bookmarksStore.deleteBookmark(bookmark.id)

        expect(serializeMetadataMutation).toHaveBeenCalledWith(expect.any(Function))
        expect(deleteRecord).toHaveBeenCalledWith(bookmark.id)
    })

    it("serializes an unknown deletion behind an earlier bookmark write", async () => {
        bookmarksStore.bookmarks = []
        let resolvePut!: () => void
        let addedId!: string
        put.mockImplementationOnce((record?: { id: string }) => {
            addedId = record!.id
            return new Promise<undefined>((resolve) => {
                resolvePut = () => resolve(undefined)
            })
        })
        let tail = Promise.resolve()
        const serialize = (_mutation: () => Promise<unknown>) => {
            const result = tail.then(_mutation)
            tail = result.then(
                () => undefined,
                () => undefined,
            )
            return result
        }
        serializeBookMutation.mockImplementation(
            (_bookId: string, mutation: () => Promise<unknown>) => serialize(mutation),
        )
        serializeMetadataMutation.mockImplementation((mutation: () => Promise<unknown>) =>
            serialize(mutation),
        )

        const adding = bookmarksStore.addBookmark("book-1", 1, "Added")
        await Promise.resolve()
        expect(addedId).toBeDefined()
        const deleting = bookmarksStore.deleteBookmark(addedId)
        resolvePut()

        await Promise.all([adding, deleting])

        expect(serializeBookMutation).toHaveBeenCalledTimes(1)
        expect(serializeMetadataMutation).toHaveBeenCalledTimes(1)
        expect(deleteRecord).toHaveBeenCalledWith(addedId)
        expect(bookmarksStore.bookmarks).toEqual([])
    })

    it("does not restore bookmarks after deletion invalidates an in-flight load", async () => {
        let resolveLoad!: (records: (typeof bookmark)[]) => void
        getAll.mockImplementationOnce(
            () =>
                new Promise<(typeof bookmark)[]>((resolve) => {
                    resolveLoad = resolve
                }) as any,
        )
        bookmarksStore.bookmarks = []
        const loading = bookmarksStore.loadAllBookmarks()
        await Promise.resolve()
        delete nodes["book-1"]
        notifyDeleting(["book-1"])
        resolveLoad([bookmark])

        await loading

        expect(bookmarksStore.bookmarks).toEqual([])
    })

    it("does not republish an update that loses a concurrent deletion", async () => {
        let resolvePut!: () => void
        put.mockImplementationOnce(
            () =>
                new Promise<undefined>((resolve) => {
                    resolvePut = () => resolve(undefined)
                }),
        )

        const updating = bookmarksStore.updateBookmark(bookmark.id, "Renamed")
        await Promise.resolve()
        const deleting = bookmarksStore.deleteBookmark(bookmark.id)
        resolvePut()

        await Promise.all([updating, deleting])

        expect(bookmarksStore.bookmarks).toEqual([])
    })

    it("skips an update when its book is missing", async () => {
        delete nodes["book-1"]

        await bookmarksStore.updateBookmark(bookmark.id, "Renamed")

        expect(put).not.toHaveBeenCalled()
    })

    it("does not publish a pending load after disposal", async () => {
        let resolveLoad!: (records: (typeof bookmark)[]) => void
        getAll.mockImplementationOnce(
            () =>
                new Promise<(typeof bookmark)[]>((resolve) => {
                    resolveLoad = resolve
                }) as any,
        )
        bookmarksStore.bookmarks = []
        const loading = bookmarksStore.loadAllBookmarks()
        await Promise.resolve()

        disposed.value = true
        resolveLoad([{ ...bookmark }])
        await loading
        disposed.value = false

        expect(bookmarksStore.bookmarks).toEqual([])
    })

    it("logs a sanitized diagnostic when loading fails", async () => {
        const error = new Error("secret bookmark content")
        getAll.mockRejectedValueOnce(error)
        const log = vi.spyOn(console, "error").mockImplementation(() => undefined)

        await bookmarksStore.loadAllBookmarks()

        expect(log).toHaveBeenCalledWith("[BookmarksStore] Failed to load bookmarks:", {
            code: "ViewerStorageError",
            message: "Unable to load bookmarks",
        })
        expect(JSON.stringify(log.mock.calls[0])).not.toContain(error.message)
        log.mockRestore()
    })

    it("does not publish a bookmark write that finishes after disposal", async () => {
        let resolvePut!: () => void
        put.mockImplementationOnce(
            () =>
                new Promise<undefined>((resolve) => {
                    resolvePut = () => resolve(undefined)
                }),
        )
        bookmarksStore.bookmarks = [{ ...bookmark }]
        const updating = bookmarksStore.updateBookmark(bookmark.id, "Persisted")
        await Promise.resolve()

        disposed.value = true
        bookmarksStore.dispose()
        resolvePut()
        await updating

        expect(bookmarksStore.bookmarks).toEqual([])

        put.mockClear()
        deleteRecord.mockClear()
        await expect(bookmarksStore.addBookmark("book-1", 1, "After disposal")).resolves.toBeNull()
        await bookmarksStore.updateBookmark(bookmark.id, "After disposal")
        await bookmarksStore.deleteBookmark(bookmark.id)
        expect(put).not.toHaveBeenCalled()
        expect(deleteRecord).not.toHaveBeenCalled()

        getAll.mockClear()
        await bookmarksStore.loadAllBookmarks()
        expect(getAll).not.toHaveBeenCalled()
    })
})
