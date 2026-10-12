import { SvelteMap } from "svelte/reactivity"
import { browser } from "$app/environment"
import { untrack } from "svelte"
import {
    isViewerLibraryCapabilityInstalled,
    getViewerLibraryCapability,
    viewerLibraryCapability as vfsStore,
    type UserNote,
} from "../viewerHost"

export interface SelectionState {
    bookId: string
    pageNumber: number
    start: number
    end: number
    text: string
    x: number
    y: number
    bottomY: number
}

export interface PopupState {
    note: UserNote
    x: number
    y: number
}

class NotesStore {
    private files = getViewerLibraryCapability() ?? vfsStore
    notes = $state<UserNote[]>([])
    activePopup = $state<PopupState | null>(null)
    activeSelection = $state<SelectionState | null>(null)
    editingNote = $state<
        | UserNote
        | {
              isNew: true
              bookId: string
              pageNumber: number
              start: number
              end: number
              text: string
              color: "yellow" | "green" | "blue" | "pink" | "purple"
              noteContent: string
          }
        | null
    >(null)
    editorCoords = $state<{ x: number; y: number } | null>(null)
    scrollingToNoteId = $state<string | null>(null)

    private pageRanges = new SvelteMap<number, { noteId: string; range: Range; color: string }[]>()
    private highlightUpdatePending = false
    private pendingNoteWrites = new Map<string, ReturnType<typeof setTimeout>>()
    private bookWriteGenerations = new Map<string, number>()
    private noteWriteGenerations = new Map<string, number>()
    private pendingDeletionBookIds = new Set<string>()
    private pendingDeletionNoteIds = new Set<string>()
    private loadGeneration = 0
    private lifecycleEpoch = 0
    private disposed = false
    private bookLoadGenerations = new Map<string, number>()
    private readonly vfsUnsubscribers: (() => void)[] = []

    constructor() {
        this.attachLibraryListeners()
    }

    private attachLibraryListeners() {
        if (!isViewerLibraryCapabilityInstalled()) return
        this.vfsUnsubscribers.push(
            this.files.onNodesDeleting?.((bookIds) => {
                for (const bookId of bookIds) {
                    this.pendingDeletionBookIds.add(bookId)
                    this.invalidateBookWrites(bookId)
                    this.invalidateBookLoad(bookId)
                }
            }) ?? (() => undefined),
        )
        this.vfsUnsubscribers.push(
            this.files.onNodesDeleted?.((bookIds) => {
                for (const bookId of bookIds) this.removeByBookId(bookId)
            }) ?? (() => undefined),
        )
    }

    reset() {
        this.dispose()
        this.files = getViewerLibraryCapability() ?? vfsStore
        this.disposed = false
        this.pendingDeletionBookIds.clear()
        this.pendingDeletionNoteIds.clear()
        this.attachLibraryListeners()
    }

    dispose() {
        this.disposed = true
        this.lifecycleEpoch++
        this.loadGeneration++
        for (const unsubscribe of this.vfsUnsubscribers.splice(0)) unsubscribe()
        for (const timeout of this.pendingNoteWrites.values()) clearTimeout(timeout)
        this.pendingNoteWrites.clear()
        if (this.highlightUpdateFrame !== null && typeof cancelAnimationFrame !== "undefined") {
            cancelAnimationFrame(this.highlightUpdateFrame)
            this.highlightUpdateFrame = null
        }
        this.notes = []
        this.activePopup = null
        this.activeSelection = null
        this.editingNote = null
        this.editorCoords = null
        this.scrollingToNoteId = null
        this.pageRanges.clear()
        this.clearCSSHighlights()
    }

    private invalidateBookWrites(bookId: string) {
        this.bookWriteGenerations.set(bookId, (this.bookWriteGenerations.get(bookId) ?? 0) + 1)
    }

    private invalidateBookLoad(bookId: string) {
        this.bookLoadGenerations.set(bookId, (this.bookLoadGenerations.get(bookId) ?? 0) + 1)
    }

