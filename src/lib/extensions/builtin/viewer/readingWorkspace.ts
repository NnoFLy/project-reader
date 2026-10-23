import { DocumentAccess, DocumentAccessUnavailableError } from "$lib/core/documents/document-access"
import type { ViewerFileCapability } from "./viewerHost"
import type { ViewerDocumentLoader } from "./viewerDocument"
import { fileNodeToBook, type Book } from "./stores/viewerStore.types"
import {
    ReadingStorageError,
    type ReadingDocumentState,
    type ReadingLayout,
    type ReadingStorage,
} from "./readingStorage"

import {
    freezeAnnotations,
    isAnnotationId,
    readNote,
    readBookmark,
    type ReadingBookmark,
    type ReadingBookmarkInput,
    type ReadingAnnotations,
    type ReadingNote,
    type ReadingNoteInput,
} from "./readingAnnotations"

export type ReadingMutationResult<T> =
    | { readonly ok: true; readonly value: T }
    | { readonly ok: false; readonly error: ReadingStorageError; readonly value?: T }

export interface ReadingAnnotationSnapshot extends ReadingAnnotations {
    readonly loaded: boolean
    readonly dirty: boolean
    readonly error: ReadingStorageError["code"] | null
}

export interface ReadingSummary {
    readonly documentId: string
    readonly noteCount: number
    readonly bookmarkCount: number
}

type AnnotationListener = (documentId: string, snapshot: ReadingAnnotationSnapshot) => void
const EMPTY_ANNOTATIONS: ReadingAnnotationSnapshot = Object.freeze({
    ...freezeAnnotations([]),
    loaded: false,
    dirty: false,
    error: null,
})

export interface ViewerOpenFailure {
    readonly bookId: string
    readonly error: unknown
}

export interface ReadingSnapshot {
    readonly documentId: string | null
    readonly state: ReadingDocumentState
    readonly status: "closed" | "ready" | "unavailable" | "missing"
}

export interface ReadingWorkspaceOptions {
    readonly files: ViewerFileCapability
    readonly loader?: ViewerDocumentLoader
    readonly storage?: ReadingStorage
    readonly writeSignal?: AbortSignal
    readonly defaults?: () => Pick<ReadingDocumentState, "scale" | "layout">
    readonly onChange?: (snapshot: ReadingSnapshot) => void
    readonly onStorageError?: (error: ReadingStorageError) => void
    readonly getCurrentBook: () => Book | null
    /** Synchronous, atomic publication: false or a throw rejects ownership transfer. */
    readonly publish: (book: Book | null) => boolean | void
}

/** Viewer-owned single-reader behavior; core owns acquisition and resource correctness. */
export class ReadingWorkspace {
    private readonly access: DocumentAccess
    private synchronization?: Promise<void>
    private relinkPending = false
    private storage?: ReadingStorage
    private revision = 0
    private disposed = false
    private writesClosed = false
    private disposal?: Promise<void>
    private queue: Promise<void> = Promise.resolve()
    private readonly states = new Map<string, ReadingDocumentState>()
    private current: ReadingSnapshot
    private readonly annotationStates = new Map<string, ReadingAnnotationSnapshot>()
    private readonly annotationListeners = new Set<AnnotationListener>()
    private readonly annotationEpochs = new Map<string, number>()
    private readonly annotationLoads = new Map<
        string,
        { readonly owns: () => boolean; readonly promise: Promise<boolean> }
    >()
    private readonly invalidAnnotations = new Set<string>()

    constructor(private readonly options: ReadingWorkspaceOptions) {
        this.access = new DocumentAccess(options.files)
        this.storage = options.storage
        this.current = { documentId: null, state: this.defaultState(), status: "closed" }
    }

    get snapshot(): ReadingSnapshot {
        return this.current
    }

    annotations(documentId: string): ReadingAnnotationSnapshot {
        return this.annotationStates.get(documentId) ?? EMPTY_ANNOTATIONS
    }

    subscribeAnnotations(listener: AnnotationListener): () => void {
        if (!this.disposed) this.annotationListeners.add(listener)
        return () => this.annotationListeners.delete(listener)
    }

