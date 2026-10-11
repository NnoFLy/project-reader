import type { DocumentSource } from "$lib/document-model"

export const DOCUMENT_SOURCE_LIMITS = {
    /** A single adapter read is bounded to avoid accidental whole-file allocations. */
    maxReadBytes: 8 * 1024 * 1024,
    maxFileBytes: 100 * 1024 * 1024,
} as const

export class DocumentSourceLimitError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "DocumentSourceLimitError"
    }
}

export class DocumentSourceClosedError extends Error {
    constructor() {
        super("Document source is closed")
        this.name = "DocumentSourceClosedError"
    }
}

export function throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return
    throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException("The operation was aborted", "AbortError")
}

export interface DocumentSourceReader {
    read(offset: number, length: number, signal?: AbortSignal): Promise<ArrayBuffer>
    close?(): Promise<void>
}

export interface BoundedDocumentSourceOptions {
    readonly id: string
    readonly name: string
    readonly size: number
    readonly mimeType?: string
    readonly reader: DocumentSourceReader
    readonly maxReadBytes?: number
    readonly maxFileBytes?: number
}

/**
 * Wraps a file reader with the limits and lifecycle expected by adapters.
 * Offset and length are validated before the underlying storage is touched.
 */
export function createBoundedDocumentSource(options: BoundedDocumentSourceOptions): DocumentSource {
    const maxReadBytes = options.maxReadBytes ?? DOCUMENT_SOURCE_LIMITS.maxReadBytes
    const maxFileBytes = options.maxFileBytes ?? DOCUMENT_SOURCE_LIMITS.maxFileBytes
    if (!Number.isSafeInteger(options.size) || options.size < 0) {
        throw new DocumentSourceLimitError(
            "Document source size must be a non-negative safe integer",
        )
    }
    if (options.size > maxFileBytes) {
        throw new DocumentSourceLimitError(`Document source exceeds the ${maxFileBytes} byte limit`)
    }
    if (!Number.isSafeInteger(maxReadBytes) || maxReadBytes <= 0) {
        throw new DocumentSourceLimitError("Document source read limit must be positive")
    }

    let closed = false
    const source: DocumentSource = {
        id: options.id,
        name: options.name,
        size: options.size,
        mimeType: options.mimeType,
        async read(offset = 0, length = Math.min(maxReadBytes, options.size - offset), signal) {
            if (closed) throw new DocumentSourceClosedError()
            throwIfAborted(signal)
            if (!Number.isSafeInteger(offset) || offset < 0 || offset > options.size) {
                throw new DocumentSourceLimitError("Document source offset is outside the file")
            }
            if (!Number.isSafeInteger(length) || length < 0 || length > maxReadBytes) {
                throw new DocumentSourceLimitError(
                    `Document source reads are limited to ${maxReadBytes} bytes`,
                )
            }
            if (offset + length > options.size) {
                throw new DocumentSourceLimitError("Document source read exceeds the file size")
            }
            const result = await options.reader.read(offset, length, signal)
            throwIfAborted(signal)
            if (result.byteLength > length) {
                throw new DocumentSourceLimitError("File reader returned more bytes than requested")
            }
            return result
        },
        async close() {
            if (closed) return
            closed = true
            await options.reader.close?.()
        },
    }
    return source
}

export function createBlobDocumentSource(options: {
    readonly id: string
    readonly name: string
    readonly blob: Blob
    readonly mimeType?: string
    readonly maxReadBytes?: number
    readonly maxFileBytes?: number
}): DocumentSource {
    return createBoundedDocumentSource({
        id: options.id,
        name: options.name,
        size: options.blob.size,
        mimeType: options.mimeType ?? (options.blob.type || undefined),
        maxReadBytes: options.maxReadBytes,
        maxFileBytes: options.maxFileBytes,
        reader: {
            read: async (offset, length, signal) => {
                throwIfAborted(signal)
                const value = await options.blob.slice(offset, offset + length).arrayBuffer()
                throwIfAborted(signal)
                return value
            },
        },
    })
}