    private removeByBookId(bookId: string) {
        this.bookLoadGenerations.set(bookId, (this.bookLoadGenerations.get(bookId) ?? 0) + 1)
        const deletedNoteIds = new Set(
            this.notes.filter((note) => note.bookId === bookId).map((note) => note.id),
        )
        for (const [noteId, pending] of this.pendingNoteWrites) {
            if (deletedNoteIds.has(noteId)) {
                clearTimeout(pending)
                this.pendingNoteWrites.delete(noteId)
            }
        }
        this.notes = this.notes.filter((note) => note.bookId !== bookId)
        if (this.activePopup?.note.bookId === bookId) this.activePopup = null
        if (this.activeSelection?.bookId === bookId) this.activeSelection = null
        if (this.editingNote?.bookId === bookId) {
            this.editingNote = null
            this.editorCoords = null
        }
        if (this.scrollingToNoteId && deletedNoteIds.has(this.scrollingToNoteId)) {
            this.scrollingToNoteId = null
        }
        for (const [pageNumber, ranges] of this.pageRanges) {
            const remaining = ranges.filter((range) => !deletedNoteIds.has(range.noteId))
            if (remaining.length > 0) this.pageRanges.set(pageNumber, remaining)
            else this.pageRanges.delete(pageNumber)
        }
        this.updateCSSHighlights()
    }

    private clearStaleVisualState(bookId: string) {
        if (this.notes.some((note) => note.bookId !== bookId)) this.notes = []
        this.activePopup = null
        this.activeSelection = null
        this.editingNote = null
        this.editorCoords = null
        this.scrollingToNoteId = null
        this.pageRanges.clear()
        this.clearCSSHighlights()
    }

    async loadNotesForBook(bookId: string) {
        if (!browser || this.disposed || this.files.isDisposed) return
        // Remove the previous book's notes and highlights before waiting on storage. A
        // reload of the same book keeps its in-flight editing target available.
        const generation = ++this.loadGeneration
        this.clearStaleVisualState(bookId)
        const lifecycleEpoch = this.lifecycleEpoch
        const bookGeneration = this.bookLoadGenerations.get(bookId) ?? 0
        try {
            const loaded = (await this.files.db.userNotes.getByBookId(bookId)) as UserNote[]
            if (
                this.files.isDisposed ||
                lifecycleEpoch !== this.lifecycleEpoch ||
                generation !== this.loadGeneration ||
                bookGeneration !== (this.bookLoadGenerations.get(bookId) ?? 0)
            )
                return
            this.notes = loaded.sort((a, b) => a.createdAt - b.createdAt)
            this.activePopup = null
            this.activeSelection = null
            this.editingNote = null
            this.editorCoords = null
            this.pageRanges.clear()
            this.updateCSSHighlights()
        } catch (e) {
            console.error("[NotesStore] Failed to load notes:", e)
        }
    }

    private bookExists(bookId: string): boolean {
        if (
            this.pendingDeletionBookIds.has(bookId) &&
            !this.files.isNodeDeleting(bookId) &&
            this.files.nodes?.[bookId]?.type === "file"
        ) {
            // A fresh file with a reused id is no longer covered by the old tombstone.
            this.pendingDeletionBookIds.delete(bookId)
        }
        return (
            !this.pendingDeletionBookIds.has(bookId) && this.files.nodes?.[bookId]?.type === "file"
        )
    }

    private isWriteAllowed(bookId: string, noteId?: string): boolean {
        return (
            !this.disposed &&
            (noteId === undefined || !this.pendingDeletionNoteIds.has(noteId)) &&
            this.bookExists(bookId) &&
            !this.pendingDeletionBookIds.has(bookId) &&
            !this.files.isNodeDeleting(bookId) &&
            !this.files.isDisposed
        )
    }

