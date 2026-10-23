/** Retained evidence for later comparison, never a claim that a recovered anchor matches. */
export interface ReadingAssociation {
    /** Lowercase SHA-256 of source bytes, if available. Never a URL or transient generation. */
    readonly contentHash: string | null
    readonly verification: "unverified"
}

interface ReadingAnnotationBase {
    readonly id: string
    readonly bookId: string
    readonly pageNumber: number
    readonly createdAt: number
    readonly association: ReadingAssociation
}

export interface ReadingNote extends ReadingAnnotationBase {
    readonly start: number
    readonly end: number
    readonly text: string
    readonly noteContent: string
    readonly color: "yellow" | "green" | "blue" | "pink" | "purple"
}

/** Unfinished work, never counted as a saved note. ID is retained on explicit save. */
export type ReadingDraft = ReadingNote

export type ReadingNoteInput = Omit<ReadingNote, "id" | "bookId" | "createdAt">

export interface ReadingBookmark extends ReadingAnnotationBase {
    readonly name: string
}

export type ReadingBookmarkInput = Omit<ReadingBookmark, "id" | "bookId" | "createdAt">

export interface ReadingAnnotations {
    readonly notes: readonly ReadingNote[]
    readonly bookmarks: readonly ReadingBookmark[]
}

export interface ReadingRecords extends ReadingAnnotations {
    readonly drafts: readonly ReadingDraft[]
}

export function isAnnotationId(value: unknown): value is string {
    return typeof value === "string" && /^[a-zA-Z0-9_-]{1,128}$/.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isInteger(value: unknown, min: number, max: number): value is number {
    return typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max
}

function readBase(
    value: Record<string, unknown>,
    documentId: string,
): ReadingAnnotationBase | null {
    const { id, bookId, pageNumber, createdAt, association } = value
    if (
        !isAnnotationId(id) ||
        bookId !== documentId ||
        !isInteger(pageNumber, 1, 10_000_000) ||
        !isInteger(createdAt, 0, 8_640_000_000_000_000) ||
        !isRecord(association) ||
        association.verification !== "unverified" ||
        (association.contentHash !== null &&
            (typeof association.contentHash !== "string" ||
                !/^[a-f0-9]{64}$/.test(association.contentHash)))
    )
        return null
    return {
        id,
        bookId: documentId,
        pageNumber,
        createdAt,
        association: Object.freeze({
            contentHash: association.contentHash,
            verification: "unverified",
        }),
    }
}

export function readNote(value: unknown, documentId: string): ReadingNote | null {
    if (!isRecord(value)) return null
    const base = readBase(value, documentId)
    const { start, end, text, noteContent, color } = value
    if (
        !base ||
        !isInteger(start, 0, 100_000_000) ||
        !isInteger(end, start, 100_000_000) ||
        typeof text !== "string" ||
        text.length > 100_000 ||
        typeof noteContent !== "string" ||
        noteContent.length > 1_000_000 ||
        (color !== "yellow" &&
            color !== "green" &&
            color !== "blue" &&
            color !== "pink" &&
            color !== "purple")
    )
        return null
    return Object.freeze({ ...base, start, end, text, noteContent, color })
}

export function readBookmark(value: unknown, documentId: string): ReadingBookmark | null {
    if (!isRecord(value)) return null
    const base = readBase(value, documentId)
    if (!base || typeof value.name !== "string" || value.name.length > 10_000) return null
    return Object.freeze({ ...base, name: value.name })
}

export function freezeAnnotations(
    notes: readonly ReadingNote[],
    bookmarks: readonly ReadingBookmark[] = [],
    drafts: readonly ReadingDraft[] = [],
): ReadingRecords {
    return Object.freeze({
        notes: Object.freeze([...notes]),
        bookmarks: Object.freeze([...bookmarks]),
        drafts: Object.freeze([...drafts]),
    })
}
