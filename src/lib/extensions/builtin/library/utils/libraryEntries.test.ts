import { describe, expect, it } from "vitest"
import type { FileNode, ImportJob } from "$lib/modules/documents"
import { mergeLibraryEntries } from "./libraryEntries"

const node = (id: string, parentId: string | null): FileNode => ({
    id,
    name: `${id}.pdf`,
    type: "file",
    parentId,
    size: 1,
    createdAt: 1,
    updatedAt: 1,
    isPinned: false,
    metadata: { pageNumber: 1 },
})

const job = (id: string, parentId: string | null): ImportJob => ({
    id,
    name: `${id}.pdf`,
    parentId,
    stage: "metadata",
})

describe("mergeLibraryEntries", () => {
    it("registers every skeleton in batch order", () => {
        const entries = mergeLibraryEntries(
            [],
            [job("a", null), job("b", null), job("c", null)],
            null,
        )
        expect(entries.map(({ id }) => id)).toEqual(["a", "b", "c"])
        expect(entries.every(({ interactive }) => !interactive)).toBe(true)
    })

    it("keeps persisted node order and appends current-folder jobs in batch order", () => {
        const entries = mergeLibraryEntries(
            [node("pinned-folder", null), node("pinned-file", null), node("other", null)],
            [job("first", null), job("second", null), job("nested", "folder-1")],
            null,
        )
        expect(entries.map(({ id }) => id)).toEqual([
            "pinned-folder",
            "pinned-file",
            "other",
            "first",
            "second",
        ])
        expect(entries.slice(0, 3).every(({ interactive }) => interactive)).toBe(true)
        expect(entries.slice(3).every(({ interactive }) => !interactive)).toBe(true)
    })

    it("does not duplicate a job after its minimal node appears", () => {
        const entries = mergeLibraryEntries([node("a", null)], [job("a", null)], null)
        expect(entries).toHaveLength(1)
        expect(entries[0]).toMatchObject({ id: "a", interactive: false })
        expect(entries[0].node?.id).toBe("a")
    })

    it("shows only jobs captured for the current folder", () => {
        const entries = mergeLibraryEntries(
            [],
            [job("root", null), job("folder", "folder-1")],
            null,
        )
        expect(entries.map(({ id }) => id)).toEqual(["root"])
    })

    it("keeps failed jobs visible and non-interactive", () => {
        const failed = { ...job("failed", null), stage: "failed" as const }
        expect(mergeLibraryEntries([], [failed], null)[0]).toMatchObject({
            id: "failed",
            interactive: false,
            job: { stage: "failed" },
        })
    })
})
