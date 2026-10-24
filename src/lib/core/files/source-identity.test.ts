import { expect, it } from "vitest"
import { hashDocumentSource } from "./source-identity"
import {
    createBlobDocumentSource,
    createBoundedDocumentSource,
    DOCUMENT_SOURCE_LIMITS,
} from "./file-source"

it("hashes controlled bytes rather than names or URLs", async () => {
    const source = createBlobDocumentSource({
        id: "one",
        name: "not-proof.pdf",
        blob: new Blob(["abc"]),
    })
    expect(await hashDocumentSource(source)).toBe(
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    )
    const other = createBlobDocumentSource({
        id: "two",
        name: "renamed.pdf",
        blob: new Blob(["abc"]),
    })
    expect(await hashDocumentSource(other)).toBe(
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    )
})

it("bounds identity reads to 8 MiB and refuses sources larger than 100 MiB before reading", async () => {
    const reads: number[] = []
    const source = createBoundedDocumentSource({
        id: "bounded",
        name: "bounded",
        size: DOCUMENT_SOURCE_LIMITS.maxReadBytes + 1,
        reader: {
            read: async (_offset, length) => {
                reads.push(length)
                return new ArrayBuffer(length)
            },
        },
    })
    expect(await hashDocumentSource(source)).toMatch(/^[a-f0-9]{64}$/)
    expect(reads).toEqual([8 * 1024 * 1024, 1])
    await expect(
        hashDocumentSource({ ...source, size: DOCUMENT_SOURCE_LIMITS.maxFileBytes + 1 }),
    ).rejects.toMatchObject({ name: "DocumentSourceLimitError" })
    expect(reads).toHaveLength(2)
})

it("never publishes evidence from incomplete or cancelled reads", async () => {
    const controller = new AbortController()
    const source = createBoundedDocumentSource({
        id: "short",
        name: "short",
        size: 3,
        reader: { read: async () => new ArrayBuffer(2) },
    })
    await expect(hashDocumentSource(source)).rejects.toMatchObject({
        name: "DocumentSourceLimitError",
    })
    controller.abort()
    await expect(hashDocumentSource(source, controller.signal)).rejects.toMatchObject({
        name: "AbortError",
    })
})
