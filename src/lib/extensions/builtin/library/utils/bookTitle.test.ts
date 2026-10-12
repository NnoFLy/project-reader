import { describe, expect, it } from "vitest"
import type { FileNode } from "$lib/modules/documents"
import { resolveBookTitle } from "./bookTitle"

const book: FileNode = {
    id: "book",
    name: "original-file.pdf",
    type: "file",
    parentId: null,
    size: 1,
    createdAt: 1,
    updatedAt: 1,
    isPinned: false,
    metadata: { pageNumber: 1, pdfTitle: "  Embedded title  " },
}

describe("resolveBookTitle", () => {
    it("prefers a trimmed embedded title when enabled", () => {
        expect(resolveBookTitle(book, true)).toBe("Embedded title")
    })

    it("falls back to the filename when disabled or empty", () => {
        expect(resolveBookTitle(book, false)).toBe("original-file.pdf")
        expect(
            resolveBookTitle({ ...book, metadata: { pageNumber: 1, pdfTitle: "  " } }, true),
        ).toBe("original-file.pdf")
    })
})
