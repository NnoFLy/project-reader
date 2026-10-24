import type { DocumentSource } from "$lib/document-model"
import { DOCUMENT_SOURCE_LIMITS, DocumentSourceLimitError, throwIfAborted } from "./file-source"

/** Byte evidence only; bounded reads also apply to identity work, not just format adapters. */
export async function hashDocumentSource(
    source: DocumentSource,
    signal?: AbortSignal,
): Promise<string> {
    if (
        !Number.isSafeInteger(source.size) ||
        source.size < 0 ||
        source.size > DOCUMENT_SOURCE_LIMITS.maxFileBytes
    )
        throw new DocumentSourceLimitError("Document source exceeds the identity limit")
    throwIfAborted(signal)
    const bytes = new Uint8Array(source.size)
    for (let offset = 0; offset < source.size; offset += DOCUMENT_SOURCE_LIMITS.maxReadBytes) {
        const length = Math.min(DOCUMENT_SOURCE_LIMITS.maxReadBytes, source.size - offset)
        const chunk = await source.read(offset, length, signal)
        throwIfAborted(signal)
        if (chunk.byteLength !== length)
            throw new DocumentSourceLimitError("Incomplete identity read")
        bytes.set(new Uint8Array(chunk), offset)
    }
    const digest = await crypto.subtle.digest("SHA-256", bytes)
    throwIfAborted(signal)
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}
