import { afterEach, describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS, sanitizeSettings, settingsStore } from "./settingsStore.svelte"

afterEach(() => {
    settingsStore.preferPdfTitle = DEFAULT_SETTINGS.preferPdfTitle
})

describe("settings reactivity", () => {
    it("keeps the settings object stable for property-level invalidation", () => {
        const settings = settingsStore.getSettings()
        const originalScale = settingsStore.scale

        settingsStore.scale = originalScale === 1 ? 1.25 : 1

        expect(settingsStore.getSettings()).toBe(settings)
        settingsStore.scale = originalScale
    })
})

describe("interface typography preferences", () => {
    it("sanitizes persisted typography independently of PDF zoom", () => {
        expect(
            sanitizeSettings({
                uiFont: "source-serif",
                uiCustomFont: "Source Serif 4",
                uiFontSize: 150,
                scale: 2,
            }),
        ).toEqual({
            uiFont: "source-serif",
            uiCustomFont: "Source Serif 4",
            uiFontSize: 150,
            scale: 2,
        })
        expect(
            sanitizeSettings({
                uiFont: "unknown",
                uiCustomFont: "Arial; color: red",
                uiFontSize: 101,
            }),
        ).toEqual({})
        expect(sanitizeSettings({ uiFontSize: NaN })).toEqual({})
        expect(sanitizeSettings({ uiFontSize: 85, uiCustomFont: "" })).toEqual({
            uiFontSize: 85,
            uiCustomFont: "",
        })
    })
})

describe("PDF title preference", () => {
    it("defaults to enabled", () => {
        expect(DEFAULT_SETTINGS.preferPdfTitle).toBe(true)
    })

    it("accepts only boolean persisted values", () => {
        expect(sanitizeSettings({ preferPdfTitle: false }).preferPdfTitle).toBe(false)
        expect(sanitizeSettings({ preferPdfTitle: "false" }).preferPdfTitle).toBeUndefined()
        expect(sanitizeSettings({ preferPdfTitle: 0 }).preferPdfTitle).toBeUndefined()
    })

    it("switches reactively through the store", () => {
        settingsStore.preferPdfTitle = false
        expect(settingsStore.preferPdfTitle).toBe(false)
        settingsStore.preferPdfTitle = true
        expect(settingsStore.preferPdfTitle).toBe(true)
    })
})
