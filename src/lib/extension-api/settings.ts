import type { CommandRegistry } from "./commands"
import type { ContextualStatusPublisher } from "./contextual-status"
import type { Disposable, SettingContribution } from "./contracts"

export interface RegisteredSetting<T = unknown> extends SettingContribution<T> {
    readonly extensionId: string
}

export interface SettingsRegistry {
    register<T>(setting: SettingContribution<T>): Disposable
    get<T = unknown>(settingId: string): RegisteredSetting<T> | undefined
    list(): readonly RegisteredSetting[]
    getValue<T>(settingId: string): Promise<T>
    setValue<T>(settingId: string, value: T): Promise<void>
}
import type { PromptRequest, PromptService } from "./prompt"

export type SettingsTheme = "light" | "dark" | "system"
export type SettingsLayout = "single" | "split" | "scroll"
export type SettingsLanguage = "en" | "ru"

export interface SettingsState {
    layout: SettingsLayout
    scale: number
    quality: number
    theme: SettingsTheme
    language: SettingsLanguage
    animations: boolean
    preferPdfTitle: boolean
}

export interface SettingsStore extends SettingsState {
    getSettings(): SettingsState
    updateSetting<K extends keyof SettingsState>(key: K, value: SettingsState[K]): void
}

export interface SettingsConstants {
    maxScale: number
    minScale: number
    maxQuality: number
    minQuality: number
    defaultQuality: number
}

export interface SettingsCommand {
    readonly id: string
    readonly label: () => string
    readonly englishLabel?: () => string
    readonly keymap?: string | string[]
    readonly category: "settings"
    readonly subtitle?: () => string
    readonly run: (payload?: { readonly value?: unknown }) => void | Promise<void>
}

export type AppLocale = SettingsLanguage

export interface SettingsCapability {
    readonly settingsStore: SettingsStore
    readonly CONSTANTS: SettingsConstants
    readonly DEFAULT_SETTINGS: SettingsState
    readonly settingsCommands: Readonly<Record<string, SettingsCommand>>
    readonly localizedPath: (path: string) => string
    readonly getLanguageName: (locale: string) => string
    readonly getLocalizedCurrentHref: (url: URL, locale: AppLocale) => string
}

export interface PromptHostCapability {
    readonly promptStore: PromptService
    /** Choose a value with a parent Prompt; aborting cancels only the owned flow. */
    readonly chooseValue: <T>(
        request: PromptRequest<T>,
        signal?: AbortSignal,
    ) => Promise<T | undefined>
    readonly getPromptCommandRegistry: () =>
        | Pick<CommandRegistry, "get" | "list" | "listKeybindings" | "execute">
        | undefined
    readonly openCommandPalette: (
        source?: CommandRegistry | import("$lib/core/commands").CommandScope,
        initialQuery?: string,
    ) => Promise<void>
}

/** Viewer supplies only the active document's display preferences to host adapters. */
export interface ReadingDisplayCapability {
    readonly active: boolean
    scale: number
    layout: SettingsLayout
}

export interface HostContext {
    readingDisplay?: ReadingDisplayCapability
    /** Permanently revoked when this host loses permission to persist shared data. */
    readonly writeSignal?: AbortSignal
    /** Host-wide command discovery and execution for cross-extension UI surfaces. */
    commands?: Pick<CommandRegistry, "get" | "list" | "listKeybindings" | "execute">
    /** Status publication bound to this extension's ID. */
    contextualStatus?: ContextualStatusPublisher
    prompt?: PromptHostCapability
    settings?: SettingsCapability
}
