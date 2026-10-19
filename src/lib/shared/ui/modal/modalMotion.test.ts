import { describe, expect, it } from "vitest"
import { shouldEnableModalPresentationMotion } from "./modalMotion"

describe("draggable modal motion policy", () => {
    it("keeps movement-critical presentation motion when app animations are off", () => {
        expect(
            shouldEnableModalPresentationMotion({
                appMotionEnabled: false,
                movementCritical: true,
            }),
        ).toBe(true)
    })

    it("does not re-enable decorative modal motion", () => {
        expect(
            shouldEnableModalPresentationMotion({
                appMotionEnabled: false,
                movementCritical: false,
            }),
        ).toBe(false)
    })

    it("enables decorative modal motion when app animations are on", () => {
        expect(
            shouldEnableModalPresentationMotion({
                appMotionEnabled: true,
                movementCritical: false,
            }),
        ).toBe(true)
    })
})