    async getReadingSummary(documentId: string): Promise<ReadingSummary | null> {
        if (!(await this.loadAnnotations(documentId))) return null
        const state = this.annotations(documentId)
        return Object.freeze({
            documentId,
            noteCount: state.notes.length,
            bookmarkCount: state.bookmarks.length,
        })
    }

    private publishAnnotations(
        documentId: string,
        state: ReadingAnnotations,
        loaded: boolean,
        dirty: boolean,
        error: ReadingStorageError["code"] | null = null,
    ): void {
        if (this.disposed) return
        const snapshot = Object.freeze({ ...state, loaded, dirty, error })
        this.annotationStates.set(documentId, snapshot)
        for (const listener of this.annotationListeners) listener(documentId, snapshot)
    }

    private loadAnnotationsForMutation(documentId: string): Promise<boolean> {
        const owns = this.annotationOwnership(documentId)
        if (!owns) return Promise.resolve(false)
        const pending = this.annotationLoads.get(documentId)
        // Share mutation hydration so edits resume in initiation order, even if a
        // separate reader load publishes before this hydration completes.
        if (pending?.owns()) return pending.promise
        const promise = this.loadAnnotations(documentId).finally(() => {
            if (this.annotationLoads.get(documentId)?.promise === promise)
                this.annotationLoads.delete(documentId)
        })
        this.annotationLoads.set(documentId, { owns, promise })
        return promise
    }

    async loadAnnotations(documentId: string): Promise<boolean> {
        const owns = this.annotationOwnership(documentId)
        if (!owns) return false
        if (this.annotations(documentId).loaded) return true
        try {
            if (!this.storage) throw new ReadingStorageError("reading.storage.read")
            const state = await this.storage.readAnnotations(documentId)
            if (this.disposed || !owns()) return false
            // A newer load or mutation owns the cache once published.
            if (!this.annotations(documentId).loaded)
                this.publishAnnotations(documentId, state, true, false)
            return true
        } catch (error) {
            if (!this.disposed && owns() && !this.annotations(documentId).loaded) {
                this.publishAnnotations(
                    documentId,
                    this.annotations(documentId),
                    false,
                    false,
                    "reading.storage.read",
                )
                this.report(error, "reading.storage.read")
            }
            return false
        }
    }

    /** Adapter deletion/invalidation fence. Neither discards work nor deletes durable data. */
    invalidateAnnotations(documentId: string): void {
        if (this.disposed) return
        this.annotationEpochs.set(documentId, (this.annotationEpochs.get(documentId) ?? 0) + 1)
        this.invalidAnnotations.add(documentId)
    }

    /** Only an adapter-confirmed available identity/rollback may resume new annotation writes. */
    resumeAnnotations(documentId: string): void {
        if (!this.disposed && this.options.files.nodes[documentId]?.type === "file")
            this.invalidAnnotations.delete(documentId)
    }

    private annotationOwnership(documentId: string): (() => boolean) | null {
        if (
            typeof documentId !== "string" ||
            !documentId.trim() ||
            documentId.length > 1024 ||
            Array.from(documentId).some((character) => {
                const code = character.charCodeAt(0)
                return code < 32 || code === 127
            })
        )
            return null
        const node = this.options.files.nodes[documentId]
        if (
            this.disposed ||
            this.invalidAnnotations.has(documentId) ||
            this.options.writeSignal?.aborted ||
            !node ||
            node.type !== "file"
        )
            return null
        const generation = this.options.files.getContentGeneration(documentId)
        const epoch = this.annotationEpochs.get(documentId) ?? 0
        return () =>
            !this.writesClosed &&
            !this.options.writeSignal?.aborted &&
            !this.invalidAnnotations.has(documentId) &&
            (this.annotationEpochs.get(documentId) ?? 0) === epoch &&
            this.options.files.nodes[documentId] === node &&
            this.options.files.getContentGeneration(documentId) === generation
    }

