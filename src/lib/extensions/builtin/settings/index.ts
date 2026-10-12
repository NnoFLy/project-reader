import type { ExtensionContext, SettingContribution } from "$lib/extension-api"
import SettingsView from "./SettingsView.svelte"
import { settingsCommands } from "./commands/settingsCommands"
import { configureSettings, CONSTANTS, settingsStore } from "./state/settingsStore.svelte"

export const SETTINGS_VIEW_ID = "settings.panel"

const settingDefinitions = [
    {
        id: "settings.theme",
        label: "Theme",
        defaultValue: "system" as const,
        validate: (value: unknown): value is "light" | "dark" | "system" =>
            value === "light" || value === "dark" || value === "system",
    },
    {
        id: "settings.layout",
        label: "Layout",
        defaultValue: "scroll" as const,
        validate: (value: unknown): value is "single" | "split" | "scroll" =>
            value === "single" || value === "split" || value === "scroll",
    },
    {
        id: "settings.scale",
        label: "Scale",
        defaultValue: 1.5,
        validate: (value: unknown): value is number =>
            typeof value === "number" &&
            Number.isFinite(value) &&
            value >= CONSTANTS.minScale &&
            value <= CONSTANTS.maxScale,
    },
    {
        id: "settings.quality",
        label: "Quality",
        defaultValue: CONSTANTS.defaultQuality,
        validate: (value: unknown): value is number =>
            typeof value === "number" &&
            Number.isInteger(value) &&
            value >= CONSTANTS.minQuality &&
            value <= CONSTANTS.maxQuality,
    },
    {
        id: "settings.language",
        label: "Language",
        defaultValue: "ru" as const,
        validate: (value: unknown): value is "en" | "ru" => value === "en" || value === "ru",
    },
    {
        id: "settings.animations",
        label: "Animations",
        defaultValue: true,
        validate: (value: unknown): value is boolean => typeof value === "boolean",
    },
    {
        id: "settings.prefer-pdf-title",
        label: "Prefer PDF title",
        defaultValue: true,
        validate: (value: unknown): value is boolean => typeof value === "boolean",
    },
] as const

export function activateSettings(context: ExtensionContext): void {
    context.views.registerNative({
        id: SETTINGS_VIEW_ID,
        slot: "workbench.sidebar",
        title: "Settings",
        kind: "native",
        component: SettingsView,
    })
    for (const setting of settingDefinitions)
        context.settings.register(setting as SettingContribution)
    configureSettings(context.settings, context.storage)

}

export { settingsCommands, settingsStore, configureSettings }
export { getLocalizedCurrentHref, localizedPath } from "./language/language"
export { getLanguageName } from "./language/locale"
export { stepAndClampScale } from "./utils/zoom"
export { CONSTANTS, DEFAULT_SETTINGS, SETTING_IDS, sanitizeSettings } from "./state/settingsStore.svelte"
export type { AppLocale } from "./language/language"
export type { Layout, Settings, Theme } from "./state/settingsStore.svelte"
