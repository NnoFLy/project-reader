import { describe, expect, it, vi } from "vitest"
import {
    createBoundedDocumentSource,
    DocumentSourceClosedError,
    DocumentSourceLimitError,
} from "./file-source"

function sourceOf(
    bytes: number,
    maxReadBytes = 4,
): {
    source: ReturnType<typeof createBoundedDocumentSource>
    reads: Array<[number, number]>
    close: ReturnType<typeof vi.fn>
} {
    const value = new Uint8Array(bytes).map((_, index) => index)
    const reads: Array<[number, number]> = []
    const close = vi.fn(async () => undefined)
    const source = createBoundedDocumentSource({
        id: "file",
        name: "file.bin",
        size: bytes,
        maxReadBytes,
        reader: {
            read: async (offset, length) => {
                reads.push([offset, length])
                return value.slice(offset, offset + length).buffer
            },
            close,
        },
    })
    return { source, reads, close }
}

describe("bounded document sources", () => {
    it("defaults to the remaining bytes and rejects oversized reads", async () => {
        const { source, reads } = sourceOf(6, 4)
        expect(new Uint8Array(await source.read(2))).toEqual(new Uint8Array([2, 3, 4, 5]))
        expect(reads).toEqual([[2, 4]])
        await expect(source.read(0, 5)).rejects.toBeInstanceOf(DocumentSourceLimitError)
    })

    it("stops before storage access when cancelled", async () => {
        const { source, reads } = sourceOf(6)
        const controller = new AbortController()
        controller.abort()
        await expect(source.read(0, 1, controller.signal)).rejects.toMatchObject({
            name: "AbortError",
        })
        expect(reads).toHaveLength(0)
    })

    it("closes its reader exactly once and rejects later reads", async () => {
        const { source, close } = sourceOf(1)
        await source.close?.()
        await source.close?.()
        expect(close).toHaveBeenCalledOnce()
        await expect(source.read()).rejects.toBeInstanceOf(DocumentSourceClosedError)
    })
})
