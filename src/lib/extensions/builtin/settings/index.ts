import type { ExtensionContext, SettingContribution, SettingsCapability } from "$lib/extension-api"
import SettingsView from "./SettingsView.svelte"
import {
    configureSettingsCommandHost,
    createSettingsCommands,
    settingsCommands,
    runSettingsCommand,
    type SettingsCommandPayload,
} from "./commands/settingsCommands"
import { installSettingsCapability } from "$lib/core/settings"
import {
    configureSettings,
    CONSTANTS,
    DEFAULT_SETTINGS,
    settingsStore,
    SettingsStore,
    installSettingsStore,
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

export async function activateSettings(context: ExtensionContext): Promise<void> {
    const store = new SettingsStore()
    installSettingsStore(store)
    const commands = createSettingsCommands(() => store)
    context.lifecycle.onDispose(() => store.dispose())
    configureSettingsCommandHost(context.host)
    context.lifecycle.onDispose(() => configureSettingsCommandHost(undefined, context.host))
    if (context.host) {
        const capability: SettingsCapability = {
            settingsStore: store,
            CONSTANTS,
            DEFAULT_SETTINGS,
            settingsCommands: commands,
            localizedPath,
            getLanguageName,
            getLocalizedCurrentHref,
        }
        context.host.settings = capability
        const uninstallCapability = installSettingsCapability(capability)
        context.lifecycle.onDispose(() => {
            if (context.host?.settings === capability) context.host.settings = undefined
            uninstallCapability()
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
    for (const command of Object.values(commands)) {
        const keymap = "keymap" in command ? command.keymap : undefined
        context.commands.register({
            id: command.id,
            label: command.label,
            englishLabel: command.englishLabel,
            keybinding:
                keymap === undefined ? undefined : Array.isArray(keymap) ? keymap : [keymap],
            execute: (payload) =>
                runSettingsCommand(
                    command,
                    context.host,
                    payload as SettingsCommandPayload | undefined,
                ),
        })
    }
    // Readiness must not hold activation (and therefore host disposal) behind a stuck backend.
    // The settings store handles late completion; Viewer captures defaults only when opening.
    let readinessTimeout: ReturnType<typeof setTimeout> | undefined
    try {
        await Promise.race([
            store.configure(context.settings, context.storage),
            new Promise<void>((resolve) => {
                readinessTimeout = setTimeout(resolve, 250)
            }),
        ])
    } finally {
        clearTimeout(readinessTimeout)
    }
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
