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
        getUserNotes: getByBookId,
        db: { userNotes: { put, delete: deleteRecord, get, getByBookId } },
    },
    viewerLibraryMutationCapability: {
        serializeBookMutation,
        serializeMetadataMutation,
        putUserNote: put,
        deleteUserNote: deleteRecord,
    },
    isViewerLibraryCapabilityInstalled: () => true,
    getViewerLibraryCapability: () => undefined,
    getViewerLibraryMutationCapability: () => undefined,
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
        notesStore.openEditor(notesStore.notes[0])
    })

    afterEach(() => vi.useRealTimers())

    it("keeps existing-note editors independent and closes only the requested one", async () => {
        const secondNote = { ...note, id: "note-2", noteContent: "Second" }
        notesStore.notes.push(secondNote)
        const firstId = notesStore.editors[0].id
        const secondId = notesStore.openEditor(secondNote)

        notesStore.updateEditor(firstId, { noteContent: "First changed", color: "blue" })
        notesStore.updateEditor(secondId, { noteContent: "Second changed", color: "pink" })
        await notesStore.closeEditor(firstId)

        expect(notesStore.editors.map(({ id }) => id)).toEqual([secondId])
        expect(notesStore.editingNote).toMatchObject({
            id: "note-2",
            noteContent: "Second changed",
        })
        expect(put).toHaveBeenCalledWith(
            expect.objectContaining({ id: note.id, noteContent: "First changed" }),
        )
        await vi.advanceTimersByTimeAsync(300)
        expect(put).toHaveBeenCalledWith(
            expect.objectContaining({ id: "note-2", noteContent: "Second changed" }),
        )
    })

    it("reopens an existing editor without replacing its draft", () => {
        const id = notesStore.editors[0].id
        notesStore.updateEditor(id, { noteContent: "Kept", color: "green" })
        expect(notesStore.openEditor({ ...note })).toBe(id)
        expect(notesStore.editors).toHaveLength(1)
        expect(notesStore.editingNote).toMatchObject({ noteContent: "Kept", color: "green" })
    })

    it("retains other new-note drafts when cancelling one", async () => {
        const { id: _id, createdAt: _createdAt, ...firstDraft } = { ...note, isNew: true as const }
        const firstId = notesStore.openEditor(firstDraft)
        const secondId = notesStore.openEditor({ ...firstDraft, start: 30, end: 40 })
        notesStore.updateEditor(firstId, { noteContent: "First draft", color: "green" })
        notesStore.updateEditor(secondId, { noteContent: "Second draft", color: "purple" })

        expect(notesStore.openEditor(firstDraft)).toBe(firstId)
        expect(notesStore.editors).toHaveLength(3)
        await notesStore.closeEditor(firstId)

        expect(notesStore.editors.find(({ id }) => id === secondId)?.note).toMatchObject({
            noteContent: "Second draft",
            color: "purple",
        })
        expect(put).not.toHaveBeenCalled()
    })

    it("saves only the captured draft even when another editor becomes active", async () => {
        const { id: _id, createdAt: _createdAt, ...fields } = note
        const firstId = notesStore.openEditor({ ...fields, isNew: true })
        let resolvePut!: () => void
        put.mockImplementationOnce(
            () =>
                new Promise<undefined>((resolve) => {
                    resolvePut = () => resolve(undefined)
                }),
        )
        const savePromise = notesStore.saveEditor(firstId)
        const secondId = notesStore.openEditor({ ...fields, isNew: true, start: 30, end: 40 })
        await notesStore.saveEditor(firstId)
        await notesStore.closeEditor(firstId)
        expect(put).toHaveBeenCalledTimes(1)
        resolvePut()
        await savePromise

        const editorIds = notesStore.editors.map(({ id }) => id)
        expect(editorIds).toContain(secondId)
        expect(editorIds).not.toContain(firstId)
        expect(notesStore.activeEditorId).toBe(secondId)
        expect(notesStore.notes).toHaveLength(2)
    })

    it("retains a new draft if persistence fails", async () => {
        const { id: _id, createdAt: _createdAt, ...fields } = note
        const id = notesStore.openEditor({ ...fields, isNew: true })
        put.mockRejectedValueOnce(new Error("write failed"))
        await notesStore.saveEditor(id)
        expect(notesStore.editors.find((editor) => editor.id === id)?.saving).toBe(false)
        expect(notesStore.notes).toEqual([note])
    })

    it("deletes only the matching editor", async () => {
        const secondNote = { ...note, id: "note-2" }
        notesStore.notes.push(secondNote)
        const secondId = notesStore.openEditor(secondNote)
        await notesStore.deleteNote(note.id)
        expect(notesStore.editors.map(({ id }) => id)).toEqual([secondId])
    })

    it("clears every editor when leaving the book view", () => {
        notesStore.openEditor({ ...note, id: "note-2" })
        notesStore.clear()
        expect(notesStore.editors).toEqual([])
        expect(notesStore.activeEditorId).toBeNull()
    })

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
        notesStore.openEditor({
            isNew: true,
            bookId: "book-1",
            pageNumber: 1,
            start: 0,
            end: 5,
            text: "Draft",
            noteContent: "Unsaved",
            color: "green",
        })

        await notesStore.closeEditor()

        expect(notesStore.editors).toHaveLength(1)
        expect(notesStore.editingNote).toEqual(note)
        expect(put).not.toHaveBeenCalled()
    })

    it("clears stale notes before awaiting a new book without deleting unowned highlights", async () => {
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
        expect([...highlights.keys()]).toEqual(["user-note-yellow"])
        resolveLoad([])
        await loading
    })

    it("logs a sanitized diagnostic when loading fails", async () => {
        const error = new Error("secret note content")
        getByBookId.mockRejectedValueOnce(error)
        const log = vi.spyOn(console, "error").mockImplementation(() => undefined)

        await notesStore.loadNotesForBook("book-1")

        expect(log).toHaveBeenCalledWith("[NotesStore] Failed to load notes:", {
            code: "ViewerStorageError",
            message: "Unable to load notes",
        })
        expect(JSON.stringify(log.mock.calls[0])).not.toContain(error.message)
        log.mockRestore()
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
        // Entries not published by this store may belong to another live reader.
        expect(highlights.size).toBe(6)

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