    async addNote(
        bookId: string,
        pageNumber: number,
        start: number,
        end: number,
        text: string,
        noteContent: string,
        color: "yellow" | "green" | "blue" | "pink" | "purple",
    ) {
        if (!this.isWriteAllowed(bookId)) return null
        const note: UserNote = {
            id: crypto.randomUUID(),
            bookId,
            pageNumber,
            start,
            end,
            text,
            noteContent,
            color,
            createdAt: Date.now(),
        }

        const lifecycleEpoch = this.lifecycleEpoch
        this.invalidateBookLoad(bookId)
        const generation = this.bookWriteGenerations.get(bookId) ?? 0
        try {
            if (
                (this.bookWriteGenerations.get(bookId) ?? 0) !== generation ||
                !this.isWriteAllowed(bookId)
            )
                return null
            const written = await this.files.serializeBookMutation(bookId, async () => {
                if (!this.isWriteAllowed(bookId, note.id)) return false
                await this.files.db.userNotes.put(note)
                return true
            })
            if (
                !written ||
                this.disposed ||
                lifecycleEpoch !== this.lifecycleEpoch ||
                this.pendingDeletionBookIds.has(bookId) ||
                this.pendingDeletionNoteIds.has(note.id) ||
                (this.bookWriteGenerations.get(bookId) ?? 0) !== generation ||
                !this.bookExists(bookId) ||
                this.files.isNodeDeleting(bookId) ||
                this.files.isDisposed
            ) {
                // Store disposal/lifecycle invalidation only suppresses publication. A
                // persisted note belongs to the database until an actual deletion owns its
                // cleanup; in particular, never compensate a store-only HMR race with delete.
                return null
            }
            this.notes.push(note)
            this.notes = [...this.notes] // force reactivity update
            this.activePopup = null
            this.activeSelection = null
            this.editingNote = null
            this.editorCoords = null
            // Trigger highlight refresh
            this.queueHighlightUpdate()
            return note
        } catch (e) {
            console.error("[NotesStore] Failed to add note:", e)
            return null
        } finally {
            this.invalidateBookLoad(bookId)
        }
    }

    updateNoteDraft(
        id: string,
        noteContent: string,
        color: "yellow" | "green" | "blue" | "pink" | "purple",
    ): void {
        if (this.disposed || this.files.isDisposed) return
        const idx = this.notes.findIndex((note) => note.id === id)
        if (idx === -1 || this.pendingDeletionNoteIds.has(id)) return

        const updated = { ...this.notes[idx], noteContent, color }
        this.invalidateBookLoad(updated.bookId)
        this.notes[idx] = updated
        this.notes = [...this.notes]
        if (this.editingNote && "id" in this.editingNote && this.editingNote.id === id) {
            this.editingNote = updated
        }
        if (this.activePopup?.note.id === id) {
            this.activePopup = { ...this.activePopup, note: updated }
        }
        for (const [pageNumber, ranges] of this.pageRanges) {
            if (!ranges.some((range) => range.noteId === id)) continue
            this.pageRanges.set(
                pageNumber,
                ranges.map((range) => (range.noteId === id ? { ...range, color } : range)),
            )
        }
        this.queueHighlightUpdate()

        const pending = this.pendingNoteWrites.get(id)
        if (pending) clearTimeout(pending)
        this.pendingNoteWrites.set(
            id,
            setTimeout(() => {
                this.pendingNoteWrites.delete(id)
                void this.persistNote(id)
            }, 300),
        )
    }

    private async persistNote(id: string): Promise<void> {
        const note = this.notes.find((candidate) => candidate.id === id)
        if (!note || !this.isWriteAllowed(note.bookId, id)) return
        const lifecycleEpoch = this.lifecycleEpoch
        this.invalidateBookLoad(note.bookId)
        const generation = this.bookWriteGenerations.get(note.bookId) ?? 0
        const noteGeneration = this.noteWriteGenerations.get(id) ?? 0
        try {
            if (
                (this.bookWriteGenerations.get(note.bookId) ?? 0) !== generation ||
                (this.noteWriteGenerations.get(id) ?? 0) !== noteGeneration ||
                !this.isWriteAllowed(note.bookId, id)
            )
                return
            const written = await this.files.serializeBookMutation(note.bookId, async () => {
                if (!this.isWriteAllowed(note.bookId, id)) return false
                await this.files.db.userNotes.put($state.snapshot(note))
                return true
            })
            if (
                !written ||
                this.disposed ||
                lifecycleEpoch !== this.lifecycleEpoch ||
                this.pendingDeletionBookIds.has(note.bookId) ||
                this.pendingDeletionNoteIds.has(id) ||
                (this.noteWriteGenerations.get(id) ?? 0) !== noteGeneration ||
                (this.bookWriteGenerations.get(note.bookId) ?? 0) !== generation ||
                !this.bookExists(note.bookId) ||
                this.files.isNodeDeleting(note.bookId) ||
                this.files.isDisposed
            ) {
                // An active deletion tombstone is serialized after this write and owns cleanup.
                // Store disposal likewise must not delete an already persisted note.
            }
        } catch (e) {
            console.error("[NotesStore] Failed to update note:", e)
        } finally {
            this.invalidateBookLoad(note.bookId)
        }
    }