    async createNote(
        documentId: string,
        input: ReadingNoteInput,
    ): Promise<ReadingMutationResult<ReadingNote>> {
        const owns = this.annotationOwnership(documentId)
        if (!owns)
            return { ok: false, error: new ReadingStorageError("reading.storage.invalid-input") }
        const note = readNote(
            { ...input, id: crypto.randomUUID(), bookId: documentId, createdAt: Date.now() },
            documentId,
        )
        if (!note)
            return { ok: false, error: new ReadingStorageError("reading.storage.invalid-input") }
        if (!(await this.loadAnnotationsForMutation(documentId)))
            return {
                ok: false,
                error: new ReadingStorageError("reading.storage.read"),
                value: note,
            }
        if (this.disposed || !owns())
            return { ok: false, error: new ReadingStorageError("reading.storage.write") }
        const state = freezeAnnotations(
            [...this.annotations(documentId).notes, note],
            this.annotations(documentId).bookmarks,
        )
        this.publishAnnotations(documentId, state, true, true)
        return this.persistAnnotations(documentId, state, note, owns)
    }

    async updateNote(
        documentId: string,
        noteId: string,
        changes: Pick<ReadingNoteInput, "noteContent" | "color">,
    ): Promise<ReadingMutationResult<ReadingNote>> {
        const { noteContent, color } = changes
        const owns = this.annotationOwnership(documentId)
        if (!owns)
            return { ok: false, error: new ReadingStorageError("reading.storage.invalid-input") }
        if (!(await this.loadAnnotationsForMutation(documentId)))
            return { ok: false, error: new ReadingStorageError("reading.storage.read") }
        if (this.disposed || !owns())
            return { ok: false, error: new ReadingStorageError("reading.storage.write") }
        const current = this.annotations(documentId)
        const previous = current.notes.find((note) => note.id === noteId)
        const note = previous && readNote({ ...previous, noteContent, color }, documentId)
        if (!note)
            return { ok: false, error: new ReadingStorageError("reading.storage.invalid-input") }
        const state = freezeAnnotations(
            current.notes.map((item) => (item.id === noteId ? note : item)),
            current.bookmarks,
        )
        this.publishAnnotations(documentId, state, true, true)
        return this.persistAnnotations(documentId, state, note, owns)
    }

    async deleteNote(documentId: string, noteId: string): Promise<ReadingMutationResult<void>> {
        if (!isAnnotationId(noteId))
            return { ok: false, error: new ReadingStorageError("reading.storage.invalid-input") }
        const owns = this.annotationOwnership(documentId)
        if (!owns)
            return { ok: false, error: new ReadingStorageError("reading.storage.invalid-input") }
        if (!(await this.loadAnnotationsForMutation(documentId)))
            return { ok: false, error: new ReadingStorageError("reading.storage.read") }
        if (this.disposed || !owns())
            return { ok: false, error: new ReadingStorageError("reading.storage.write") }
        const state = freezeAnnotations(
            this.annotations(documentId).notes.filter((note) => note.id !== noteId),
            this.annotations(documentId).bookmarks,
        )
        this.publishAnnotations(documentId, state, true, true)
        return this.persistAnnotations(documentId, state, undefined, owns)
    }

    async createBookmark(
        documentId: string,
        input: ReadingBookmarkInput,
    ): Promise<ReadingMutationResult<ReadingBookmark>> {
        const owns = this.annotationOwnership(documentId)
        if (!owns)
            return { ok: false, error: new ReadingStorageError("reading.storage.invalid-input") }
        const bookmark = readBookmark(
            { ...input, id: crypto.randomUUID(), bookId: documentId, createdAt: Date.now() },
            documentId,
        )
        if (!bookmark)
            return { ok: false, error: new ReadingStorageError("reading.storage.invalid-input") }
        if (!(await this.loadAnnotationsForMutation(documentId)))
            return {
                ok: false,
                error: new ReadingStorageError("reading.storage.read"),
                value: bookmark,
            }
        if (this.disposed || !owns())
            return { ok: false, error: new ReadingStorageError("reading.storage.write") }
        const current = this.annotations(documentId)
        const state = freezeAnnotations(current.notes, [...current.bookmarks, bookmark])
        this.publishAnnotations(documentId, state, true, true)
        return this.persistAnnotations(documentId, state, bookmark, owns)
    }

