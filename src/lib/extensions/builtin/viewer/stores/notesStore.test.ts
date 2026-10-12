import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("$app/environment", () => ({ browser: true }))

const {
    put,
    deleteRecord,
    get,
    serializeBookMutation,
    serializeMetadataMutation,
    getByBookId,
    nodes,
    notifyDeleting,
    notifyDeleted,
    onNodesDeleting,
    onNodesDeleted,
    disposed,
} = vi.hoisted(() => {
    const nodes: Record<string, { type: "file" }> = { "book-1": { type: "file" } }
    const disposed = { value: false }
    let deletingListener: ((ids: string[]) => void) | undefined
    let deletedListener: ((ids: string[]) => void) | undefined
    return {
        put: vi.fn(async () => undefined),
        deleteRecord: vi.fn(async () => undefined),
        get: vi.fn(async () => undefined),
        getByBookId: vi.fn(async () => [] as any[]),
        serializeBookMutation: vi.fn(async (_bookId: string, mutation: () => Promise<unknown>) =>
            mutation(),
        ),
        serializeMetadataMutation: vi.fn(async (mutation: () => Promise<unknown>) => mutation()),
        nodes,
        disposed,
        notifyDeleting: (ids: string[]) => deletingListener?.(ids),
        notifyDeleted: (ids: string[]) => deletedListener?.(ids),
        onNodesDeleting: vi.fn((listener: (ids: string[]) => void) => {
            deletingListener = listener
        }),
        onNodesDeleted: vi.fn((listener: (ids: string[]) => void) => {
            deletedListener = listener
        }),
    }
})

vi.mock("../viewerHost", () => ({
    viewerLibraryCapability: {
        nodes,
        get allFiles() {
            return Object.entries(nodes).map(([id]) => ({ id, type: "file" as const }))
        },
        onNodesDeleting,
        onNodesDeleted,
        get isDisposed() {
            return disposed.value
        },
        isNodeDeleting: vi.fn(() => false),
        serializeBookMutation,
        serializeMetadataMutation,
        db: { userNotes: { put, delete: deleteRecord, get, getByBookId } },
    },
    isViewerLibraryCapabilityInstalled: () => true,
    getViewerLibraryCapability: () => undefined,
}))

import { notesStore } from "./notesStore.svelte"

const note = {
    id: "note-1",
    bookId: "book-1",
    pageNumber: 2,
    start: 10,
    end: 20,
    text: "Selected text",
    noteContent: "Original",
    color: "yellow" as const,
    createdAt: 1,
}

