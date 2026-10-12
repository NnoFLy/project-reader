import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { nodes, relinkFile, complete, vfsStore } = vi.hoisted(() => {
    const nodes: Record<string, any> = {}
    const relinkFile = vi.fn()
    return {
        nodes,
        relinkFile,
        complete: vi.fn(),
        vfsStore: { nodes, relinkFile },
    }
})

vi.mock("$lib/modules/documents", () => ({ vfsStore }))
vi.mock("../state/relinkRequest.svelte", () => ({
    relinkRequest: { complete },
}))
vi.mock("$lib/paraglide/messages", () => ({
    relink_warning: ({ newName, originalName }: { newName: string; originalName: string }) =>
        `${originalName} -> ${newName}`,
    relink_failed: () => "Relink failed",
}))

import { relinkLibraryNode } from "./libraryRelinkExecution"

describe("relinkLibraryNode", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        for (const id of Object.keys(nodes)) delete nodes[id]
        vi.stubGlobal(
            "confirm",
            vi.fn(() => true),
        )
        vi.stubGlobal("alert", vi.fn())
    })

    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it("relinks and completes the pending request without a command scope", async () => {
        nodes.book = { id: "book", type: "file", name: "Book.pdf" }
        const fileSource = { name: "Book.pdf" } as File

        await expect(relinkLibraryNode("book", fileSource)).resolves.toBe(true)

        expect(relinkFile).toHaveBeenCalledWith("book", fileSource)
        expect(complete).toHaveBeenCalledOnce()
    })

    it("does not relink when a different filename is rejected", async () => {
        nodes.book = { id: "book", type: "file", name: "Original.pdf" }
        const fileSource = { name: "Replacement.pdf" } as File
        vi.mocked(confirm).mockReturnValue(false)

        await expect(relinkLibraryNode("book", fileSource)).resolves.toBe(false)

        expect(confirm).toHaveBeenCalledWith("Original.pdf -> Replacement.pdf")
        expect(relinkFile).not.toHaveBeenCalled()
        expect(complete).not.toHaveBeenCalled()
    })
})
