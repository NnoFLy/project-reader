import { describe, expect, it } from "vitest"
import { getAdjacentSidebarTab, resolveSidebarTabMove } from "./sidebarTabs"

describe("left sidebar tab order", () => {
    it("moves forward and backward without wrapping", () => {
        expect(getAdjacentSidebarTab("outline", "next")?.id).toBe("notes")
        expect(getAdjacentSidebarTab("notes", "next")?.id).toBe("bookmarks")
        expect(getAdjacentSidebarTab("bookmarks", "previous")?.id).toBe("notes")
        expect(getAdjacentSidebarTab("notes", "previous")?.id).toBe("outline")
        expect(getAdjacentSidebarTab("outline", "previous")).toBeUndefined()
        expect(getAdjacentSidebarTab("bookmarks", "next")).toBeUndefined()
    })

    it("keeps the destination command paired with its tab", () => {
        expect(getAdjacentSidebarTab("outline", "next")?.commandId).toBe(
            "viewer.sidebar.notes.toggle",
        )
    })

    it("captures the destination and does not toggle it off if it became active", () => {
        let activeTab: "outline" | "notes" | "bookmarks" = "outline"
        const executed: string[] = []
        const operation = resolveSidebarTabMove(
            activeTab,
            "next",
            () => activeTab,
            (commandId) => executed.push(commandId),
        )

        activeTab = "notes"
        operation?.()

        expect(executed).toEqual([])
    })

    it("executes the captured command when the destination is still inactive", () => {
        let activeTab: "outline" | "notes" | "bookmarks" = "outline"
        const executed: string[] = []
        const operation = resolveSidebarTabMove(
            activeTab,
            "next",
            () => activeTab,
            (commandId) => executed.push(commandId),
        )

        activeTab = "bookmarks"
        operation?.()

        expect(executed).toEqual(["viewer.sidebar.notes.toggle"])
    })
})
