import { describe, expect, it } from "vitest"
import { createExtensionStorage, MemoryStorageBackend } from "$lib/core/storage"
import { ReadingWorkspace } from "../readingWorkspace"
import { ReadingStorage } from "../readingStorage"
import type { ViewerFileCapability } from "../viewerHost"
import { NotesStore } from "./notesStore.svelte"

async function reader(backend = new MemoryStorageBackend()) {
    const files = {
        nodes: {
            a: { id: "a", name: "A", type: "file", metadata: {} },
            b: { id: "b", name: "B", type: "file", metadata: {} },
        },
        isLockedMap: {},
        getContentGeneration: () => 0,
        isCurrentContent: () => true,
        isCurrentFileUrl: () => true,
        getFileUrl: async (id: string) => `blob:${id}`,
        releaseFileUrl: () => true,
    } as unknown as ViewerFileCapability
    const workspace = new ReadingWorkspace({
        files,
        storage: new ReadingStorage(createExtensionStorage(backend, "test.viewer")),
        getCurrentBook: () => null,
        publish: () => true,
        loader: {
            open: async () => ({
                kind: "reflowable",
                contentHash: "a".repeat(64),
                metadata: { title: "Fixture", author: null },
                capabilities: new Set(),
                getSections: async () => [],
                close: async () => undefined,
            }),
        },
    })
    for (const id of ["b", "a"]) {
        await workspace.open(id)
        await workspace.loadDocument()
    }
    const notes = new NotesStore(workspace)
    return { backend, workspace, notes }
}
const draft = {
    bookId: "a",
    pageNumber: 2,
    start: 0,
    end: 7,
    text: "Passage",
    noteContent: "Original",
    color: "yellow" as const,
}

