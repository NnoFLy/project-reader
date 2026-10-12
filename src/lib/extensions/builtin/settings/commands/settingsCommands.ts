import { page } from "$app/state"
import type { CommandContribution } from "$lib/extension-api"
import * as m from "$lib/paraglide/messages"
import { getLocale } from "$lib/paraglide/runtime"
import { switchLanguage } from "../language/language"
import { getLanguageName } from "../language/locale"
import {
    CONSTANTS,
    settingsStore,
    type Layout,
    type Language,
    type Theme,
} from "../state/settingsStore.svelte"
import { stepAndClampScale } from "../utils/zoom"

export type SettingsCommandPayload = { readonly value?: unknown }

/** UI metadata retained for built-in surfaces; activation adapts it to the host command contract. */
export type SettingsCommand = Pick<CommandContribution, "id"> & {
    readonly label: () => string
    readonly englishLabel?: () => string
    readonly keymap?: string | readonly string[]
    readonly category: "settings"
    readonly subtitle?: () => string
    readonly run: (payload?: SettingsCommandPayload) => void | Promise<void>
}

const themeValues: readonly Theme[] = ["light", "dark", "system"]
const layoutValues: readonly Layout[] = ["single", "split", "scroll"]
const languageValues: readonly Language[] = ["ru", "en"]

function nextValue<T>(current: T, values: readonly T[]): T {
    const index = values.indexOf(current)
    return values[(index + 1) % values.length]
}

function updateQuality(value: number): void {
    if (!Number.isFinite(value)) return
    settingsStore.quality = Math.min(
        Math.max(Math.round(value), CONSTANTS.minQuality),
        CONSTANTS.maxQuality,
    )
}

export const settingsCommands = {
    "settings.theme": {
        id: "settings.theme",
        keymap: "shift+t",
        label: () => m.keymap_change_theme(),
        englishLabel: () => m.keymap_change_theme({}, { locale: "en" }),
        category: "settings",
        subtitle: () => `${m.theme()}: ${settingsStore.theme}`,
        run: (payload) => {
            const value = payload?.value
            settingsStore.theme =
                value === "light" || value === "dark" || value === "system"
                    ? value
                    : nextValue(settingsStore.theme, themeValues)
        },
    },
    "settings.layout": {
        id: "settings.layout",
        label: () => m.keymap_toggle_layouts(),
        englishLabel: () => m.keymap_toggle_layouts({}, { locale: "en" }),
        category: "settings",
        subtitle: () => `${m.layout()}: ${settingsStore.layout}`,
        run: (payload) => {
            const value = payload?.value
            settingsStore.layout =
                value === "single" || value === "split" || value === "scroll"
                    ? value
                    : nextValue(settingsStore.layout, layoutValues)
        },
    },
    "settings.language": {
        id: "settings.language",
        label: () => m.keymap_change_language(),
        englishLabel: () => m.keymap_change_language({}, { locale: "en" }),
        category: "settings",
        subtitle: () => getLanguageName(getLocale()),
        run: (payload) => {
            const value = payload?.value
            const locale =
                value === "en" || value === "ru"
                    ? value
                    : nextValue(settingsStore.language, languageValues)
            switchLanguage(locale, page.url)
        },
    },
    "settings.zoom.in": {
        id: "settings.zoom.in",
        keymap: "+",
        label: () => m.keymap_zoom_in(),
        englishLabel: () => m.keymap_zoom_in({}, { locale: "en" }),
        category: "settings",
        subtitle: () => m.scale_subtitle({ scale: Math.round(settingsStore.scale * 100) }),
        run: (payload) => {
            const value = payload?.value
            settingsStore.scale =
                typeof value === "number"
                    ? Math.min(Math.max(value, CONSTANTS.minScale), CONSTANTS.maxScale)
                    : stepAndClampScale(
                          settingsStore.scale,
                          1,
                          CONSTANTS.minScale,
                          CONSTANTS.maxScale,
                      )
        },
    },
    "settings.zoom.out": {
        id: "settings.zoom.out",
        keymap: "-",
        label: () => m.keymap_zoom_out(),
        englishLabel: () => m.keymap_zoom_out({}, { locale: "en" }),
        category: "settings",
        subtitle: () => m.scale_subtitle({ scale: Math.round(settingsStore.scale * 100) }),
        run: (payload) => {
            const value = payload?.value
            settingsStore.scale =
                typeof value === "number"
                    ? Math.min(Math.max(value, CONSTANTS.minScale), CONSTANTS.maxScale)
                    : stepAndClampScale(
                          settingsStore.scale,
                          -1,
                          CONSTANTS.minScale,
                          CONSTANTS.maxScale,
                      )
        },
    },
    "settings.quality.in": {
        id: "settings.quality.in",
        label: () => m.quality_up(),
        englishLabel: () => m.quality_up({}, { locale: "en" }),
        category: "settings",
        subtitle: () => `${m.quality()}: ${settingsStore.quality}`,
        run: (payload) => {
            updateQuality(
                typeof payload?.value === "number" ? payload.value : settingsStore.quality + 1,
            )
        },
    },
    "settings.quality.out": {
        id: "settings.quality.out",
        label: () => m.quality_down(),
        englishLabel: () => m.quality_down({}, { locale: "en" }),
        category: "settings",
        subtitle: () => `${m.quality()}: ${settingsStore.quality}`,
        run: (payload) => {
            updateQuality(
                typeof payload?.value === "number" ? payload.value : settingsStore.quality - 1,
            )
        },
    },
    "settings.animations.toggle": {
        id: "settings.animations.toggle",
        label: () => m.keymap_toggle_animations(),
        englishLabel: () => m.keymap_toggle_animations({}, { locale: "en" }),
        category: "settings",
        subtitle: () =>
            `${m.animations()}: ${settingsStore.animations ? m.animations_enabled() : m.animations_disabled()}`,
        run: () => {
            settingsStore.animations = !settingsStore.animations
        },
    },
    "settings.pdf-title.toggle": {
        id: "settings.pdf-title.toggle",
        label: () => m.prefer_pdf_title(),
        englishLabel: () => m.prefer_pdf_title({}, { locale: "en" }),
        category: "settings",
        subtitle: () =>
            settingsStore.preferPdfTitle ? m.animations_enabled() : m.animations_disabled(),
        run: () => {
            settingsStore.preferPdfTitle = !settingsStore.preferPdfTitle
        },
    },
} satisfies Record<string, SettingsCommand>
