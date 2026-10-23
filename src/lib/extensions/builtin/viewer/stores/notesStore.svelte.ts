import { SvelteMap } from "svelte/reactivity"
import { untrack } from "svelte"
import { modalManager } from "$lib/shared/ui/modal/modalManager.svelte"
import type { ReadingWorkspace } from "../readingWorkspace"
import type { ReadingNote as UserNote } from "../readingAnnotations"
import { getViewerStorageErrorDiagnostic } from "../viewerDiagnostics"
import { createViewerHighlights } from "./viewerHighlights"

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

export type NoteEditorState = UserNote

export interface NoteEditorSession {
    id: string
    note: NoteEditorState
    draft: boolean
    saving: boolean
    failed: boolean
}

export class NotesStore {
    private readonly highlights = createViewerHighlights()
    notes = $state<UserNote[]>([])
    drafts = $state<UserNote[]>([])
    private hiddenDrafts = new Set<string>()
    activePopup = $state<PopupState | null>(null)
    activeSelection = $state<SelectionState | null>(null)
    editors = $state<NoteEditorSession[]>([])
    activeEditorId = $state<string | null>(null)
    scrollingToNoteId = $state<string | null>(null)
    failed = $state(false)
    private documentId: string | null = null
    private disposed = false
    private loadGeneration = 0
    private readonly failedDeletions = new Map<string, string>()
    private readonly unsubscribe: () => void
    private pageRanges = new SvelteMap<number, { noteId: string; range: Range; color: string }[]>()
    private highlightUpdatePending = false

    constructor(private readonly workspace?: ReadingWorkspace) {
        this.unsubscribe =
            workspace?.subscribeAnnotations((id, snapshot) => {
                if (id !== this.documentId || this.disposed) return
                this.notes = [...snapshot.notes].sort((a, b) => a.createdAt - b.createdAt)
                this.failed = snapshot.error !== null
                this.syncDraftEditors(snapshot.drafts)
                if (this.activePopup) {
                    const note = this.notes.find(({ id }) => id === this.activePopup?.note.id)
                    this.activePopup = note ? { ...this.activePopup, note } : null
                }
                for (const [page, ranges] of this.pageRanges) {
                    this.pageRanges.set(
                        page,
                        ranges.flatMap((range) => {
                            const note = this.notes.find((note) => note.id === range.noteId)
                            return note ? [{ ...range, color: note.color }] : []
                        }),
                    )
                }
                this.queueHighlightUpdate()
            }) ?? (() => undefined)
    }

    get editingNote(): NoteEditorState | null {
        return this.editors.find(({ id }) => id === this.activeEditorId)?.note ?? null
    }

    openEditor(note: NoteEditorState): string {
        const existing = this.editors.find(
            ({ note: candidate }) => candidate.id === note.id && candidate.bookId === note.bookId,
        )
        if (existing) {
            this.activateEditor(existing.id)
            modalManager.focus(existing.id)
            return existing.id
        }
        const id = `note-editor-${crypto.randomUUID()}`
        this.editors.push({
            id,
            note: { ...note },
            draft: this.drafts.some((draft) => draft.id === note.id),
            saving: false,
            failed: false,
        })
        this.activateEditor(id)
        return id
    }

    private syncDraftEditors(drafts: readonly UserNote[]): void {
        this.drafts = [...drafts]
        this.editors = this.editors.filter(
            (editor) =>
                !editor.draft ||
                editor.saving ||
                drafts.some((draft) => draft.id === editor.note.id),
        )
        for (const draft of drafts) {
            const editor = this.editors.find((editor) => editor.note.id === draft.id)
            if (editor) editor.failed = this.failed
            else if (!this.hiddenDrafts.has(draft.id)) this.openEditor(draft)
        }
    }

    async openDraft(
        input: Omit<UserNote, "id" | "createdAt" | "association"> & {
            association?: UserNote["association"]
        },
    ): Promise<string | undefined> {
        if (!this.workspace || this.disposed) return
        const documentId = input.bookId
        const result = await this.workspace.createDraft(documentId, {
            ...input,
            association: input.association ?? { contentHash: null, verification: "unverified" },
        })
        if (this.disposed || this.documentId !== documentId) return
        this.failed = !result.ok
        if (!result.value) return
        return this.editors.find((editor) => editor.note.id === result.value?.id)?.id
    }

    showDraft(id: string): void {
        const draft = this.drafts.find((draft) => draft.id === id)
        if (!draft) return
        this.hiddenDrafts.delete(id)
        this.openEditor(draft)
    }

    async discardEditor(id: string): Promise<void> {
        const editor = this.editors.find((editor) => editor.id === id)
        if (!editor?.draft || editor.saving || !this.workspace) return
        const { bookId, id: draftId } = editor.note
        await this.workspace.discardDraft(bookId, draftId)
    }

    activateEditor(id: string): void {
        if (!this.editors.some((editor) => editor.id === id)) return
        this.activeEditorId = id
        this.queueHighlightUpdate()
    }

    updateEditor(id: string, change: { noteContent: string; color: UserNote["color"] }): void {
        const editor = this.editors.find((editor) => editor.id === id)
        if (!editor || editor.saving) return
        editor.note = { ...editor.note, ...change }
        if (editor.draft) {
            const { bookId, id: draftId } = editor.note
            void this.workspace?.updateDraft(bookId, draftId, change).then((result) => {
                if (!this.disposed && this.editors.includes(editor)) editor.failed = !result.ok
            })
        } else this.updateNoteDraft(editor.note.id, change.noteContent, change.color)
    }

