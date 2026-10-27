import { expect, it } from "vitest"
import {
    interfaceFontFamily,
    interfaceFontScale,
    isCustomFontFamily,
    isUiFontSize,
} from "./interfaceTypography"

it.each(["Arial", "Source Serif 4", "IBM Plex Sans", "ПТ Санс", "Noto-Sans", "", "A".repeat(80)])(
    "accepts a bounded installed family name: %s",
    (name) => {
        expect(isCustomFontFamily(name)).toBe(true)
    },
)

it.each([
    "A".repeat(81),
    " ",
    " Arial",
    "Arial ",
    "Arial, serif",
    'Arial"',
    "Arial'",
    "Arial; color: red",
    "var(--ui-font)",
    "url(https://example.com/font)",
    "Arial\\",
    "Arial\nMono",
    "Arial\u0000Mono",
    "<style>",
    null,
    123,
    {},
])("rejects CSS syntax, sources, controls and invalid names: %s", (name) => {
    expect(isCustomFontFamily(name)).toBe(false)
    expect(interfaceFontFamily("custom", name)).toBe('"IBM Plex Sans", sans-serif')
})

it("quotes a single family with a bundled fallback and guards size token output", () => {
    expect(interfaceFontFamily("custom", "ПТ Санс")).toBe('"ПТ Санс", "IBM Plex Sans", sans-serif')
    expect(interfaceFontFamily("custom", "")).toBe('"IBM Plex Sans", sans-serif')
    expect(interfaceFontFamily("unknown", "Arial")).toBe('"IBM Plex Sans", sans-serif')
    for (const size of [85, 100, 125, 150]) {
        expect(isUiFontSize(size)).toBe(true)
        expect(interfaceFontScale(size)).toBe(size / 100)
    }
    for (const size of [84, 151, 101, NaN, Infinity, "125", undefined]) {
        expect(isUiFontSize(size)).toBe(false)
        expect(interfaceFontScale(size)).toBe(1)
    }
})
