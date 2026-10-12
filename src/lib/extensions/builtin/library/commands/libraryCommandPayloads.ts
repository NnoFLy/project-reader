export type LibraryBookReadStateTogglePayload = {
    nodeId?: string
    markAsRead?: boolean
}

export type LibrarySelectionTogglePayload = {
    nodeId?: string
}

export type LibraryNodeMovePayload = {
    nodeId?: string
    targetFolderId?: string | null
}

export type LibraryNodePinTogglePayload = {
    nodeId?: string
    isPinned?: boolean
}

export type LibraryNodeDeletePayload = {
    nodeId?: string
    confirmed?: boolean
}

export type LibraryNodeRenamePayload = {
    nodeId?: string
    name?: string
}

export type LibraryNodeEditMetadataPayload = {
    nodeId?: string
    name?: string
    author?: string | null
    pageNumber?: number
}

export type LibraryFileSource = File | FileSystemFileHandle

export type LibraryNodeRelinkPayload = {
    nodeId?: string
    fileSource?: LibraryFileSource
}

export type LibraryCardOpenPayload = {
    nodeId?: string
}

export type LibraryCardCommandPayload<T extends { nodeId?: string }> = T & {
    nodeId: string
}

type PayloadRecord = Record<string, unknown>

type PayloadValue = (value: unknown) => boolean

function isPayloadRecord(payload: unknown): payload is PayloadRecord {
    return typeof payload === "object" && payload !== null
}

function isOptional(payload: PayloadRecord, key: string, validate: PayloadValue): boolean {
    return !(key in payload) || validate(payload[key])
}

const isOptionalString: PayloadValue = (value) => value === undefined || typeof value === "string"
const isOptionalBoolean: PayloadValue = (value) => value === undefined || typeof value === "boolean"
const isOptionalNumber: PayloadValue = (value) => value === undefined || typeof value === "number"
const isOptionalStringOrNull: PayloadValue = (value) =>
    value === undefined || value === null || typeof value === "string"

function isFileSource(value: unknown): value is LibraryFileSource {
    if (typeof File !== "undefined" && value instanceof File) return true
    if (!isPayloadRecord(value)) return false
    return typeof value.name === "string" && typeof value.getFile === "function"
}

function isOptionalFileSource(value: unknown): boolean {
    return value === undefined || isFileSource(value)
}

export function isLibraryBookReadStateTogglePayload(
    payload: unknown,
): payload is LibraryBookReadStateTogglePayload | undefined {
    return (
        payload === undefined ||
        (isPayloadRecord(payload) &&
            isOptional(payload, "nodeId", isOptionalString) &&
            isOptional(payload, "markAsRead", isOptionalBoolean))
    )
}

export function isLibrarySelectionTogglePayload(
    payload: unknown,
): payload is LibrarySelectionTogglePayload | undefined {
    return (
        payload === undefined ||
        (isPayloadRecord(payload) && isOptional(payload, "nodeId", isOptionalString))
    )
}

export function isLibraryNodeMovePayload(
    payload: unknown,
): payload is LibraryNodeMovePayload | undefined {
    return (
        payload === undefined ||
        (isPayloadRecord(payload) &&
            isOptional(payload, "nodeId", isOptionalString) &&
            isOptional(payload, "targetFolderId", isOptionalStringOrNull))
    )
}

export function isLibraryNodePinTogglePayload(
    payload: unknown,
): payload is LibraryNodePinTogglePayload | undefined {
    return (
        payload === undefined ||
        (isPayloadRecord(payload) &&
            isOptional(payload, "nodeId", isOptionalString) &&
            isOptional(payload, "isPinned", isOptionalBoolean))
    )
}

export function isLibraryNodeDeletePayload(
    payload: unknown,
): payload is LibraryNodeDeletePayload | undefined {
    return (
        payload === undefined ||
        (isPayloadRecord(payload) &&
            isOptional(payload, "nodeId", isOptionalString) &&
            isOptional(payload, "confirmed", isOptionalBoolean))
    )
}

export function isLibraryNodeRenamePayload(
    payload: unknown,
): payload is LibraryNodeRenamePayload | undefined {
    return (
        payload === undefined ||
        (isPayloadRecord(payload) &&
            isOptional(payload, "nodeId", isOptionalString) &&
            isOptional(payload, "name", isOptionalString))
    )
}

export function isLibraryNodeEditMetadataPayload(
    payload: unknown,
): payload is LibraryNodeEditMetadataPayload | undefined {
    return (
        payload === undefined ||
        (isPayloadRecord(payload) &&
            isOptional(payload, "nodeId", isOptionalString) &&
            isOptional(payload, "name", isOptionalString) &&
            isOptional(payload, "author", isOptionalStringOrNull) &&
            isOptional(payload, "pageNumber", isOptionalNumber))
    )
}

export function isLibraryNodeRelinkPayload(
    payload: unknown,
): payload is LibraryNodeRelinkPayload | undefined {
    return (
        payload === undefined ||
        (isPayloadRecord(payload) &&
            isOptional(payload, "nodeId", isOptionalString) &&
            isOptional(payload, "fileSource", isOptionalFileSource))
    )
}

export function isLibraryCardOpenPayload(
    payload: unknown,
): payload is LibraryCardOpenPayload | undefined {
    return (
        payload === undefined ||
        (isPayloadRecord(payload) && isOptional(payload, "nodeId", isOptionalString))
    )
}
