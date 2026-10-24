// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest"
vi.hoisted(() => {
    window.matchMedia = (() => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
    })) as unknown as typeof window.matchMedia
})
vi.mock("$app/navigation", () => ({ goto: vi.fn(), pushState: vi.fn(), replaceState: vi.fn() }))
import { Blob as NodeBlob, File as NodeFile } from "node:buffer"
import { URL as NodeURL } from "node:url"
afterEach(() => vi.unstubAllGlobals())
import { createExtensionStorage, MemoryStorageBackend } from "$lib/core/storage"
import { libraryStore } from "$lib/extensions/builtin/library/state/libraryStore.svelte"
import { createBuiltinHost } from "$lib/extensions/builtin"
import { viewerStore } from "$lib/extensions/builtin/viewer/stores/viewerStore.svelte"
import { notesStore } from "$lib/extensions/builtin/viewer/stores/notesStore.svelte"
import { bookmarksStore } from "$lib/extensions/builtin/viewer/stores/bookmarksStore.svelte"

async function start(backend = new MemoryStorageBackend()) {
    vi.stubGlobal("Blob", NodeBlob)
    vi.stubGlobal("File", NodeFile)
    vi.stubGlobal("URL", NodeURL)
    const library = createExtensionStorage(backend, "builtin.library").namespace("library")
    for (const id of ["a", "b"]) {
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
        if (!(await library.get(`fileContents.${id}`)))
            await library.set(`fileContents.${id}`, { id, file: new Blob(["original"]) })
    }
    const host = createBuiltinHost({ storage: backend })
    host.documentService.adapters.register({
        id: "viewer.review.integration",
        extensions: ["pdf"],
        mimeTypes: [],
        probe: async () => ({ supported: true, confidence: 100 }),
        open: async () => ({
            kind: "reflowable",
            metadata: { title: "Fixture", author: null },
            capabilities: new Set(),
            getSections: async () => [],
            close: async () => undefined,
        }),
    })
    await host.start()
    for (const id of ["b", "a"]) {
        await viewerStore.workspace.open(id)
        await viewerStore.workspace.loadDocument()
    }
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

    it("classifies an inactive relink through owning host contracts and preserves review on reload", async () => {
        const reader = await start()
        try {
            const result = await reader.store.workspace.createDraft("b", {
                pageNumber: 2,
                start: 0,
                end: 7,
                text: "Old passage",
                noteContent: "Unfinished",
                color: "blue",
                association: { contentHash: null, verification: "unverified" },
            })
            expect(result.ok).toBe(true)
            await reader.library.relinkFile("b", new File(["replacement"], "b.pdf"))
            expect(reader.store.workspace.snapshot.documentId).toBe("a")
            expect(reader.store.workspace.needsReview("b")).toMatchObject([
                { kind: "draft", record: { noteContent: "Unfinished" } },
            ])
            await reader.store.workspace.open("b")
            await reader.store.workspace.loadDocument()
            await reader.notes.loadNotesForBook("b")
            expect(reader.notes.drafts).toEqual([])
            expect(reader.store.workspace.anchoredAnnotations("b").drafts).toEqual([])
            await reader.store.workspace.flush()
        } finally {
            await reader.host.dispose()
        }
        // The persisted original byte evidence still differs after source resources are released.
        const restored = await start(reader.backend)
        try {
            await restored.store.workspace.open("b")
            await restored.store.workspace.loadDocument()
            await restored.store.workspace.loadDrafts("b")
            expect(restored.store.workspace.needsReview("b")).toMatchObject([
                { kind: "draft", record: { noteContent: "Unfinished" } },
            ])
            expect(restored.store.workspace.anchoredAnnotations("b").drafts).toEqual([])
        } finally {
            await restored.host.dispose()
        }
    })

    it("failed relink retains recoverable review material and resumes the owning reader", async () => {
        const reader = await start()
        const result = await reader.store.workspace.createNote("a", {
            pageNumber: 2,
            start: 0,
            end: 7,
            text: "Old passage",
            noteContent: "Retained",
            color: "blue",
            association: { contentHash: null, verification: "unverified" },
        })
        expect(result.ok).toBe(true)
        const set = reader.backend.set.bind(reader.backend)
        reader.backend.set = async (key, value) => {
            if (key.endsWith(":fileContents.a")) throw new Error("Unavailable storage")
            await set(key, value)
        }
        try {
            await expect(
                reader.library.relinkFile("a", new File(["replacement"], "a.pdf")),
            ).rejects.toThrow()
            expect(reader.store.workspace.annotations("a").notes).toMatchObject([
                { noteContent: "Retained" },
            ])
            reader.backend.set = set
            await reader.store.workspace.synchronize()
            await reader.store.workspace.loadDocument()
            expect(reader.store.workspace.anchoredAnnotations("a").notes).toHaveLength(1)
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