    async updateBookmark(
        documentId: string,
        bookmarkId: string,
        name: string,
    ): Promise<ReadingMutationResult<ReadingBookmark>> {
        const owns = this.annotationOwnership(documentId)
        if (!owns)
            return { ok: false, error: new ReadingStorageError("reading.storage.invalid-input") }
        if (!(await this.loadAnnotationsForMutation(documentId)))
            return { ok: false, error: new ReadingStorageError("reading.storage.read") }
        if (this.disposed || !owns())
            return { ok: false, error: new ReadingStorageError("reading.storage.write") }
        const current = this.annotations(documentId)
        const previous = current.bookmarks.find((bookmark) => bookmark.id === bookmarkId)
        const bookmark = previous && readBookmark({ ...previous, name }, documentId)
        if (!bookmark)
            return { ok: false, error: new ReadingStorageError("reading.storage.invalid-input") }
        const state = freezeAnnotations(
            current.notes,
            current.bookmarks.map((item) => (item.id === bookmarkId ? bookmark : item)),
        )
        this.publishAnnotations(documentId, state, true, true)
        return this.persistAnnotations(documentId, state, bookmark, owns)
    }

    async deleteBookmark(
        documentId: string,
        bookmarkId: string,
    ): Promise<ReadingMutationResult<void>> {
        if (!isAnnotationId(bookmarkId))
            return { ok: false, error: new ReadingStorageError("reading.storage.invalid-input") }
        const owns = this.annotationOwnership(documentId)
        if (!owns)
            return { ok: false, error: new ReadingStorageError("reading.storage.invalid-input") }
        if (!(await this.loadAnnotationsForMutation(documentId)))
            return { ok: false, error: new ReadingStorageError("reading.storage.read") }
        if (this.disposed || !owns())
            return { ok: false, error: new ReadingStorageError("reading.storage.write") }
        const current = this.annotations(documentId)
        const state = freezeAnnotations(
            current.notes,
            current.bookmarks.filter((bookmark) => bookmark.id !== bookmarkId),
        )
        this.publishAnnotations(documentId, state, true, true)
        return this.persistAnnotations(documentId, state, undefined, owns)
    }

    /** Retry retained failed writes, including deletions; never reload over dirty work. */
    async saveAnnotations(documentId: string): Promise<ReadingMutationResult<void>> {
        const owns = this.annotationOwnership(documentId)
        if (!owns)
            return { ok: false, error: new ReadingStorageError("reading.storage.invalid-input") }
        if (!(await this.loadAnnotationsForMutation(documentId)))
            return { ok: false, error: new ReadingStorageError("reading.storage.read") }
        if (this.disposed || !owns())
            return { ok: false, error: new ReadingStorageError("reading.storage.write") }
        return this.persistAnnotations(documentId, this.annotations(documentId), undefined, owns)
    }

    private async persistAnnotations<T>(
        documentId: string,
        state: ReadingAnnotations,
        value: T,
        owns: () => boolean,
    ): Promise<ReadingMutationResult<T>> {
        let result: ReadingMutationResult<T> = {
            ok: false,
            error: new ReadingStorageError("reading.storage.write"),
            value,
        }
        this.queue = this.queue.then(async () => {
            if (!owns()) return
            try {
                if (!this.storage) throw new ReadingStorageError("reading.storage.write")
                await this.storage.writeAnnotations(documentId, state)
                if (!owns()) return
                result = { ok: true, value }
                const latest = this.annotations(documentId)
                if (latest.notes === state.notes && latest.bookmarks === state.bookmarks)
                    this.publishAnnotations(documentId, state, true, false)
            } catch (error) {
                if (!owns()) return
                this.report(error, "reading.storage.write")
                const latest = this.annotations(documentId)
                if (latest.notes === state.notes && latest.bookmarks === state.bookmarks)
                    this.publishAnnotations(documentId, state, true, true, "reading.storage.write")
            }
        })
        await this.queue
        return result
    }

    private defaultState(): ReadingDocumentState {
        return Object.freeze({
            pageNumber: 1,
            scrollPosition: 0,
            scale: 1.5,
            layout: "scroll",
            ...this.options.defaults?.(),
        })
    }

    private change(
        documentId: string | null,
        state: ReadingDocumentState,
        status: ReadingSnapshot["status"],
    ): void {
        this.current = Object.freeze({ documentId, state: Object.freeze({ ...state }), status })
        if (documentId) this.states.set(documentId, this.current.state)
        this.options.onChange?.(this.current)
    }

