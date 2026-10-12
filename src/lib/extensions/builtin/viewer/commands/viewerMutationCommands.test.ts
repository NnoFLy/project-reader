import { describe, expect, it, vi } from "vitest"
import { createViewerMutationCommands } from "./viewerMutationCommands"

describe("viewer mutation commands", () => {
    it("forwards bookmark mutations through typed payloads", async () => {
        const addBookmark = vi.fn()
        const editBookmark = vi.fn()
        const deleteBookmark = vi.fn()
        const commands = createViewerMutationCommands({
            addBookmark,
            editBookmark,
            deleteBookmark,
            addNote: vi.fn(),
            editNote: vi.fn(),
            saveNote: vi.fn(),
            deleteNote: vi.fn(),
        })

        await commands["viewer.bookmark.add"]?.run({ page: 4, name: "Chapter" })
        await commands["viewer.bookmark.edit"]?.run({
            bookmarkId: "bookmark-1",
            name: "Renamed",
        })
        await commands["viewer.bookmark.delete"]?.run({
            bookmarkId: "bookmark-1",
            confirmed: true,
        })

        expect(addBookmark).toHaveBeenCalledWith({ page: 4, name: "Chapter" })
        expect(editBookmark).toHaveBeenCalledWith({
            bookmarkId: "bookmark-1",
            name: "Renamed",
        })
        expect(deleteBookmark).toHaveBeenCalledWith({
            bookmarkId: "bookmark-1",
            confirmed: true,
        })
    })

    it("forwards note edit, save, and delete through one command surface", async () => {
        const editNote = vi.fn()
        const saveNote = vi.fn()
        const deleteNote = vi.fn()
        const commands = createViewerMutationCommands({
            addBookmark: vi.fn(),
            editBookmark: vi.fn(),
            deleteBookmark: vi.fn(),
            addNote: vi.fn(),
            editNote,
            saveNote,
            deleteNote,
        })

        await commands["viewer.note.edit"]?.run({ noteId: "note-1", x: 20, y: 30 })
        await commands["viewer.note.save"]?.run(undefined)
        await commands["viewer.note.delete"]?.run({ noteId: "note-1", confirmed: true })

        expect(editNote).toHaveBeenCalledWith({ noteId: "note-1", x: 20, y: 30 })
        expect(saveNote).toHaveBeenCalledWith(undefined)
        expect(deleteNote).toHaveBeenCalledWith({ noteId: "note-1", confirmed: true })
    })
})
