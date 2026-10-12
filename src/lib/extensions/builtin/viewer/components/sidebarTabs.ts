import type { SliderDirection } from "$lib/shared/ui/slider"

export type LeftSidebarTabId = "outline" | "notes" | "bookmarks"

export interface LeftSidebarTab {
    id: LeftSidebarTabId
    commandId:
        | "viewer.sidebar.outline.toggle"
        | "viewer.sidebar.notes.toggle"
        | "viewer.sidebar.bookmarks.toggle"
}

export const LEFT_SIDEBAR_TABS: readonly LeftSidebarTab[] = [
    { id: "outline", commandId: "viewer.sidebar.outline.toggle" },
    { id: "notes", commandId: "viewer.sidebar.notes.toggle" },
    { id: "bookmarks", commandId: "viewer.sidebar.bookmarks.toggle" },
]

export function getAdjacentSidebarTab(
    activeTab: LeftSidebarTabId,
    direction: SliderDirection,
): LeftSidebarTab | undefined {
    const currentIndex = LEFT_SIDEBAR_TABS.findIndex((tab) => tab.id === activeTab)
    const targetIndex = currentIndex + (direction === "next" ? 1 : -1)
    return LEFT_SIDEBAR_TABS[targetIndex]
}

export function resolveSidebarTabMove(
    activeTab: LeftSidebarTabId,
    direction: SliderDirection,
    getActiveTab: () => LeftSidebarTabId | "settings",
    execute: (commandId: LeftSidebarTab["commandId"]) => void,
): (() => void) | undefined {
    const destination = getAdjacentSidebarTab(activeTab, direction)
    if (!destination) return undefined

    return () => {
        if (getActiveTab() === destination.id) return
        execute(destination.commandId)
    }
}