    /** Readiness is bounded; "pending" leaves a fenced restoration running, not a successful restore. */
    async restore(storage = this.storage): Promise<"complete" | "pending"> {
        if (this.disposed || !storage) return "complete"
        this.storage = storage
        if (this.revision !== 0) {
            this.save(true)
            return "complete"
        }
        const revision = this.revision
        const restore = async () => {
            try {
                const id = await storage.readCurrent()
                if (this.disposed || revision !== this.revision || !id) return
                await this.select(id, true, undefined, false, revision, true)
            } catch (error) {
                this.report(error, "reading.storage.read")
            }
        }
        return (await this.bounded(restore())) ? "complete" : "pending"
    }

    open(
        id: string,
        onFailure?: (failure: ViewerOpenFailure) => void | Promise<void>,
    ): Promise<boolean> {
        return this.select(id, true, onFailure, false, ++this.revision)
    }

    setCurrentBook(book: Book | null): Promise<boolean> {
        if (!book) return this.close().then(() => true)
        // Library metadata is not a reading-state fallback.
        return this.open(book.id)
    }

    setPosition(pageNumber: number, scrollPosition = 0): void {
        if (!Number.isSafeInteger(pageNumber) || pageNumber < 1 || !Number.isFinite(scrollPosition))
            return
        this.update({ pageNumber, scrollPosition })
    }

    setScale(scale: number): void {
        if (!Number.isFinite(scale) || scale < 0.25 || scale > 5) return
        this.update({ scale })
    }

    setLayout(layout: ReadingLayout): void {
        if (layout !== "single" && layout !== "split" && layout !== "scroll") return
        this.update({ layout })
    }

    private update(changes: Partial<ReadingDocumentState>): void {
        if (this.disposed || !this.current.documentId) return
        const state = { ...this.current.state, ...changes }
        if (
            Object.entries(changes).every(
                ([key, value]) => this.current.state[key as keyof ReadingDocumentState] === value,
            )
        )
            return
        this.change(this.current.documentId, state, this.current.status)
        this.save(false)
    }

    private save(pointer: boolean): void {
        const storage = this.storage
        const { documentId, state } = this.current
        if (!storage || this.disposed || this.options.writeSignal?.aborted) return
        // Capture immutable identity/state now, never read the visible document in queued work.
        this.queue = this.queue.then(async () => {
            if (this.writesClosed || this.options.writeSignal?.aborted) return
            if (documentId) {
                try {
                    await storage.writeDocument(documentId, state)
                } catch (error) {
                    this.report(error, "reading.storage.write")
                }
            }
            if (pointer && !this.writesClosed && !this.options.writeSignal?.aborted) {
                try {
                    await storage.writeCurrent(documentId)
                } catch (error) {
                    this.report(error, "reading.storage.write")
                }
            }
        })
    }

    private report(error: unknown, fallback: ReadingStorageError["code"]): void {
        if (!this.disposed && !this.options.writeSignal?.aborted)
            this.options.onStorageError?.(
                error instanceof ReadingStorageError ? error : new ReadingStorageError(fallback),
            )
    }

    /** Bounded drain; a stuck backend stays serialized and cannot delay host writer fencing. */
    flush(): Promise<void> {
        return this.bounded(this.queue).then(() => undefined)
    }

    private async bounded(operation: Promise<unknown>): Promise<boolean> {
        let timer: ReturnType<typeof setTimeout> | undefined
        try {
            return await Promise.race([
                operation.then(() => true),
                new Promise<false>((resolve) => {
                    timer = setTimeout(() => resolve(false), 250)
                }),
            ])
        } finally {
            clearTimeout(timer)
        }
    }

    synchronize(relinked = false): Promise<void> {
        this.relinkPending ||= relinked
        if (this.synchronization) return this.synchronization
        const synchronize = async () => {
            do {
                const refresh = this.relinkPending
                this.relinkPending = false
                const book = this.options.getCurrentBook()
                const id = book?.id ?? this.current.documentId
                if (!id) return
                await this.select(id, refresh, undefined, true, this.revision)
            } while (this.relinkPending)
        }
        const operation = synchronize()
        this.synchronization = operation
        void operation
            .finally(() => {
                if (this.synchronization === operation) this.synchronization = undefined
            })
            .catch(() => undefined)
        return operation
    }

