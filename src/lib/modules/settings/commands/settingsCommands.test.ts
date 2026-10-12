import { describe, expect, it, vi } from "vitest"

vi.mock("$app/state", () => ({
    page: { url: new URL("https://example.test/") },
}))
import { CONSTANTS, settingsStore } from "../state/settingsStore.svelte"
import { settingsCommands } from "./settingsCommands"

describe("settings commands", () => {
    it("uses typed zoom commands for viewer controls and shortcuts", () => {
        const originalScale = settingsStore.scale
        settingsStore.scale = 1

        settingsCommands["settings.zoom.in"].run(undefined)
        expect(settingsStore.scale).toBeGreaterThan(1)
        settingsCommands["settings.zoom.out"].run(undefined)
        expect(settingsStore.scale).toBe(1)
        settingsCommands["settings.zoom.in"].run({ value: 1.75 })
        expect(settingsStore.scale).toBe(1.75)
        settingsStore.scale = originalScale
    })

    it("uses typed quality commands for viewer controls", () => {
        const originalQuality = settingsStore.quality
        settingsStore.quality = CONSTANTS.minQuality

        settingsCommands["settings.quality.in"].run(undefined)
        expect(settingsStore.quality).toBe(CONSTANTS.minQuality + 1)
        settingsCommands["settings.quality.out"].run(undefined)
        expect(settingsStore.quality).toBe(CONSTANTS.minQuality)
        settingsCommands["settings.quality.in"].run({ value: CONSTANTS.maxQuality + 1 })
        expect(settingsStore.quality).toBe(CONSTANTS.maxQuality)
        settingsCommands["settings.quality.in"].run({ value: 2.5 })
        expect(settingsStore.quality).toBe(3)
        settingsCommands["settings.quality.in"].run({ value: Number.NaN })
        expect(settingsStore.quality).toBe(3)
        settingsStore.quality = originalQuality
    })

    it("cycles language through the host command payload path", () => {
        const original = settingsStore.language
        settingsCommands["settings.language"].run(undefined)
        expect(settingsStore.language).toBe(original === "en" ? "ru" : "en")
        settingsCommands["settings.language"].run({ value: original })
        expect(settingsStore.language).toBe(original)
    })

    it("cycles theme through the host command payload path", () => {
        const original = settingsStore.theme
        settingsCommands["settings.theme"].run(undefined)
        expect(settingsStore.theme).not.toBe(original)
        settingsCommands["settings.theme"].run({ value: original })
        expect(settingsStore.theme).toBe(original)
    })
})
