import type { StorageNamespace } from "$lib/extension-api/storage"
import {
    freezeAnnotations,
    readNote,
    readBookmark,
    type ReadingAnnotations,
    type ReadingDraft,
    type ReadingRecords,
} from "./readingAnnotations"

export type ReadingLayout = "single" | "split" | "scroll"

export interface ReadingDocumentState {
    readonly pageNumber: number
    readonly scrollPosition: number
    readonly scale: number
    readonly layout: ReadingLayout
}

export class ReadingStorageError extends Error {
    constructor(
        readonly code:
            | "reading.storage.read"
            | "reading.storage.write"
            | "reading.storage.invalid-input",
    ) {
        super(
            code === "reading.storage.read"
                ? "Unable to load reading state"
                : code === "reading.storage.write"
                  ? "Unable to save reading state"
                  : "Invalid reading state",
        )
        this.name = "ReadingStorageError"
    }
}

const VERSION = 1
const CURRENT_KEY = "reading-v1-current"
const DOCUMENT_PREFIX = "reading-v1-document-"
const ANNOTATIONS_PREFIX = "reading-v1-annotations-"
const DELETION_PREFIX = "reading-v1-deletion-recovery-"
const DELETION_CURRENT_KEY = "reading-v1-deletion-current"
const MAX_DOCUMENT_ID_LENGTH = 1024