    async flushNoteUpdate(id: string): Promise<void> {
        const pending = this.pendingNoteWrites.get(id)
        if (pending) clearTimeout(pending)
        this.pendingNoteWrites.delete(id)
        await this.persistNote(id)
    }

    async updateNote(
        id: string,
        noteContent: string,
        color: "yellow" | "green" | "blue" | "pink" | "purple",
    ): Promise<void> {
        this.updateNoteDraft(id, noteContent, color)
        await this.flushNoteUpdate(id)
    }

    async closeEditor(): Promise<void> {
        const editingNote = this.editingNote
        this.editingNote = null
        this.editorCoords = null
        if (editingNote && "id" in editingNote) await this.flushNoteUpdate(editingNote.id)
    }

    private clearFailedNoteDeletion(id: string, generation: number) {
        if ((this.noteWriteGenerations.get(id) ?? 0) === generation)
            this.pendingDeletionNoteIds.delete(id)
    }

    private async deleteUnknownNote(id: string): Promise<boolean> {
        const deleted = await this.files.serializeMetadataMutation(async () => {
            if (this.disposed || this.files.isDisposed) return false
            await this.files.db.userNotes.delete(id)
            return true
        })
        return deleted === true
    }

    async deleteNote(id: string) {
        if (this.disposed || this.files.isDisposed) return
        const note = this.notes.find((candidate) => candidate.id === id)
        this.pendingDeletionNoteIds.add(id)
        const generation = (this.noteWriteGenerations.get(id) ?? 0) + 1
        this.noteWriteGenerations.set(id, generation)
        if (note) {
            this.invalidateBookLoad(note.bookId)
        }
        const pending = this.pendingNoteWrites.get(id)
        if (pending) clearTimeout(pending)
        this.pendingNoteWrites.delete(id)
        const lifecycleEpoch = this.lifecycleEpoch
        let deleted = false
        try {
            if (note) {
                deleted = !!(await this.files.serializeBookMutation(note.bookId, async () => {
                    if (this.disposed || this.files.isDisposed) return false
                    await this.files.db.userNotes.delete(id)
                    return true
                }))
                if (!deleted) return
            }
            if (!note) {
                deleted = await this.deleteUnknownNote(id)
                if (!deleted) return
            }
            if (this.files.isDisposed || this.disposed || lifecycleEpoch !== this.lifecycleEpoch)
                return
            const noteToDelete = this.notes.find((n) => n.id === id)
            this.notes = this.notes.filter((n) => n.id !== id)

            if (noteToDelete) {
                this.unregisterNoteRange(noteToDelete.pageNumber, id)
            }

            if (this.activePopup?.note.id === id) {
                this.activePopup = null
            }
            if (this.editingNote && "id" in this.editingNote && this.editingNote.id === id) {
                this.editingNote = null
                this.editorCoords = null
            }
            this.queueHighlightUpdate()
        } catch (e) {
            console.error("[NotesStore] Failed to delete note:", e)
        } finally {
            // Clear only this deletion's tombstone. A newer deletion generation remains
            // protected while a completed deletion does not leave the note permanently blocked.
            this.clearFailedNoteDeletion(id, generation)
            if (note) this.invalidateBookLoad(note.bookId)
        }
    }

