// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest"
vi.hoisted(() => {
    window.matchMedia = (() => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
    })) as unknown as typeof window.matchMedia
})
vi.mock("$app/navigation", () => ({ goto: vi.fn(), pushState: vi.fn(), replaceState: vi.fn() }))
import { createExtensionStorage, MemoryStorageBackend } from "$lib/core/storage"
import { libraryStore } from "$lib/extensions/builtin/library/state/libraryStore.svelte"
import { createBuiltinHost } from "$lib/extensions/builtin"
import { viewerStore } from "$lib/extensions/builtin/viewer/stores/viewerStore.svelte"
import { notesStore } from "$lib/extensions/builtin/viewer/stores/notesStore.svelte"
import { bookmarksStore } from "$lib/extensions/builtin/viewer/stores/bookmarksStore.svelte"

async function start(backend = new MemoryStorageBackend()) {
    const library = createExtensionStorage(backend, "builtin.library").namespace("library")
    for (const id of ["a", "b"])
        await library.set(`books.${id}`, {
            id,
            name: `${id}.pdf`,
            type: "file",
            parentId: null,
            createdAt: 1,
            updatedAt: 1,
            isPinned: false,
            size: 4,
            metadata: {},
        })
    const host = createBuiltinHost({ storage: backend })
    await host.start()
    return {
        host,
        backend,
        library: libraryStore,
        store: viewerStore,
        notes: notesStore,
        bookmarks: bookmarksStore,
    }
}

describe("Reading annotation host integration", () => {
    it("saves an editor to its initiating document and reopens Viewer-owned annotations", async () => {
        const first = await start()
        try {
            await first.notes.loadNotesForBook("a")
            const editor = await first.notes.openDraft({
                bookId: "a",
                pageNumber: 2,
                start: 0,
                end: 7,
                text: "Passage",
                noteContent: "Remember",
                color: "blue",
            })
            await first.notes.saveEditor(editor)
            expect(first.notes.editors).toHaveLength(0)
            expect(first.store.workspace.annotations("a").notes).toMatchObject([
                { bookId: "a", text: "Passage", noteContent: "Remember", color: "blue" },
            ])
            expect(await first.store.workspace.getReadingSummary("b")).toEqual({
                documentId: "b",
                noteCount: 0,
                bookmarkCount: 0,
            })
        } finally {
            await first.host.dispose()
        }
        const reopened = await start(first.backend)
        try {
            await reopened.notes.loadNotesForBook("a")
            expect(reopened.notes.notes).toMatchObject([{ bookId: "a", noteContent: "Remember" }])
        } finally {
            await reopened.host.dispose()
        }
    })
    it("exposes minimal Library summaries for new bookmark actions without legacy forwarding", async () => {
        const reader = await start()
        try {
            const bookmark = await reader.bookmarks.addBookmark("b", 4, "Chapter")
            expect(bookmark).not.toBeNull()
            expect(await reader.library.getReadingSummary("b")).toEqual({
                documentId: "b",
                noteCount: 0,
                bookmarkCount: 1,
            })
            expect(await reader.bookmarks.updateBookmark(bookmark!.id, "Renamed")).toBe(true)
            expect(reader.store.workspace.annotations("b").bookmarks).toMatchObject([
                { name: "Renamed", bookId: "b" },
            ])
            expect(await reader.bookmarks.deleteBookmark(bookmark!.id)).toBe(true)
            expect(await reader.library.getReadingSummary("b")).toEqual({
                documentId: "b",
                noteCount: 0,
                bookmarkCount: 0,
            })
        } finally {
            await reader.host.dispose()
        }
    })

    it("blocks annotations during deletion and explicitly resumes after confirmed rollback", async () => {
        const reader = await start()
        const library = libraryStore
        const remove = reader.backend.delete.bind(reader.backend)
        let release!: () => void
        const blocked = new Promise<void>((resolve) => (release = resolve))
        reader.backend.delete = async (key) => {
            if (key.endsWith(":books.a")) {
                await blocked
                throw new Error("storage unavailable")
            }
            return remove(key)
        }
        const input = {
            pageNumber: 1,
            name: "Retained",
            association: { contentHash: null, verification: "unverified" as const },
        }
        try {
            await reader.store.workspace.loadAnnotations("a")
            const deleting = library.deleteNode("a").then(
                () => false,
                () => true,
            )
            expect((await reader.store.workspace.createBookmark("a", input)).ok).toBe(false)
            release()
            expect(await deleting).toBe(true)
            expect((await reader.store.workspace.createBookmark("a", input)).ok).toBe(true)
        } finally {
            release()
            await reader.host.dispose()
        }
    })

    it("keeps Library summary consumers bound to the owning host", async () => {
        const first = await start()
        const second = await start()
        try {
            await first.bookmarks.addBookmark("a", 2, "First owner")
            expect(await first.library.getReadingSummary("a")).toEqual({
                documentId: "a",
                noteCount: 0,
                bookmarkCount: 1,
            })
            expect(await second.library.getReadingSummary("a")).toEqual({
                documentId: "a",
                noteCount: 0,
                bookmarkCount: 0,
            })
            await first.host.dispose()
            expect(await first.library.getReadingSummary("a")).toBeNull()
            await second.bookmarks.addBookmark("b", 3, "Second owner")
            expect(await second.library.getReadingSummary("b")).toEqual({
                documentId: "b",
                noteCount: 0,
                bookmarkCount: 1,
            })
        } finally {
            await first.host.dispose()
            await second.host.dispose()
        }
    })

    it("neither reads nor purges unsupported Library annotations during reading or document deletion", async () => {
        const reader = await start()
        const legacy = createExtensionStorage(reader.backend, "builtin.library").namespace(
            "library",
        )
        const records = [
            ["userNotes.old", { id: "old", bookId: "a", noteContent: "unsupported" }],
            ["bookmarks.orphan", { id: "orphan", bookId: "missing", name: "unsupported" }],
            ["bookmarks.old", { id: "old", bookId: "a", name: "unsupported" }],
        ] as const
        for (const [key, value] of records) await legacy.set(key, value)
        const get = reader.backend.get.bind(reader.backend)
        const keys = reader.backend.keys.bind(reader.backend)
        const remove = reader.backend.delete.bind(reader.backend)
        const unsupported = (key: string) => /:(userNotes|bookmarks)\./.test(key)
        reader.backend.get = async (key) => {
            if (unsupported(key)) throw new Error("Unsupported read")
            return get(key)
        }
        reader.backend.keys = async (prefix) => {
            if (prefix && unsupported(prefix)) throw new Error("Unsupported scan")
            return keys(prefix)
        }
        reader.backend.delete = async (key) => {
            if (unsupported(key)) throw new Error("Unsupported purge")
            return remove(key)
        }
        try {
            await reader.notes.loadNotesForBook("a")
            await reader.bookmarks.loadAllBookmarks()
            expect(reader.notes.notes).toEqual([])
            expect(reader.bookmarks.bookmarks).toEqual([])
            await reader.bookmarks.addBookmark("a", 2, "New authoritative bookmark")
            await reader.library.deleteNode("a")
            expect(reader.library.nodes.a).toBeUndefined()
            expect(reader.library.nodes.b?.name).toBe("b.pdf")
            expect(reader.bookmarks.bookmarks).toEqual([])
            reader.backend.get = get
            for (const [key, value] of records) expect(await legacy.get(key)).toEqual(value)
        } finally {
            await reader.host.dispose()
        }
    })
})
