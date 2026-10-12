import { describe, expect, it } from "vitest"
import { getViewerTapAction } from "./viewerTapNavigation"

const VIEWPORT_WIDTH = 400

describe("getViewerTapAction", () => {
    it.each([
        [0, "sidebar-left"],
        [23.99, "sidebar-left"],
        [24, "previous-page"],
        [VIEWPORT_WIDTH * 0.35 - 1, "previous-page"],
        [VIEWPORT_WIDTH * 0.35, "toggle-toolbar"],
        [VIEWPORT_WIDTH * 0.65 - 1, "toggle-toolbar"],
        [VIEWPORT_WIDTH * 0.65, "next-page"],
        [VIEWPORT_WIDTH - 24, "sidebar-right"],
        [VIEWPORT_WIDTH, "sidebar-right"],
    ] as const)("maps x=%s to %s", (clientX, expected) => {
        expect(getViewerTapAction(clientX, VIEWPORT_WIDTH)).toBe(expected)
    })

    it("does nothing for invalid viewport geometry", () => {
        expect(getViewerTapAction(100, 0)).toBeNull()
        expect(getViewerTapAction(Number.NaN, VIEWPORT_WIDTH)).toBeNull()
    })
})
