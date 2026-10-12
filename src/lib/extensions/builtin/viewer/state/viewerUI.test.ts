import { describe, expect, it } from "vitest"
import { ViewerUIController } from "./viewerUI.svelte"

describe("ViewerUIController", () => {
    it("toggles toolbar visibility", () => {
        const state = new ViewerUIController()
        expect(state.isToolbarsVisible).toBe(true)
        state.toggleToolbars()
        expect(state.isToolbarsVisible).toBe(false)
        state.toggleToolbars()
        expect(state.isToolbarsVisible).toBe(true)
    })

    it("creates independent instances", () => {
        const first = new ViewerUIController()
        const second = new ViewerUIController()
        first.toggleToolbars()
        expect(first.isToolbarsVisible).toBe(false)
        expect(second.isToolbarsVisible).toBe(true)
    })
})