export function isDocumentId(value: unknown): value is string {
    return (
        typeof value === "string" &&
        value.length > 0 &&
        value.length <= MAX_DOCUMENT_ID_LENGTH &&
        value.trim().length > 0
    )
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function readState(value: Record<string, unknown>): ReadingDocumentState | null {
    const { pageNumber, scrollPosition, scale, layout } = value
    if (
        typeof pageNumber !== "number" ||
        !Number.isSafeInteger(pageNumber) ||
        pageNumber < 1 ||
        typeof scrollPosition !== "number" ||
        !Number.isFinite(scrollPosition) ||
        typeof scale !== "number" ||
        !Number.isFinite(scale) ||
        scale < 0.25 ||
        scale > 5 ||
        (layout !== "single" && layout !== "split" && layout !== "scroll")
    ) {
        return null
    }
    return { pageNumber, scrollPosition, scale, layout }
}

function documentKey(documentId: string, prefix = DOCUMENT_PREFIX): string {
    if (!isDocumentId(documentId)) throw new ReadingStorageError("reading.storage.invalid-input")
    // Fixed-width UTF-16 encoding is injective, including lone surrogates, and key-safe.
    let encoded = ""
    for (let index = 0; index < documentId.length; index++) {
        encoded += documentId.charCodeAt(index).toString(16).padStart(4, "0")
    }
    return `${prefix}${encoded}`
}

export function readAnnotations(value: unknown, documentId: string): ReadingRecords | null {
    if (
        !isRecord(value) ||
        !Array.isArray(value.notes) ||
        value.notes.length > 10_000 ||
        !Array.isArray(value.bookmarks) ||
        value.bookmarks.length > 10_000 ||
        (value.drafts !== undefined &&
            (!Array.isArray(value.drafts) || value.drafts.length > 10_000))
    )
        return null
    const notes = Array.from(value.notes, (note) => readNote(note, documentId))
    // #42 envelopes omit drafts. No unsupported legacy records are read or migrated.
    const drafts = Array.from(value.drafts ?? [], (draft) => readNote(draft, documentId))
    const bookmarks = Array.from(value.bookmarks, (bookmark) => readBookmark(bookmark, documentId))
    if (
        !notes.every((note) => note !== null) ||
        !bookmarks.every((bookmark) => bookmark !== null) ||
        !drafts.every((draft) => draft !== null)
    )
        return null
    if (
        new Set(notes.map((note) => note.id)).size !== notes.length ||
        new Set(bookmarks.map((bookmark) => bookmark.id)).size !== bookmarks.length ||
        new Set(drafts.map((draft) => draft.id)).size !== drafts.length
    )
        return null
    return freezeAnnotations(notes, bookmarks, drafts)
}

/**
 * Viewer v1 authoritative envelope: notes, bookmarks, optional drafts (default []).
 * Drafts use the validated note shape but remain unfinished; one envelope permits
 * atomic save-to-note + draft removal. The host namespace owns writer fencing.
 */
export interface ReadingDeletionRecovery extends ReadingRecords {
    readonly state: ReadingDocumentState | null
}

export class ReadingStorage {
    constructor(private readonly storage: StorageNamespace) {}

    private deletionRecovery(value: unknown, documentId: string): ReadingDeletionRecovery {
        const records =
            isRecord(value) && value.version === VERSION && value.documentId === documentId
                ? readAnnotations(value, documentId)
                : null
        const state = isRecord(value) && isRecord(value.state) ? readState(value.state) : null
        if (!records || !isRecord(value) || (value.state !== null && !state))
            throw new ReadingStorageError("reading.storage.read")
        return { ...records, state }
    }

    async readDeletionCurrent(): Promise<string | null> {
        const value = await this.storage.get<unknown>(DELETION_CURRENT_KEY)
        if (value === undefined) return null
        if (!isRecord(value) || !isDocumentId(value.documentId))
            throw new ReadingStorageError("reading.storage.read")
        this.deletionRecovery(value, value.documentId)
        return value.documentId
    }

    async readDeletionRecovery(documentId: string): Promise<ReadingDeletionRecovery | null> {
        const value = await this.storage.get<unknown>(documentKey(documentId, DELETION_PREFIX))
        if (value !== undefined) return this.deletionRecovery(value, documentId)
        const current = await this.storage.get<unknown>(DELETION_CURRENT_KEY)
        return isRecord(current) && current.documentId === documentId
            ? this.deletionRecovery(current, documentId)
            : null
    }

    /** Acknowledged recovery precedes every destructive primary-key mutation. */
    async retainDeletionRecovery(
        documentId: string,
        memory: ReadingDeletionRecovery & { readonly loaded: boolean },
        owns: () => boolean,
    ): Promise<ReadingDeletionRecovery> {
        // An unsupported reference is not authority to replace or destroy recovery material.
        await this.readDeletionCurrent()
        let recovery = await this.readDeletionRecovery(documentId)
        if (!recovery) {
            const state = memory.state ?? (await this.readDocument(documentId))
            // Loaded empty snapshots are authoritative too (for example a failed last-note removal).
            const records = memory.loaded
                ? freezeAnnotations(memory.notes, memory.bookmarks, memory.drafts)
                : await this.readAnnotations(documentId)
            recovery = { ...records, state }
            if (!owns()) throw new ReadingStorageError("reading.storage.write")
            await this.storage.set(documentKey(documentId, DELETION_PREFIX), {
                version: VERSION,
                documentId,
                ...recovery,
            })
        }
        const current = await this.readCurrent()
        if (!owns()) throw new ReadingStorageError("reading.storage.write")
        if (current === documentId)
            await this.storage.set(DELETION_CURRENT_KEY, {
                version: VERSION,
                documentId,
                ...recovery,
            })
        return recovery
    }

    /** Retire only supported matching recovery, after Library acknowledges primary cleanup. */
    async retireDeletionRecovery(documentId: string, owns: () => boolean): Promise<void> {
        const recovery = await this.readDeletionRecovery(documentId)
        const current = await this.readDeletionCurrent()
        if (!owns()) throw new ReadingStorageError("reading.storage.write")
        // The matching reference also carries recovery until its own retirement acknowledges.
        if (recovery) await this.storage.delete(documentKey(documentId, DELETION_PREFIX))
        if (!owns()) throw new ReadingStorageError("reading.storage.write")
        if (current === documentId) await this.storage.delete(DELETION_CURRENT_KEY)
    }

    /** Exact supported v1 envelopes only; unsupported/legacy data is not purge authority. */
    async deleteDocument(documentId: string, owns: () => boolean = () => true): Promise<void> {
        try {
            for (const prefix of [ANNOTATIONS_PREFIX, DOCUMENT_PREFIX]) {
                const key = documentKey(documentId, prefix)
                const value = await this.storage.get<unknown>(key)
                if (!owns()) throw new ReadingStorageError("reading.storage.write")
                if (
                    isRecord(value) &&
                    value.version === VERSION &&
                    value.documentId === documentId &&
                    (prefix === ANNOTATIONS_PREFIX
                        ? readAnnotations(value, documentId)
                        : readState(value))
                )
                    await this.storage.delete(key)
            }
            const current = await this.readCurrent()
            if (!owns()) throw new ReadingStorageError("reading.storage.write")
            if (current === documentId) await this.storage.delete(CURRENT_KEY)
        } catch {
            throw new ReadingStorageError("reading.storage.write")
        }
    }

    async readAnnotations(documentId: string): Promise<ReadingRecords> {
        const key = documentKey(documentId, ANNOTATIONS_PREFIX)
        try {
            const value = await this.storage.get<unknown>(key)
            if (value === undefined) return freezeAnnotations([])
            const state =
                isRecord(value) && value.version === VERSION && value.documentId === documentId
                    ? readAnnotations(value, documentId)
                    : null
            if (!state) throw new ReadingStorageError("reading.storage.read")
            return state
        } catch {
            throw new ReadingStorageError("reading.storage.read")
        }
    }

    async writeAnnotations(
        documentId: string,
        state: ReadingAnnotations & { readonly drafts?: readonly ReadingDraft[] },
    ): Promise<void> {
        const key = documentKey(documentId, ANNOTATIONS_PREFIX)
        const validated = readAnnotations(state, documentId)
        if (!validated) throw new ReadingStorageError("reading.storage.invalid-input")
        try {
            await this.storage.set(key, { version: VERSION, documentId, ...validated })
        } catch {
            throw new ReadingStorageError("reading.storage.write")
        }
    }

    async readCurrent(): Promise<string | null> {
        try {
            const value = await this.storage.get<unknown>(CURRENT_KEY)
            if (!isRecord(value) || value.version !== VERSION || !isDocumentId(value.documentId)) {
                return null
            }
            return value.documentId
        } catch {
            throw new ReadingStorageError("reading.storage.read")
        }
    }

    /** Clearing the new pointer leaves all document state and legacy records intact. */
    async writeCurrent(documentId: string | null): Promise<void> {
        if (documentId !== null && !isDocumentId(documentId)) {
            throw new ReadingStorageError("reading.storage.invalid-input")
        }
        try {
            // A newer selection/explicit close supersedes the old deletion-recovery reference.
            if (await this.readDeletionCurrent()) await this.storage.delete(DELETION_CURRENT_KEY)
            if (documentId === null) await this.storage.delete(CURRENT_KEY)
            else await this.storage.set(CURRENT_KEY, { version: VERSION, documentId })
        } catch {
            throw new ReadingStorageError("reading.storage.write")
        }
    }

    async readDocument(documentId: string): Promise<ReadingDocumentState | null> {
        const key = documentKey(documentId)
        try {
            const value = await this.storage.get<unknown>(key)
            if (!isRecord(value) || value.version !== VERSION || value.documentId !== documentId) {
                return null
            }
            return readState(value)
        } catch {
            throw new ReadingStorageError("reading.storage.read")
        }
    }

    async writeDocument(documentId: string, state: ReadingDocumentState): Promise<void> {
        const key = documentKey(documentId)
        const validated = isRecord(state) ? readState(state) : null
        if (!validated) throw new ReadingStorageError("reading.storage.invalid-input")
        try {
            await this.storage.set(key, { version: VERSION, documentId, ...validated })
        } catch {
            throw new ReadingStorageError("reading.storage.write")
        }
    }
}