describe("notesStore live editing", () => {
    beforeEach(() => {
        vi.useFakeTimers()
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
        getByBookId.mockReset()
        getByBookId.mockResolvedValue([])
        disposed.value = false
        nodes["book-1"] = { type: "file" }
        notesStore.clear()
        notesStore.notes = [{ ...note }]
        notesStore.editingNote = notesStore.notes[0]
    })

    afterEach(() => vi.useRealTimers())

    it("updates visible content and color immediately but debounces persistence", async () => {
        notesStore.updateNoteDraft(note.id, "Changed", "blue")

        expect(notesStore.notes[0]).toMatchObject({ noteContent: "Changed", color: "blue" })
        expect(notesStore.editingNote).toMatchObject({ noteContent: "Changed", color: "blue" })
        expect(put).not.toHaveBeenCalled()

        await vi.advanceTimersByTimeAsync(300)
        expect(put).toHaveBeenCalledWith(
            expect.objectContaining({ id: note.id, noteContent: "Changed", color: "blue" }),
        )
    })

    it("flushes an existing note when the editor closes", async () => {
        notesStore.updateNoteDraft(note.id, "Final", "pink")
        await notesStore.closeEditor()

        expect(notesStore.editingNote).toBeNull()
        expect(put).toHaveBeenCalledOnce()
        expect(put).toHaveBeenCalledWith(
            expect.objectContaining({ noteContent: "Final", color: "pink" }),
        )
    })

    it("keeps an unrelated note load alive when another book is deleted", async () => {
        let resolveLoad!: (value: (typeof note)[]) => void
        getByBookId.mockImplementationOnce(
            () =>
                new Promise<(typeof note)[]>((resolve) => {
                    resolveLoad = resolve
                }),
        )
        const loading = notesStore.loadNotesForBook("book-1")
        await Promise.resolve()
        notifyDeleted(["book-2"])
        resolveLoad([{ ...note }])

        await loading

        expect(notesStore.notes).toEqual([{ ...note }])
    })

    it("does not restore notes after deletion starts during a load", async () => {
        let resolveLoad!: (records: (typeof note)[]) => void
        getByBookId.mockImplementationOnce(
            () =>
                new Promise<(typeof note)[]>((resolve) => {
                    resolveLoad = resolve
                }),
        )
        notesStore.notes = []
        const loading = notesStore.loadNotesForBook("book-1")
        await Promise.resolve()
        delete nodes["book-1"]
        notifyDeleting(["book-1"])
        resolveLoad([{ ...note }])

        await loading

        expect(notesStore.notes).toEqual([])
    })

    it("does not let a delayed load hide a completed add", async () => {
        let resolveLoad!: (value: (typeof note)[]) => void
        getByBookId.mockImplementationOnce(
            () =>
                new Promise<(typeof note)[]>((resolve) => {
                    resolveLoad = resolve
                }),
        )
        notesStore.notes = []
        const loading = notesStore.loadNotesForBook("book-1")
        await Promise.resolve()
        const adding = notesStore.addNote("book-1", 1, 0, 5, "Selected", "Added", "yellow")
        resolveLoad([])

        await Promise.all([loading, adding])

        expect(notesStore.notes).toHaveLength(1)
        expect(notesStore.notes[0]).toMatchObject({ noteContent: "Added" })
    })

    it("does not let a delayed load hide a completed update", async () => {
        let resolveLoad!: (value: (typeof note)[]) => void
        getByBookId.mockImplementationOnce(
            () =>
                new Promise<(typeof note)[]>((resolve) => {
                    resolveLoad = resolve
                }),
        )
        const loading = notesStore.loadNotesForBook("book-1")
        await Promise.resolve()
        const updating = notesStore.updateNote(note.id, "Changed", "blue")
        resolveLoad([])

        await Promise.all([loading, updating])

        expect(notesStore.notes[0]).toMatchObject({ noteContent: "Changed", color: "blue" })
    })

    it("rejects a note when its book is already deleted", async () => {
        delete nodes["book-1"]

        await expect(
            notesStore.addNote("book-1", 1, 0, 5, "Selected", "Content", "yellow"),
        ).resolves.toBeNull()
        expect(put).not.toHaveBeenCalled()
    })

    it("clears a successful deletion tombstone in finally", async () => {
        await notesStore.deleteNote(note.id)
        notesStore.notes = [{ ...note }]

        await notesStore.updateNote(note.id, "Retried", "blue")

        expect(put).toHaveBeenCalledWith(
            expect.objectContaining({ id: note.id, noteContent: "Retried", color: "blue" }),
        )
    })

    it("clears a failed deletion tombstone so the note can be updated", async () => {
        deleteRecord.mockRejectedValueOnce(new Error("delete failed"))

        await notesStore.deleteNote(note.id)
        await notesStore.updateNote(note.id, "Retried", "blue")

        expect(put).toHaveBeenCalledWith(
            expect.objectContaining({ id: note.id, noteContent: "Retried", color: "blue" }),
        )
    })

    it("removes a note written after deletion starts", async () => {
        let resolvePut!: () => void
        put.mockImplementationOnce(
            () =>
                new Promise<undefined>((resolve) => {
                    resolvePut = () => resolve(undefined)
                }),
        )
        const adding = notesStore.addNote("book-1", 1, 0, 5, "Selected", "Content", "yellow")
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
        notesStore.notes = []
        get.mockResolvedValueOnce({ ...note, bookId: "missing-book" } as any)

        await notesStore.deleteNote(note.id)

        expect(serializeMetadataMutation).toHaveBeenCalledWith(expect.any(Function))
        expect(deleteRecord).toHaveBeenCalledWith(note.id)
    })

    it("serializes an unknown deletion behind an earlier note write", async () => {
        notesStore.notes = []
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

        const adding = notesStore.addNote("book-1", 1, 0, 5, "Selected", "Added", "yellow")
        await Promise.resolve()
        expect(addedId).toBeDefined()
        const deleting = notesStore.deleteNote(addedId)
        resolvePut()

        await Promise.all([adding, deleting])

        expect(serializeBookMutation).toHaveBeenCalledTimes(1)
        expect(serializeMetadataMutation).toHaveBeenCalledTimes(1)
        expect(deleteRecord).toHaveBeenCalledWith(addedId)
        expect(notesStore.notes).toEqual([])
    })

    it("discards a new-note draft without persisting it", async () => {
        notesStore.editingNote = {
            isNew: true,
            bookId: "book-1",
            pageNumber: 1,
            start: 0,
            end: 5,
            text: "Draft",
            noteContent: "Unsaved",
            color: "green",
        }

        await notesStore.closeEditor()

        expect(notesStore.editingNote).toBeNull()
        expect(put).not.toHaveBeenCalled()
    })

    it("clears stale visual state before awaiting a new book's notes", async () => {
        const highlights = new Map<string, unknown>([["user-note-yellow", {}]])
        Object.defineProperty(globalThis, "CSS", {
            configurable: true,
            value: { highlights },
        })
        notesStore.notes = [{ ...note }]
        let resolveLoad!: (records: (typeof note)[]) => void
        getByBookId.mockImplementationOnce(
            () =>
                new Promise<(typeof note)[]>((resolve) => {
                    resolveLoad = resolve
                }),
        )

        const loading = notesStore.loadNotesForBook("book-2")

        expect(notesStore.notes).toEqual([])
        expect(highlights.size).toBe(0)
        resolveLoad([])
        await loading
    })

    it("does not publish a pending load after disposal", async () => {
        let resolveLoad!: (records: (typeof note)[]) => void
        getByBookId.mockImplementationOnce(
            () =>
                new Promise<(typeof note)[]>((resolve) => {
                    resolveLoad = resolve
                }),
        )
        notesStore.notes = []
        const loading = notesStore.loadNotesForBook("book-1")
        await Promise.resolve()

        disposed.value = true
        resolveLoad([{ ...note }])
        await loading
        disposed.value = false

        expect(notesStore.notes).toEqual([])
    })

    it("does not publish a note write that finishes after disposal", async () => {
        let resolvePut!: () => void
        put.mockImplementationOnce(
            () =>
                new Promise<undefined>((resolve) => {
                    resolvePut = () => resolve(undefined)
                }),
        )
        notesStore.notes = [{ ...note }]
        const updating = notesStore.updateNote(note.id, "Persisted", "blue")
        await Promise.resolve()

        disposed.value = true
        notesStore.dispose()
        resolvePut()
        await updating

        const highlights = new Map<string, unknown>([
            ["user-note-yellow", {}],
            ["user-note-green", {}],
            ["user-note-blue", {}],
            ["user-note-pink", {}],
            ["user-note-purple", {}],
            ["user-note-active", {}],
        ])
        Object.defineProperty(globalThis, "CSS", {
            configurable: true,
            value: { highlights },
        })
        notesStore.activeSelection = {
            bookId: "book-1",
            pageNumber: 1,
            start: 0,
            end: 1,
            text: "selected",
            x: 1,
            y: 1,
            bottomY: 1,
        }
        notesStore.scrollingToNoteId = note.id
        notesStore.dispose()

        expect(notesStore.notes).toEqual([])
        expect(notesStore.activeSelection).toBeNull()
        expect(notesStore.scrollingToNoteId).toBeNull()
        expect(highlights.size).toBe(0)

        put.mockClear()
        deleteRecord.mockClear()
        await expect(
            notesStore.addNote("book-1", 1, 0, 5, "Selected", "After disposal", "yellow"),
        ).resolves.toBeNull()
        await notesStore.updateNote(note.id, "After disposal", "blue")
        await notesStore.deleteNote(note.id)
        expect(put).not.toHaveBeenCalled()
        expect(deleteRecord).not.toHaveBeenCalled()

        getByBookId.mockClear()
        await notesStore.loadNotesForBook("book-1")
        expect(getByBookId).not.toHaveBeenCalled()
    })
})
