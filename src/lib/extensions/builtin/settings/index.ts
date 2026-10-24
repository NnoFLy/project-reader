import type { ExtensionContext, SettingContribution, SettingsCapability } from "$lib/extension-api"
import * as m from "$lib/paraglide/messages"
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
        label: () => m.theme(),
        description: () => m.settings_theme_description(),
        category: "appearance",
        editor: {
            kind: "choice",
            choices: [
                { value: "light", label: () => m.light() },
                { value: "dark", label: () => m.dark() },
                { value: "system", label: () => m.system() },
            ],
        },
        defaultValue: "system" as const,
        validate: (value: unknown): value is "light" | "dark" | "system" =>
            value === "light" || value === "dark" || value === "system",
    },
    {
        id: "settings.layout",
        label: () => m.settings_layout_label(),
        description: () => m.settings_layout_description(),
        category: "reading",
        editor: {
            kind: "choice",
            choices: [
                { value: "single", label: () => m.single_page() },
                { value: "split", label: () => m.split_pages() },
                { value: "scroll", label: () => m.scroll_pages() },
            ],
        },
        defaultValue: "scroll" as const,
        validate: (value: unknown): value is "single" | "split" | "scroll" =>
            value === "single" || value === "split" || value === "scroll",
    },
    {
        id: "settings.scale",
        label: () => m.settings_scale_label(),
        description: () => m.settings_scale_description(),
        category: "reading",
        editor: { kind: "number", min: CONSTANTS.minScale, max: CONSTANTS.maxScale },
        defaultValue: 1.5,
        validate: (value: unknown): value is number =>
            typeof value === "number" &&
            Number.isFinite(value) &&
            value >= CONSTANTS.minScale &&
            value <= CONSTANTS.maxScale,
    },
    {
        id: "settings.quality",
        label: () => m.quality(),
        description: () => m.settings_quality_description(),
        category: "reading",
        editor: { kind: "number", min: CONSTANTS.minQuality, max: CONSTANTS.maxQuality, step: 1 },
        defaultValue: CONSTANTS.defaultQuality,
        validate: (value: unknown): value is number =>
            typeof value === "number" &&
            Number.isInteger(value) &&
            value >= CONSTANTS.minQuality &&
            value <= CONSTANTS.maxQuality,
    },
    {
        id: "settings.language",
        label: () => m.settings_language_label(),
        description: () => m.settings_language_description(),
        category: "general",
        editor: {
            kind: "choice",
            choices: [
                { value: "ru", label: () => getLanguageName("ru") },
                { value: "en", label: () => getLanguageName("en") },
            ],
        },
        defaultValue: "ru" as const,
        validate: (value: unknown): value is "en" | "ru" => value === "en" || value === "ru",
    },
    {
        id: "settings.animations",
        label: () => m.animations(),
        description: () => m.settings_animations_description(),
        category: "appearance",
        editor: { kind: "boolean" },
        defaultValue: DEFAULT_SETTINGS.animations,
        validate: (value: unknown): value is boolean => typeof value === "boolean",
    },
    {
        id: "settings.prefer-pdf-title",
        label: () => m.prefer_pdf_title(),
        description: () => m.settings_pdf_title_description(),
        category: "library",
        editor: { kind: "boolean" },
        defaultValue: true,
        validate: (value: unknown): value is boolean => typeof value === "boolean",
    },
] as const

export async function activateSettings(context: ExtensionContext): Promise<void> {
    let navigationPresenter: ((navigate: (() => void) | undefined) => void) | undefined
    const store = new SettingsStore((navigate) => {
        if (navigationPresenter) navigationPresenter(navigate)
        else navigate?.()
    })
    installSettingsStore(store)
    const commands = createSettingsCommands(() => store)
    context.lifecycle.onDispose(() => store.dispose())
    configureSettingsCommandHost(context.host)
    context.lifecycle.onDispose(() => configureSettingsCommandHost(undefined, context.host))
    let presenter: (() => void) | undefined
    let pendingOpen = false
    let disposed = false
    const openSettings = () => {
        if (disposed) return
        if (presenter) presenter()
        else pendingOpen = true
    }
    context.lifecycle.onDispose(() => {
        disposed = true
        pendingOpen = false
        presenter = undefined
        navigationPresenter = undefined
    })
    if (context.host) {
        const capability: SettingsCapability = {
            openSettings,
            onDidRequestOpen(listener) {
                if (disposed) return { dispose() {} }
                const currentPresenter = () => listener()
                presenter = currentPresenter
                if (pendingOpen) {
                    pendingOpen = false
                    listener()
                }
                return {
                    dispose() {
                        if (presenter === currentPresenter) presenter = undefined
                    },
                }
            },
            onDidRequestNavigation(listener) {
                if (disposed) return { dispose() {} }
                const currentPresenter = (navigate: (() => void) | undefined) => listener(navigate)
                navigationPresenter = currentPresenter
                return {
                    dispose() {
                        if (navigationPresenter === currentPresenter)
                            navigationPresenter = undefined
                    },
                }
            },
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
    context.commands.register({
        id: "settings.open",
        label: () => m.settings_open(),
        englishLabel: () => m.settings_open({}, { locale: "en" }),
        execute: openSettings,
    })
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
