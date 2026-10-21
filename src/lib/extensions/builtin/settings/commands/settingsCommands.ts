import { page } from "$app/state"
import type { CommandContribution, HostContext, PromptRequest } from "$lib/extension-api"
import * as m from "$lib/paraglide/messages"
import { getLocale } from "$lib/paraglide/runtime"
import { switchLanguage } from "../language/language"
import { getLanguageName } from "../language/locale"
import {
    CONSTANTS,
    settingsStore,
    type SettingsStore,
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

let commandHost: HostContext | undefined
let commandLifetime = new AbortController()

export function configureSettingsCommandHost(host?: HostContext, expectedHost?: HostContext): void {
    if (expectedHost && commandHost !== expectedHost) return
    commandLifetime.abort()
    commandLifetime = new AbortController()
    commandHost = host
}

async function chooseSettingValue<T>(request: PromptRequest<T>): Promise<T | undefined> {
    const { signal } = commandLifetime
    const value = await commandHost?.prompt?.chooseValue(request, signal)
    return signal.aborted ? undefined : value
}

function nextValue<T>(current: T, values: readonly T[]): T {
    const index = values.indexOf(current)
    return values[(index + 1) % values.length]
}

function updateQuality(store: SettingsStore, value: number): void {
    if (!Number.isFinite(value)) return
    store.quality = Math.min(
        Math.max(Math.round(value), CONSTANTS.minQuality),
        CONSTANTS.maxQuality,
    )
}

/** Keep existing command IDs; an owning Viewer handles local display, otherwise settings remain defaults. */
export function runSettingsCommand(
    command: SettingsCommand,
    host: HostContext | undefined,
    payload?: SettingsCommandPayload,
): void | Promise<void> {
    const display = host?.readingDisplay
    const target = display?.active ? display : host?.settings?.settingsStore
    if (!target) return command.run(payload)
    const value = payload?.value
    if (command.id === "settings.layout") {
        target.layout =
            value === "single" || value === "split" || value === "scroll"
                ? value
                : nextValue(target.layout, layoutValues)
        return
    }
    if (command.id === "settings.zoom.in" || command.id === "settings.zoom.out") {
        if (typeof value === "number" && !Number.isFinite(value)) return
        target.scale =
            typeof value === "number"
                ? Math.max(0.25, Math.min(5, value))
                : stepAndClampScale(
                      target.scale,
                      command.id === "settings.zoom.in" ? 1 : -1,
                      0.25,
                      5,
                  )
        return
    }
    return command.run(payload)
}

export function createSettingsCommands(getStore: () => SettingsStore) {
    return {
        "settings.theme": {
            id: "settings.theme",
            keymap: "shift+t",
            label: () => m.keymap_change_theme(),
            englishLabel: () => m.keymap_change_theme({}, { locale: "en" }),
            category: "settings",
            subtitle: () => `${m.theme()}: ${getStore().theme}`,
            run: async (payload) => {
                const store = getStore()
                const value = payload?.value
                if (value === "light" || value === "dark" || value === "system") {
                    store.theme = value
                    return
                }
                if (value !== undefined) return
                const theme = await chooseSettingValue<Theme>({
                    id: "settings-theme",
                    placeholder: m.select_theme(),
                    items: () =>
                        themeValues.map((value) => ({
                            id: value,
                            label: m[value](),
                            englishLabel: m[value]({}, { locale: "en" }),
                            category: "settings",
                            value,
                        })),
                    initialSelection: (items) =>
                        items.findIndex(({ value }) => value === store.theme),
                })
                if (theme !== undefined) store.theme = theme
            },
        },
        "settings.layout": {
            id: "settings.layout",
            label: () => m.keymap_toggle_layouts(),
            englishLabel: () => m.keymap_toggle_layouts({}, { locale: "en" }),
            category: "settings",
            subtitle: () => `${m.layout()}: ${getStore().layout}`,
            run: (payload) => {
                const store = getStore()
                const value = payload?.value
                store.layout =
                    value === "single" || value === "split" || value === "scroll"
                        ? value
                        : nextValue(store.layout, layoutValues)
            },
        },
        "settings.language": {
            id: "settings.language",
            label: () => m.keymap_change_language(),
            englishLabel: () => m.keymap_change_language({}, { locale: "en" }),
            category: "settings",
            subtitle: () => getLanguageName(getLocale()),
            run: async (payload) => {
                const store = getStore()
                const value = payload?.value
                if (value === "en" || value === "ru") {
                    switchLanguage(value, page.url, store)
                    return
                }
                if (value !== undefined) return
                const language = await chooseSettingValue<Language>({
                    id: "settings-language",
                    placeholder: m.select_language(),
                    items: () =>
                        languageValues.map((value) => ({
                            id: value,
                            label: getLanguageName(value),
                            englishLabel: getLanguageName(value, "en"),
                            category: "settings",
                            value,
                        })),
                    initialSelection: (items) =>
                        items.findIndex(({ value }) => value === store.language),
                })
                if (language !== undefined) switchLanguage(language, page.url, store)
            },
        },
        "settings.zoom.in": {
            id: "settings.zoom.in",
            keymap: "+",
            label: () => m.keymap_zoom_in(),
            englishLabel: () => m.keymap_zoom_in({}, { locale: "en" }),
            category: "settings",
            subtitle: () => m.scale_subtitle({ scale: Math.round(getStore().scale * 100) }),
            run: (payload) => {
                const store = getStore()
                const value = payload?.value
                store.scale =
                    typeof value === "number"
                        ? Math.min(Math.max(value, CONSTANTS.minScale), CONSTANTS.maxScale)
                        : stepAndClampScale(store.scale, 1, CONSTANTS.minScale, CONSTANTS.maxScale)
            },
        },
        "settings.zoom.out": {
            id: "settings.zoom.out",
            keymap: "-",
            label: () => m.keymap_zoom_out(),
            englishLabel: () => m.keymap_zoom_out({}, { locale: "en" }),
            category: "settings",
            subtitle: () => m.scale_subtitle({ scale: Math.round(getStore().scale * 100) }),
            run: (payload) => {
                const store = getStore()
                const value = payload?.value
                store.scale =
                    typeof value === "number"
                        ? Math.min(Math.max(value, CONSTANTS.minScale), CONSTANTS.maxScale)
                        : stepAndClampScale(store.scale, -1, CONSTANTS.minScale, CONSTANTS.maxScale)
            },
        },
        "settings.quality.in": {
            id: "settings.quality.in",
            label: () => m.quality_up(),
            englishLabel: () => m.quality_up({}, { locale: "en" }),
            category: "settings",
            subtitle: () => `${m.quality()}: ${getStore().quality}`,
            run: (payload) => {
                const store = getStore()
                updateQuality(
                    store,
                    typeof payload?.value === "number" ? payload.value : store.quality + 1,
                )
            },
        },
        "settings.quality.out": {
            id: "settings.quality.out",
            label: () => m.quality_down(),
            englishLabel: () => m.quality_down({}, { locale: "en" }),
            category: "settings",
            subtitle: () => `${m.quality()}: ${getStore().quality}`,
            run: (payload) => {
                const store = getStore()
                updateQuality(
                    store,
                    typeof payload?.value === "number" ? payload.value : store.quality - 1,
                )
            },
        },
        "settings.animations.toggle": {
            id: "settings.animations.toggle",
            label: () => m.keymap_toggle_animations(),
            englishLabel: () => m.keymap_toggle_animations({}, { locale: "en" }),
            category: "settings",
            subtitle: () =>
                `${m.animations()}: ${getStore().animations ? m.animations_enabled() : m.animations_disabled()}`,
            run: () => {
                const store = getStore()
                store.animations = !store.animations
            },
        },
        "settings.pdf-title.toggle": {
            id: "settings.pdf-title.toggle",
            label: () => m.prefer_pdf_title(),
            englishLabel: () => m.prefer_pdf_title({}, { locale: "en" }),
            category: "settings",
            subtitle: () =>
                getStore().preferPdfTitle ? m.animations_enabled() : m.animations_disabled(),
            run: () => {
                const store = getStore()
                store.preferPdfTitle = !store.preferPdfTitle
            },
        },
    } satisfies Record<string, SettingsCommand>
}

export const settingsCommands = createSettingsCommands(() => settingsStore)
