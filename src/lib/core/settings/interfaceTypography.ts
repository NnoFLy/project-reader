import type { UiFontPreset } from "$lib/extension-api"
export type { UiFontPreset } from "$lib/extension-api"

const UI_FONT_PRESETS: readonly UiFontPreset[] = [
    "plex-sans",
    "system",
    "source-serif",
    "plex-mono",
    "custom",
]

export const UI_FONT_SIZE = { min: 85, max: 150, step: 5, default: 100 } as const
export const CUSTOM_FONT_MAX_LENGTH = 80
const DEFAULT_FONT_FAMILY = '"IBM Plex Sans", sans-serif'

export function isUiFontPreset(value: unknown): value is UiFontPreset {
    return UI_FONT_PRESETS.some((preset) => preset === value)
}

export function isUiFontSize(value: unknown): value is number {
    return (
        typeof value === "number" &&
        Number.isInteger(value) &&
        value >= UI_FONT_SIZE.min &&
        value <= UI_FONT_SIZE.max &&
        value % UI_FONT_SIZE.step === 0
    )
}

// One installed family name, never a CSS expression, family list, URL or font source.
// Empty names intentionally fall back to the bundled default, including after reset.
export function isCustomFontFamily(value: unknown): value is string {
    return (
        typeof value === "string" &&
        value.length <= CUSTOM_FONT_MAX_LENGTH &&
        (value === "" ||
            (value === value.trim() && /^[\p{L}\p{N}][\p{L}\p{M}\p{N} -]*$/u.test(value)))
    )
}

export function interfaceFontFamily(preset: unknown, customFamily: unknown): string {
    switch (preset) {
        case "system":
            return "system-ui, -apple-system, BlinkMacSystemFont, sans-serif"
        case "source-serif":
            return '"Source Serif 4", Georgia, serif'
        case "plex-mono":
            return '"IBM Plex Mono", ui-monospace, monospace'
        case "custom":
            if (isCustomFontFamily(customFamily) && customFamily)
                return `"${customFamily}", ${DEFAULT_FONT_FAMILY}`
    }
    return DEFAULT_FONT_FAMILY
}

export function interfaceFontScale(value: unknown): number {
    return (isUiFontSize(value) ? value : UI_FONT_SIZE.default) / 100
}