    clear() {
        this.loadGeneration++
        for (const pending of this.pendingNoteWrites.values()) clearTimeout(pending)
        this.pendingNoteWrites.clear()
        if (this.highlightUpdateFrame !== null && typeof cancelAnimationFrame !== "undefined") {
            cancelAnimationFrame(this.highlightUpdateFrame)
            this.highlightUpdateFrame = null
        }
        this.highlightUpdatePending = false
        this.notes = []
        this.activePopup = null
        this.activeSelection = null
        this.editingNote = null
        this.editorCoords = null
        this.pageRanges.clear()
        this.clearCSSHighlights()
    }

    registerPageRanges(
        pageNumber: number,
        noteRanges: { noteId: string; range: Range; color: string }[],
    ) {
        this.pageRanges.set(pageNumber, noteRanges)
        this.queueHighlightUpdate()
    }

    unregisterPageRanges(pageNumber: number) {
        if (this.pageRanges.has(pageNumber)) {
            this.pageRanges.delete(pageNumber)
            this.queueHighlightUpdate()
        }
    }

    private unregisterNoteRange(pageNumber: number, noteId: string) {
        const ranges = this.pageRanges.get(pageNumber)
        if (ranges) {
            this.pageRanges.set(
                pageNumber,
                ranges.filter((r) => r.noteId !== noteId),
            )
        }
    }

    private highlightUpdateFrame: number | null = null

    queueHighlightUpdate() {
        if (this.disposed || this.highlightUpdatePending) return
        this.highlightUpdatePending = true
        if (typeof requestAnimationFrame !== "undefined") {
            this.highlightUpdateFrame = requestAnimationFrame(() => {
                this.highlightUpdateFrame = null
                this.highlightUpdatePending = false
                if (!this.disposed) this.updateCSSHighlights()
            })
        } else {
            this.highlightUpdatePending = false
            this.updateCSSHighlights()
        }
    }

    private clearCSSHighlights() {
        if (typeof CSS === "undefined" || !CSS.highlights) return
        for (const name of [
            "user-note-yellow",
            "user-note-green",
            "user-note-blue",
            "user-note-pink",
            "user-note-purple",
            "user-note-active",
        ])
            CSS.highlights.delete(name)
    }

    private updateCSSHighlights() {
        if (this.disposed || typeof CSS === "undefined" || !CSS.highlights) return

        untrack(() => {
            const yellowRanges: Range[] = []
            const greenRanges: Range[] = []
            const blueRanges: Range[] = []
            const pinkRanges: Range[] = []
            const purpleRanges: Range[] = []
            const activeRanges: Range[] = []

            const activeNoteId =
                this.activePopup?.note.id ||
                (this.editingNote && !("isNew" in this.editingNote)
                    ? (this.editingNote as UserNote).id
                    : null)

            for (const noteRanges of this.pageRanges.values()) {
                for (const item of noteRanges) {
                    const { noteId, range, color } = item
                    if (
                        range &&
                        range.startContainer &&
                        range.startContainer.isConnected &&
                        range.endContainer &&
                        range.endContainer.isConnected
                    ) {
                        if (noteId === activeNoteId) {
                            activeRanges.push(range)
                        } else {
                            if (color === "yellow") yellowRanges.push(range)
                            else if (color === "green") greenRanges.push(range)
                            else if (color === "blue") blueRanges.push(range)
                            else if (color === "pink") pinkRanges.push(range)
                            else if (color === "purple") purpleRanges.push(range)
                            else yellowRanges.push(range)
                        }
                    }
                }
            }

            try {
                // @ts-ignore - Highlight API is valid in browser but may lack typings
                CSS.highlights.set("user-note-yellow", new Highlight(...yellowRanges))
                // @ts-ignore
                CSS.highlights.set("user-note-green", new Highlight(...greenRanges))
                // @ts-ignore
                CSS.highlights.set("user-note-blue", new Highlight(...blueRanges))
                // @ts-ignore
                CSS.highlights.set("user-note-pink", new Highlight(...pinkRanges))
                // @ts-ignore
                CSS.highlights.set("user-note-purple", new Highlight(...purpleRanges))
                // @ts-ignore
                CSS.highlights.set("user-note-active", new Highlight(...activeRanges))
            } catch (e) {
                console.error("[NotesStore] Failed to update CSS Highlights:", e)
            }
        })
    }
}

