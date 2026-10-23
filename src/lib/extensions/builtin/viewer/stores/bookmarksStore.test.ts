import { describe, expect, it } from "vitest"
import { createExtensionStorage, MemoryStorageBackend } from "$lib/core/storage"
import { ReadingWorkspace } from "../readingWorkspace"
import { ReadingStorage } from "../readingStorage"
import type { ViewerFileCapability, ViewerLibraryCapability } from "../viewerHost"
import { BookmarksStore } from "./bookmarksStore.svelte"

function reader() {
    const backend = new MemoryStorageBackend()
    const nodes = { a: { id: "a", type: "file" }, b: { id: "b", type: "file" } }
    const files = {
        nodes,
        allFiles: Object.values(nodes),
        initialized: true,
        getContentGeneration: () => 0,
    } as unknown as ViewerLibraryCapability & ViewerFileCapability
    const storage = new ReadingStorage(createExtensionStorage(backend, "test.viewer"))
    const workspace = new ReadingWorkspace({
        files,
        storage,
        getCurrentBook: () => null,
        publish: () => true,
    })
    return { backend, workspace, bookmarks: new BookmarksStore(workspace, files) }
}

describe("BookmarksStore workspace presentation adapter", () => {
    it("loads, renames and deletes independent document bookmarks without legacy records", async () => {
        const { workspace, bookmarks } = reader()
        try {
            const a = await bookmarks.addBookmark("a", 2, "A")
            const b = await bookmarks.addBookmark("b", 3, "B")
            await bookmarks.loadAllBookmarks()
            expect(bookmarks.bookmarks).toEqual(expect.arrayContaining([a, b]))
            expect(await bookmarks.updateBookmark(a!.id, "Renamed")).toBe(true)
            expect(workspace.annotations("a").bookmarks).toMatchObject([{ name: "Renamed" }])
            expect(await bookmarks.deleteBookmark(b!.id)).toBe(true)
            expect(await workspace.getReadingSummary("b")).toEqual({
                documentId: "b",
                noteCount: 0,
                bookmarkCount: 0,
            })
            expect(bookmarks.bookmarks).toMatchObject([{ bookId: "a", name: "Renamed" }])
        } finally {
            bookmarks.dispose()
            await workspace.dispose()
        }
    })

    it("retains failed changes in the workspace and never deletes unknown records", async () => {
        const { backend, workspace, bookmarks } = reader()
        try {
            const bookmark = await bookmarks.addBookmark("a", 1, "Original")
            const set = backend.set.bind(backend)
            backend.set = async (key, value) => {
                if (key.includes("reading-v1-annotations-")) throw new Error("unavailable")
                await set(key, value)
            }
            expect(await bookmarks.updateBookmark(bookmark!.id, "Kept")).toBe(false)
            expect(bookmarks.failed).toBe(true)
            expect(workspace.annotations("a")).toMatchObject({
                dirty: true,
                bookmarks: [{ name: "Kept" }],
            })
            expect(await bookmarks.deleteBookmark("unknown")).toBe(false)
            expect(await bookmarks.addBookmark("missing", 1, "Missing")).toBeNull()
        } finally {
            bookmarks.dispose()
            await workspace.dispose()
        }
    })

    it("removes deleted documents only from presentation and does not republish after adapter disposal", async () => {
        const { workspace, bookmarks } = reader()
        try {
            await bookmarks.addBookmark("a", 1, "Retained")
            bookmarks.removeByBookIds(["a"])
            expect(bookmarks.bookmarks).toEqual([])
            expect(workspace.annotations("a").bookmarks).toHaveLength(1)
            bookmarks.dispose()
            await bookmarks.addBookmark("b", 1, "Blocked")
            expect(workspace.annotations("b").bookmarks).toHaveLength(0)
            expect(bookmarks.bookmarks).toEqual([])
        } finally {
            bookmarks.dispose()
            await workspace.dispose()
        }
    })
})
