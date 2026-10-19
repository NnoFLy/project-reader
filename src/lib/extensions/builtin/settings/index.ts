import type { ExtensionContext, SettingContribution, SettingsCapability } from "$lib/extension-api"
import SettingsView from "./SettingsView.svelte"
import {
    configureSettingsCommandHost,
    settingsCommands,
    type SettingsCommandPayload,
} from "./commands/settingsCommands"
import { installSettingsCapability } from "$lib/core/settings"
import {
    configureSettings,
    CONSTANTS,
    DEFAULT_SETTINGS,
    settingsStore,
} from "./state/settingsStore.svelte"
import { getLocalizedCurrentHref, localizedPath } from "./language/language"
import { getLanguageName } from "./language/locale"

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
        defaultValue: DEFAULT_SETTINGS.animations,
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
    configureSettingsCommandHost(context.host)
    context.lifecycle.onDispose(() => configureSettingsCommandHost())
    if (context.host) {
        const capability: SettingsCapability = {
            settingsStore,
            CONSTANTS,
            DEFAULT_SETTINGS,
            settingsCommands,
            localizedPath,
            getLanguageName,
            getLocalizedCurrentHref,
        }
        context.host.settings = capability
        installSettingsCapability(capability)
        context.lifecycle.onDispose(() => {
            if (context.host?.settings?.settingsStore === settingsStore)
                context.host.settings = undefined
            installSettingsCapability(undefined)
        })
    }
    context.views.registerNative({
        id: SETTINGS_VIEW_ID,
        slot: "workbench.sidebar",
        title: "Settings",
        kind: "native",
        component: SettingsView,
    })
    for (const setting of settingDefinitions)
        context.settings.register(setting as SettingContribution)
    for (const command of Object.values(settingsCommands)) {
        const keymap = "keymap" in command ? command.keymap : undefined
        context.commands.register({
            id: command.id,
            label: command.label,
            englishLabel: command.englishLabel,
            keybinding:
                keymap === undefined ? undefined : Array.isArray(keymap) ? keymap : [keymap],
            execute: (payload) => command.run(payload as SettingsCommandPayload | undefined),
        })
    }
    configureSettings(context.settings, context.storage)
}

export { settingsCommands, settingsStore, configureSettings }
export { getLocalizedCurrentHref, localizedPath } from "./language/language"
export { getLanguageName } from "./language/locale"
export { stepAndClampScale } from "./utils/zoom"
export {
    CONSTANTS,
    DEFAULT_SETTINGS,
    SETTING_IDS,
    sanitizeSettings,
} from "./state/settingsStore.svelte"
export type { AppLocale } from "./language/language"
export type { Layout, Settings, Theme } from "./state/settingsStore.svelte"
