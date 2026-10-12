import { isSerializablePayload } from "./serializable"

export interface ViewerOpenPayload {
    bookId?: string
}

export interface ViewerPageGoToPayload {
    page?: number
    isJump?: boolean
}

export interface ViewerScrollPayload {
    direction: "up" | "down"
    repeated: boolean
}

export interface ViewerSearchPayload {
    query?: string
    matchIndex?: number
}

export interface ViewerBookmarkOpenPayload {
    bookmarkId?: string
}

export interface ViewerBookmarkAddPayload {
    page?: number
    name?: string
}

export interface ViewerBookmarkEditPayload {
    bookmarkId?: string
    name?: string
}

export interface ViewerBookmarkDeletePayload {
    bookmarkId?: string
    confirmed?: boolean
}

export interface ViewerNoteEditPayload {
    noteId?: string
    x?: number
    y?: number
}

export interface ViewerNoteDeletePayload {
    noteId?: string
    confirmed?: boolean
}

export type ViewerCommandPayloads = {
    "viewer.open": ViewerOpenPayload | undefined
    "viewer.page.go-to": ViewerPageGoToPayload | undefined
    "viewer.scroll.step": ViewerScrollPayload | undefined
    "viewer.scroll.half-page": ViewerScrollPayload | undefined
    "viewer.search": ViewerSearchPayload | undefined
    "viewer.bookmark.open": ViewerBookmarkOpenPayload | undefined
    "viewer.bookmark.add": ViewerBookmarkAddPayload | undefined
    "viewer.bookmark.edit": ViewerBookmarkEditPayload | undefined
    "viewer.bookmark.delete": ViewerBookmarkDeletePayload | undefined
    "viewer.note.add": undefined
    "viewer.note.edit": ViewerNoteEditPayload | undefined
    "viewer.note.save": undefined
    "viewer.note.delete": ViewerNoteDeletePayload | undefined
}

export type ViewerPayload<K extends keyof ViewerCommandPayloads> = ViewerCommandPayloads[K]

function isObjectPayload(value: unknown): value is Record<string, unknown> {
    return (
        isSerializablePayload(value) &&
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value)
    )
}

export function isViewerOpenPayload(value: unknown): value is ViewerPayload<"viewer.open"> {
    return (
        value === undefined ||
        (isObjectPayload(value) && (value.bookId === undefined || typeof value.bookId === "string"))
    )
}

export function isViewerPageGoToPayload(
    value: unknown,
): value is ViewerPayload<"viewer.page.go-to"> {
    return (
        value === undefined ||
        (isObjectPayload(value) &&
            (value.page === undefined || typeof value.page === "number") &&
            (value.isJump === undefined || typeof value.isJump === "boolean"))
    )
}

export function isViewerScrollPayload(value: unknown): value is ViewerScrollPayload {
    return (
        isObjectPayload(value) &&
        (value.direction === "up" || value.direction === "down") &&
        typeof value.repeated === "boolean"
    )
}

export function isViewerSearchPayload(value: unknown): value is ViewerPayload<"viewer.search"> {
    return (
        value === undefined ||
        (isObjectPayload(value) &&
            (value.query === undefined || typeof value.query === "string") &&
            (value.matchIndex === undefined || typeof value.matchIndex === "number"))
    )
}

export function isViewerBookmarkOpenPayload(
    value: unknown,
): value is ViewerPayload<"viewer.bookmark.open"> {
    return (
        value === undefined ||
        (isObjectPayload(value) &&
            (value.bookmarkId === undefined || typeof value.bookmarkId === "string"))
    )
}

export function isViewerBookmarkAddPayload(
    value: unknown,
): value is ViewerPayload<"viewer.bookmark.add"> {
    return (
        value === undefined ||
        (isObjectPayload(value) &&
            (value.page === undefined || typeof value.page === "number") &&
            (value.name === undefined || typeof value.name === "string"))
    )
}

export function isViewerBookmarkEditPayload(
    value: unknown,
): value is ViewerPayload<"viewer.bookmark.edit"> {
    return (
        value === undefined ||
        (isObjectPayload(value) &&
            (value.bookmarkId === undefined || typeof value.bookmarkId === "string") &&
            (value.name === undefined || typeof value.name === "string"))
    )
}

export function isViewerBookmarkDeletePayload(
    value: unknown,
): value is ViewerPayload<"viewer.bookmark.delete"> {
    return (
        value === undefined ||
        (isObjectPayload(value) &&
            (value.bookmarkId === undefined || typeof value.bookmarkId === "string") &&
            (value.confirmed === undefined || typeof value.confirmed === "boolean"))
    )
}

export function isViewerNoteEditPayload(
    value: unknown,
): value is ViewerPayload<"viewer.note.edit"> {
    return (
        value === undefined ||
        (isObjectPayload(value) &&
            (value.noteId === undefined || typeof value.noteId === "string") &&
            (value.x === undefined || typeof value.x === "number") &&
            (value.y === undefined || typeof value.y === "number"))
    )
}

export function isViewerNoteDeletePayload(
    value: unknown,
): value is ViewerPayload<"viewer.note.delete"> {
    return (
        value === undefined ||
        (isObjectPayload(value) &&
            (value.noteId === undefined || typeof value.noteId === "string") &&
            (value.confirmed === undefined || typeof value.confirmed === "boolean"))
    )
}
