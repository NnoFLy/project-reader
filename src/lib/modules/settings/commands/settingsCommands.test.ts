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

    it("applies an explicit language through the host command payload path", async () => {
        const original = settingsStore.language
        await settingsCommands["settings.language"].run({ value: original === "en" ? "ru" : "en" })
        expect(settingsStore.language).not.toBe(original)
        await settingsCommands["settings.language"].run({ value: original })
        expect(settingsStore.language).toBe(original)
    })

    it("applies an explicit theme through the host command payload path", async () => {
        const original = settingsStore.theme
        await settingsCommands["settings.theme"].run({ value: "dark" })
        expect(settingsStore.theme).toBe("dark")
        await settingsCommands["settings.theme"].run({ value: original })
        expect(settingsStore.theme).toBe(original)
    })

    it("does not cycle settings for invalid values or an unavailable Prompt", async () => {
        const originalTheme = settingsStore.theme
        const originalLanguage = settingsStore.language
        await settingsCommands["settings.theme"].run({ value: "invalid" })
        await settingsCommands["settings.language"].run({ value: "invalid" })
        await settingsCommands["settings.theme"].run(undefined)
        await settingsCommands["settings.language"].run(undefined)
        expect(settingsStore.theme).toBe(originalTheme)
        expect(settingsStore.language).toBe(originalLanguage)
    })
})
