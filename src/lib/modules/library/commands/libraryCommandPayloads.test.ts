import { describe, expect, it } from "vitest"
import {
    isLibraryNodeEditMetadataPayload,
    isLibraryNodeRelinkPayload,
    isLibraryNodeMovePayload,
} from "./libraryCommandPayloads"

describe("library command payloads", () => {
    it("accepts optional fields used by entity commands", () => {
        expect(isLibraryNodeMovePayload({ nodeId: "book", targetFolderId: null })).toBe(true)
        expect(
            isLibraryNodeEditMetadataPayload({
                nodeId: "book",
                name: "Renamed",
                author: null,
                pageNumber: 4,
            }),
        ).toBe(true)
    })

    it("rejects malformed fields without rejecting file relink sources", () => {
        expect(isLibraryNodeMovePayload({ nodeId: 1 })).toBe(false)
        expect(isLibraryNodeEditMetadataPayload({ pageNumber: "4" })).toBe(false)
        expect(isLibraryNodeRelinkPayload({ fileSource: new File(["pdf"], "book.pdf") })).toBe(true)
    })
})