export const notesStore = new NotesStore()

if (import.meta.hot) {
    import.meta.hot.dispose(() => notesStore.dispose())
}

// Helper Functions for offset calculation and range matching
export function getGlobalOffset(
    node: Node,
    offset: number,
    cachedSpanRanges: any[],
): number | null {
    if (node.nodeType === Node.TEXT_NODE) {
        const entry = cachedSpanRanges.find((s) => s.textNode === node)
        if (entry) return entry.start + offset
    }
    if (node.nodeType === Node.ELEMENT_NODE) {
        const entry = cachedSpanRanges.find((s) => s.span === node)
        if (entry) {
            if (offset === 0) return entry.start
            if (offset >= node.childNodes.length) return entry.end
            const child = node.childNodes[offset]
            if (child) {
                return getGlobalOffset(child, 0, cachedSpanRanges)
            }
            return entry.start
        }
    }
    // Fallback: search for parent span
    const parentSpan = node.parentElement?.closest("span")
    if (parentSpan) {
        const entry = cachedSpanRanges.find((s) => s.span === parentSpan)
        if (entry) {
            if (entry.textNode === node) {
                return entry.start + offset
            }
            return entry.start
        }
    }
    return null
}

export function getOffsetFromPoint(
    e: MouseEvent,
    textContainer: HTMLElement,
    cachedSpanRanges: any[],
): number | null {
    if (!cachedSpanRanges || cachedSpanRanges.length === 0) return null
    let range: Range | null = null

    // @ts-ignore
    if (document.caretRangeFromPoint) {
        // @ts-ignore
        range = document.caretRangeFromPoint(e.clientX, e.clientY)
    } else if ((e as any).rangeParent) {
        // Firefox fallback
        range = document.createRange()
        range.setStart((e as any).rangeParent, (e as any).rangeOffset)
        range.setEnd((e as any).rangeParent, (e as any).rangeOffset)
    }

    if (!range) return null

    const textNode = range.startContainer
    const offset = range.startOffset

    // Find which span contains this textNode
    const entry = cachedSpanRanges.find(
        (s) => s.textNode === textNode || s.span === textNode || s.span.contains(textNode),
    )
    if (entry) {
        return entry.start + offset
    }
    return null
}

export function getTextNodeAndOffset(
    parent: Node,
    targetOffset: number,
): { node: Node; offset: number } {
    if (parent.nodeType === Node.TEXT_NODE) {
        return { node: parent, offset: targetOffset }
    }
    let current = 0
    for (let i = 0; i < parent.childNodes.length; i++) {
        const child = parent.childNodes[i]
        const textLen = child.textContent?.length || 0
        if (current + textLen >= targetOffset) {
            return getTextNodeAndOffset(child, targetOffset - current)
        }
        current += textLen
    }
    return { node: parent.firstChild || parent, offset: targetOffset - current }
}

export interface SpanRange {
    span: HTMLSpanElement
    textNode: Node
    start: number
    end: number
}

export function buildSpanRanges(textContainer: HTMLElement): SpanRange[] {
    const spans = Array.from(textContainer.querySelectorAll("span"))
    let currentOffset = 0
    return spans.map((span) => {
        const text = span.textContent || ""
        const len = text.length
        const entry = {
            span,
            textNode: span.firstChild || span,
            start: currentOffset,
            end: currentOffset + len,
        }
        currentOffset += len
        return entry
    })
}

export function findSpanByOffset(ranges: SpanRange[], offset: number): SpanRange | null {
    let lo = 0,
        hi = ranges.length - 1
    while (lo <= hi) {
        const mid = (lo + hi) >>> 1
        const entry = ranges[mid]
        if (entry.end <= offset) lo = mid + 1
        else if (entry.start > offset) hi = mid - 1
        else return entry
    }
    return null
}