describe("NotesStore workspace editor adapter", () => {
    it("keeps editors independent, reuses their identity, and saves only the requested editor", async () => {
        const { notes, workspace } = await reader()
        try {
            await notes.loadNotesForBook("a")
            const first = await notes.openDraft(draft)
            const second = await notes.openDraft({ ...draft, start: 8, end: 15, text: "Another" })
            notes.updateEditor(first!, { noteContent: "First", color: "blue" })
            notes.updateEditor(second!, { noteContent: "Second", color: "pink" })
            expect(notes.openEditor(notes.editors[0].note)).toBe(first)
            await notes.saveEditor(first)
            expect(workspace.annotations("a").notes).toMatchObject([
                { noteContent: "First", color: "blue" },
            ])
            expect(notes.editors.map((editor) => editor.id)).toEqual([second])
            await notes.closeEditor(second)
            expect(workspace.annotations("a").notes).toHaveLength(1)
        } finally {
            notes.dispose()
            await workspace.dispose()
        }
    })

    it("recovers independent drafts across selection, hidden editors and persisted reload without saving notes", async () => {
        const { notes, workspace, backend } = await reader()
        await notes.loadNotesForBook("a")
        const first = await notes.openDraft(draft)
        const second = await notes.openDraft({ ...draft, text: "Other", start: 8, end: 13 })
        notes.updateEditor(first!, { noteContent: "First", color: "blue" })
        notes.updateEditor(second!, { noteContent: "Second", color: "pink" })
        await notes.closeEditor(first)
        expect(workspace.annotations("a").drafts).toHaveLength(2)
        await notes.loadNotesForBook("b")
        await notes.openDraft({ ...draft, bookId: "b", noteContent: "B" })
        expect(notes.editors).toMatchObject([{ note: { bookId: "b", noteContent: "B" } }])
        await notes.loadNotesForBook("a")
        expect(notes.editors.map((e) => e.note)).toMatchObject([
            { text: "Passage", noteContent: "First", color: "blue" },
            { text: "Other", noteContent: "Second", color: "pink" },
        ])
        await workspace.flush()
        notes.dispose()
        await workspace.dispose()
        const restored = await reader(backend)
        await restored.notes.loadNotesForBook("a")
        expect(restored.notes.editors.map((e) => e.note)).toMatchObject([
            { text: "Passage", noteContent: "First", color: "blue" },
            { text: "Other", noteContent: "Second", color: "pink" },
        ])
        expect(restored.notes.notes).toEqual([])
        restored.notes.dispose()
        await restored.workspace.dispose()
    })

    it("retains failed new work and retries the same annotation instead of duplicating it", async () => {
        const { backend, notes, workspace } = await reader()
        const set = backend.set.bind(backend)
        let fail = true
        backend.set = async (key, value) => {
            if (fail && key.includes("reading-v1-annotations-"))
                throw new Error("private text must not escape")
            await set(key, value)
        }
        try {
            await notes.loadNotesForBook("a")
            const id = (await notes.openDraft(draft))!
            await notes.saveEditor(id)
            expect(notes.editors).toMatchObject([
                { id, failed: true, note: { noteContent: "Original" } },
            ])
            expect(workspace.annotations("a").dirty).toBe(true)
            expect(workspace.annotations("a").notes).toHaveLength(0)
            fail = false
            await notes.saveEditor(id)
            expect(notes.editors).toHaveLength(0)
            expect(workspace.annotations("a").notes).toHaveLength(1)
            expect(workspace.annotations("a").dirty).toBe(false)
        } finally {
            notes.dispose()
            await workspace.dispose()
        }
    })

    it("keeps an existing editor and its latest input open when closing cannot persist", async () => {
        const { backend, notes, workspace } = await reader()
        try {
            await notes.loadNotesForBook("a")
            const saved = await notes.addNote("a", 2, 0, 7, "Passage", "Original", "yellow")
            const id = notes.openEditor(saved!)
            const set = backend.set.bind(backend)
            backend.set = async (key, value) => {
                if (key.includes("reading-v1-annotations-")) throw new Error("unavailable")
                await set(key, value)
            }
            notes.updateEditor(id, { noteContent: "Kept", color: "purple" })
            await notes.closeEditor(id)
            expect(notes.editors).toMatchObject([
                { id, failed: true, note: { noteContent: "Kept", color: "purple" } },
            ])
            expect(workspace.annotations("a").notes).toMatchObject([{ noteContent: "Kept" }])
        } finally {
            notes.dispose()
            await workspace.dispose()
        }
    })

    it("never publishes a completed old-document editor action into the new document", async () => {
        const { backend, notes, workspace } = await reader()
        const set = backend.set.bind(backend)
        let release!: () => void
        const blocked = new Promise<void>((resolve) => (release = resolve))
        backend.set = async (key, value) => {
            if (key.includes("reading-v1-annotations-")) await blocked
            await set(key, value)
        }
        try {
            await notes.loadNotesForBook("a")
            backend.set = set
            const id = (await notes.openDraft(draft))!
            backend.set = async (key, value) => {
                if (key.includes("reading-v1-annotations-")) await blocked
                await set(key, value)
            }
            const saving = notes.saveEditor(id)
            await notes.loadNotesForBook("b")
            const nextOpening = notes.openDraft({ ...draft, bookId: "b" })
            release()
            const next = await nextOpening
            await saving
            expect(workspace.annotations("a").notes).toHaveLength(1)
            expect(workspace.annotations("b").notes).toHaveLength(0)
            expect(notes.notes).toEqual([])
            expect(notes.editors.map((editor) => editor.id)).toEqual([next])
        } finally {
            release()
            notes.dispose()
            await workspace.dispose()
        }
    })

    it("deletes only the matching note and clears only presentation when leaving a document", async () => {
        const { notes, workspace } = await reader()
        try {
            await notes.loadNotesForBook("a")
            const first = await notes.addNote("a", 1, 0, 1, "A", "First", "yellow")
            const second = await notes.addNote("a", 1, 1, 2, "B", "Second", "blue")
            notes.openEditor(first!)
            const remaining = notes.openEditor(second!)
            expect(await notes.deleteNote(first!.id)).toBe(true)
            expect(notes.editors.map((editor) => editor.id)).toEqual([remaining])
            notes.clear()
            await notes.loadNotesForBook("a")
            expect(notes.notes).toMatchObject([{ noteContent: "Second" }])
        } finally {
            notes.dispose()
            await workspace.dispose()
        }
    })
})
