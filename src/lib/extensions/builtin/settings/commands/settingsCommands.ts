import { page } from "$app/state"
import { switchLanguage } from "../language/language"
import { getLanguageName } from "../language/locale"
import { CONSTANTS, settingsStore, type Layout, type Theme } from "../state/settingsStore.svelte"
import { stepAndClampScale } from "../utils/zoom"
import { commandsStore } from "$lib/modules/commands"
import { defineCommands } from "$lib/modules/commands"
import { promptStore, type PromptItem } from "$lib/modules/prompt"
import * as m from "$lib/paraglide/messages"
import { getLocale } from "$lib/paraglide/runtime"
import type { Locale } from "$lib/modules/commands"

const themeItems = (): PromptItem<Theme>[] => [
    {
        id: "theme-light",
        label: m.light(),
        englishLabel: m.light({}, { locale: "en" }),
        description: settingsStore.theme === "light" ? "✓" : undefined,
        category: "settings",
        value: "light",
    },
    {
        id: "theme-dark",
        label: m.dark(),
        englishLabel: m.dark({}, { locale: "en" }),
        description: settingsStore.theme === "dark" ? "✓" : undefined,
        category: "settings",
        value: "dark",
    },
    {
        id: "theme-system",
        label: m.system(),
        englishLabel: m.system({}, { locale: "en" }),
        description: settingsStore.theme === "system" ? "✓" : undefined,
        category: "settings",
        value: "system",
    },
]

const layoutItems = (): PromptItem<Layout>[] => [
    {
        id: "layout-single",
        label: m.single_page(),
        englishLabel: m.single_page({}, { locale: "en" }),
        description: settingsStore.layout === "single" ? "✓" : undefined,
        category: "settings",
        value: "single",
    },
    {
        id: "layout-split",
        label: m.split_pages(),
        englishLabel: m.split_pages({}, { locale: "en" }),
        description: settingsStore.layout === "split" ? "✓" : undefined,
        category: "settings",
        value: "split",
    },
    {
        id: "layout-scroll",
        label: m.scroll_pages(),
        englishLabel: m.scroll_pages({}, { locale: "en" }),
        description: settingsStore.layout === "scroll" ? "✓" : undefined,
        category: "settings",
        value: "scroll",
    },
]

const languageItems = (): PromptItem<Locale>[] =>
    (["ru", "en"] as const).map((locale) => ({
        id: `language-${locale}`,
        label: getLanguageName(locale),
        englishLabel: getLanguageName(locale, "en"),
        description: getLocale() === locale ? "✓" : undefined,
        category: "settings",
        value: locale,
    }))

function updateQuality(value: number) {
    if (!Number.isFinite(value)) return
    settingsStore.quality = Math.min(
        Math.max(Math.round(value), CONSTANTS.minQuality),
        CONSTANTS.maxQuality,
    )
}

export const settingsCommands = defineCommands({
    "settings.theme": {
        id: "settings.theme",
        keymap: "shift+t",
        label: () => m.keymap_change_theme(),
        englishLabel: () => m.keymap_change_theme({}, { locale: "en" }),
        category: "settings",
        subtitle: () => `${m.theme()}: ${settingsStore.theme}`,
        run: async ({ value } = {}) => {
            if (value !== undefined) {
                settingsStore.theme = value
                return
            }
            const selected = await promptStore.choose({
                id: "settings.theme",
                placeholder: m.select_theme(),
                items: themeItems,
            })
            if (selected !== undefined) {
                await commandsStore.execute("settings.theme", { value: selected })
            }
        },
    },
    "settings.layout": {
        id: "settings.layout",
        label: () => m.keymap_toggle_layouts(),
        englishLabel: () => m.keymap_toggle_layouts({}, { locale: "en" }),
        category: "settings",
        subtitle: () => `${m.layout()}: ${settingsStore.layout}`,
        run: async ({ value } = {}) => {
            if (value !== undefined) {
                settingsStore.layout = value
                return
            }
            const selected = await promptStore.choose({
                id: "settings.layout",
                placeholder: m.select_layout(),
                items: layoutItems,
            })
            if (selected !== undefined) {
                await commandsStore.execute("settings.layout", { value: selected })
            }
        },
    },
    "settings.language": {
        id: "settings.language",
        label: () => m.keymap_change_language(),
        englishLabel: () => m.keymap_change_language({}, { locale: "en" }),
        category: "settings",
        subtitle: () => getLanguageName(getLocale()),
        run: async ({ value } = {}) => {
            if (value !== undefined) {
                switchLanguage(value, page.url)
                return
            }
            const selected = await promptStore.choose({
                id: "settings.language",
                placeholder: m.select_language(),
                items: languageItems,
            })
            if (selected !== undefined) {
                await commandsStore.execute("settings.language", { value: selected })
            }
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
            settingsStore.scale =
                payload?.value === undefined
                    ? stepAndClampScale(
                          settingsStore.scale,
                          1,
                          CONSTANTS.minScale,
                          CONSTANTS.maxScale,
                      )
                    : Math.min(Math.max(payload.value, CONSTANTS.minScale), CONSTANTS.maxScale)
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
            settingsStore.scale =
                payload?.value === undefined
                    ? stepAndClampScale(
                          settingsStore.scale,
                          -1,
                          CONSTANTS.minScale,
                          CONSTANTS.maxScale,
                      )
                    : Math.min(Math.max(payload.value, CONSTANTS.minScale), CONSTANTS.maxScale)
        },
    },
    "settings.quality.in": {
        id: "settings.quality.in",
        label: () => m.quality_up(),
        englishLabel: () => m.quality_up({}, { locale: "en" }),
        category: "settings",
        subtitle: () => `${m.quality()}: ${settingsStore.quality}`,
        run: (payload) => {
            updateQuality(payload?.value ?? settingsStore.quality + 1)
        },
    },
    "settings.quality.out": {
        id: "settings.quality.out",
        label: () => m.quality_down(),
        englishLabel: () => m.quality_down({}, { locale: "en" }),
        category: "settings",
        subtitle: () => `${m.quality()}: ${settingsStore.quality}`,
        run: (payload) => {
            updateQuality(payload?.value ?? settingsStore.quality - 1)
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
})