    async saveEditor(id = this.activeEditorId): Promise<void> {
        const editor = this.editors.find((editor) => editor.id === id)
        if (!editor || editor.saving || !this.workspace || this.disposed) return
        editor.saving = true
        const note = editor.note
        try {
            const result = editor.draft
                ? await this.workspace.saveDraft(note.bookId, note.id)
                : await this.workspace.updateNote(note.bookId, note.id, {
                      noteContent: note.noteContent,
                      color: note.color,
                  })
            // A failed write can already own a recoverable saved-note identity. Retry it,
            // rather than creating a duplicate annotation on the next save.
            if (
                result.value &&
                this.workspace
                    .annotations(note.bookId)
                    .notes.some((item) => item.id === result.value?.id)
            )
                editor.note = result.value
            editor.failed = !result.ok
            if (result.ok && !this.disposed) this.removeEditor(editor.id)
        } finally {
            editor.saving = false
        }
    }

    private removeEditor(id: string): void {
        this.editors = this.editors.filter((editor) => editor.id !== id)
        if (this.activeEditorId === id) this.activeEditorId = this.editors.at(-1)?.id ?? null
        this.queueHighlightUpdate()
    }

    async closeEditor(id = this.activeEditorId): Promise<void> {
        const editor = this.editors.find((editor) => editor.id === id)
        if (!editor || editor.saving) return
        if (!editor.draft) await this.saveEditor(editor.id)
        else {
            this.hiddenDrafts.add(editor.note.id)
            this.removeEditor(editor.id)
        }
    }

    async loadNotesForBook(bookId: string): Promise<void> {
        if (!this.workspace || this.disposed) return
        if (this.documentId !== bookId) this.clear()
        this.documentId = bookId
        const generation = ++this.loadGeneration
        await this.workspace.loadDrafts(bookId)
        if (this.disposed || generation !== this.loadGeneration || this.documentId !== bookId)
            return
        const snapshot = this.workspace.annotations(bookId)
        this.notes = [...snapshot.notes].sort((a, b) => a.createdAt - b.createdAt)
        this.failed = snapshot.error !== null
        this.syncDraftEditors(snapshot.drafts)
        this.queueHighlightUpdate()
    }

    async addNote(
        bookId: string,
        pageNumber: number,
        start: number,
        end: number,
        text: string,
        noteContent: string,
        color: UserNote["color"],
    ) {
        if (!this.workspace || this.disposed) return null
        const result = await this.workspace.createNote(bookId, {
            pageNumber,
            start,
            end,
            text,
            noteContent,
            color,
            association: { contentHash: null, verification: "unverified" },
        })
        this.failed = !result.ok
        return result.ok ? result.value : null
    }

    updateNoteDraft(id: string, noteContent: string, color: UserNote["color"]): void {
        const note = this.notes.find((note) => note.id === id)
        if (!note || this.disposed || !this.workspace) return
        for (const editor of this.editors)
            if ("id" in editor.note && editor.note.id === id)
                editor.note = { ...editor.note, noteContent, color }
        void this.workspace.updateNote(note.bookId, id, { noteContent, color })
    }

    async flushNoteUpdate(id: string): Promise<boolean> {
        const note = this.notes.find((note) => note.id === id)
        if (!note || this.disposed || !this.workspace) return false
        const result = await this.workspace.saveAnnotations(note.bookId)
        return result.ok
    }

    async updateNote(id: string, noteContent: string, color: UserNote["color"]): Promise<void> {
        const note = this.notes.find((note) => note.id === id)
        if (!note || this.disposed || !this.workspace) return
        await this.workspace.updateNote(note.bookId, id, { noteContent, color })
    }

    async deleteNote(id: string): Promise<boolean> {
        const note = this.notes.find((note) => note.id === id)
        const documentId = note?.bookId ?? this.failedDeletions.get(id)
        if (!documentId || this.disposed || !this.workspace) return false
        const result = note
            ? await this.workspace.deleteNote(documentId, id)
            : await this.workspace.saveAnnotations(documentId)
        if (this.disposed) return false
        this.failed = !result.ok
        if (!result.ok) {
            this.failedDeletions.set(id, documentId)
            return false
        }
        this.failedDeletions.delete(id)
        if (note) this.unregisterNoteRange(note.pageNumber, id)
        for (const editor of this.editors.filter(({ note }) => "id" in note && note.id === id))
            this.removeEditor(editor.id)
        this.queueHighlightUpdate()
        return true
    }

    clear() {
        this.loadGeneration++
        this.documentId = null
        if (this.highlightUpdateFrame !== null && typeof cancelAnimationFrame !== "undefined")
            cancelAnimationFrame(this.highlightUpdateFrame)
        this.highlightUpdateFrame = null
        this.highlightUpdatePending = false
        this.notes = []
        this.drafts = []
        this.hiddenDrafts.clear()
        this.activePopup = null
        this.activeSelection = null
        this.editors = []
        this.activeEditorId = null
        this.scrollingToNoteId = null
        this.pageRanges.clear()
        this.clearCSSHighlights()
    }

    reset() {
        this.clear()
    }

    dispose() {
        this.disposed = true
        this.unsubscribe()
        this.clear()
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
        this.highlights.clear()
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

            const activeNoteId = this.activePopup?.note.id || this.editingNote?.id

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
                this.highlights.set("user-note-yellow", yellowRanges)
                this.highlights.set("user-note-green", greenRanges)
                this.highlights.set("user-note-blue", blueRanges)
                this.highlights.set("user-note-pink", pinkRanges)
                this.highlights.set("user-note-purple", purpleRanges)
                this.highlights.set("user-note-active", activeRanges)
            } catch (error) {
                console.error(
                    "[NotesStore] Failed to update CSS Highlights:",
                    getViewerStorageErrorDiagnostic(error, "Unable to update note highlights"),
                )
            }
        })
    }
}

export let notesStore = new NotesStore()

export function installNotesStore(store: NotesStore): void {
    notesStore = store
}

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
