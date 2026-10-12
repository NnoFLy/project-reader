export type ViewerTapAction =
    | "sidebar-left"
    | "previous-page"
    | "toggle-toolbar"
    | "next-page"
    | "sidebar-right"

const SIDEBAR_EDGE_WIDTH = 24
const PREVIOUS_PAGE_END_RATIO = 0.35
const NEXT_PAGE_START_RATIO = 0.65

export function getViewerTapAction(clientX: number, viewportWidth: number): ViewerTapAction | null {
    if (!Number.isFinite(clientX) || !Number.isFinite(viewportWidth) || viewportWidth <= 0) {
        return null
    }

    if (clientX < SIDEBAR_EDGE_WIDTH) return "sidebar-left"
    if (clientX >= viewportWidth - SIDEBAR_EDGE_WIDTH) return "sidebar-right"

    const ratio = clientX / viewportWidth
    if (ratio < PREVIOUS_PAGE_END_RATIO) return "previous-page"
    if (ratio < NEXT_PAGE_START_RATIO) return "toggle-toolbar"
    return "next-page"
}