    private async select(
        id: string,
        restoreAccess = false,
        onFailure?: (failure: ViewerOpenFailure) => void | Promise<void>,
        maintenance = false,
        revision = this.revision,
        restoring = false,
    ): Promise<boolean> {
        const current = () => !this.disposed && revision === this.revision
        if (!current()) return false
        let state = this.states.get(id)
        if (!state && this.storage) {
            try {
                state = (await this.storage.readDocument(id)) ?? undefined
            } catch (error) {
                this.report(error, "reading.storage.read")
            }
            if (!current()) return false
        }
        state ??= this.defaultState()
        const selectedState = state
        try {
            const accepted = await this.access.select(
                id,
                (url) => {
                    if (!current()) return false
                    const node = this.options.files.nodes[id]
                    if (!node || node.type !== "file") return false
                    const latest = this.states.get(id) ?? selectedState
                    const accepted = this.options.publish({
                        ...fileNodeToBook(node),
                        pageNumber: latest.pageNumber,
                        scrollPosition: latest.scrollPosition,
                        url: url ?? "",
                        isLocked: url ? this.options.files.isLockedMap[id] : true,
                    })
                    if (accepted === false) return false
                    this.change(id, latest, url ? "ready" : "unavailable")
                    if (!restoring) this.save(true)
                    return true
                },
                restoreAccess,
                maintenance,
            )
            if (
                !accepted &&
                current() &&
                this.options.files.nodes[id]?.type !== "file" &&
                (restoring ||
                    this.current.documentId === id ||
                    this.options.getCurrentBook()?.id === id)
            ) {
                const closing = this.access.close(false)
                this.options.publish(null)
                this.change(id, selectedState, "missing")
                await closing
            }
            return accepted
        } catch (error) {
            if (!(error instanceof DocumentAccessUnavailableError)) throw error
            if (!current()) return false
            if (
                restoring ||
                this.current.documentId === id ||
                this.options.getCurrentBook()?.id === id
            ) {
                const closing = this.access.close(false)
                const node = this.options.files.nodes[id]
                this.options.publish(
                    node
                        ? {
                              ...fileNodeToBook(node),
                              pageNumber: selectedState.pageNumber,
                              scrollPosition: selectedState.scrollPosition,
                              url: "",
                              isLocked: true,
                          }
                        : null,
                )
                this.change(
                    id,
                    this.states.get(id) ?? selectedState,
                    node ? "unavailable" : "missing",
                )
                await closing
            }
            if (restoreAccess && !restoring) {
                this.options.files.requestRelink(id)
                await onFailure?.({ bookId: id, error })
            }
            return false
        }
    }

    async retry(): Promise<boolean> {
        const id = this.current.documentId
        return id ? this.open(id) : false
    }

    requestRelink(): void {
        if (!this.disposed && this.current.documentId)
            this.options.files.requestRelink(this.current.documentId)
    }

    loadDocument(signal?: AbortSignal) {
        // Core fences loads by source ownership, not by same-session selection attempts.
        return this.access.load((claim, signal) => {
            const loader = this.options.loader
            if (!loader) throw new Error("The workspace document loader is unavailable")
            return loader.open(
                {
                    id: claim.id,
                    url: claim.url,
                    name: this.options.files.nodes[claim.id]?.name ?? "document",
                },
                signal,
            )
        }, signal)
    }

    async close(): Promise<void> {
        if (this.disposed) return
        this.revision++
        const closing = this.access.close()
        this.options.publish(null)
        this.change(null, this.defaultState(), "closed")
        this.save(true)
        await closing
    }

    dispose(): Promise<void> {
        if (!this.disposal) {
            this.revision++
            // Fence publication and new mutations synchronously. The host has already revoked
            // its write signal on shutdown; never revive that lifetime to finish saving.
            this.disposed = true
            this.annotationListeners.clear()
            this.disposal = this.bounded(Promise.all([this.queue, this.access.dispose()]))
                .then(() => undefined)
                .finally(() => {
                    this.writesClosed = true
                })
        }
        return this.disposal
    }
}
