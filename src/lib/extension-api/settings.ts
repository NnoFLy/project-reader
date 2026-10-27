import type { CommandRegistry } from "./commands"
import type { ContextualStatusPublisher } from "./contextual-status"
import type { Disposable, SettingCategory, SettingContribution } from "./contracts"

export interface RegisteredSetting<T = unknown> extends SettingContribution<T> {
    readonly extensionId: string
    readonly extensionName: string
    readonly category: SettingCategory
    readonly editorUnavailableReason?: string
}

export type SettingsChange =
    | { readonly kind: "catalog" }
    | {
          readonly kind: "value"
          readonly settingId: string
          readonly value: unknown
          /** Opaque operation observation provenance only; never an authorization token. */
          readonly provenance?: symbol
      }

/** Trusted host-owned discovery only; never supplied to an extension context. */
export interface HostSettingsCatalog {
    get<T = unknown>(settingId: string): RegisteredSetting<T> | undefined
    list(): readonly RegisteredSetting[]
    /** Pass the captured entry for every asynchronous UI operation, including retries. */
    getValue<T>(settingId: string, expectedSetting?: RegisteredSetting): Promise<T>
    setValue<T>(settingId: string, value: T, expectedSetting?: RegisteredSetting): Promise<void>
    resetValue(settingId: string, expectedSetting?: RegisteredSetting): Promise<void>
    onDidChange(listener: (change: SettingsChange) => void): Disposable
}

export interface SettingsRegistry {
    register<T>(setting: SettingContribution<T>): Disposable
    get<T = unknown>(settingId: string): RegisteredSetting<T> | undefined
    list(): readonly RegisteredSetting[]
    getValue<T>(settingId: string): Promise<T>
    /** Optional provenance is echoed on this operation's successful value notification. */
    setValue<T>(settingId: string, value: T, provenance?: symbol): Promise<void>
    /** Atomically import only when no durable value exists; skipped imports emit no change. */
    initializeValue<T>(
        settingId: string,
        value: T,
        provenance?: symbol,
    ): Promise<{ readonly initialized: boolean; readonly value: T }>
    resetValue(settingId: string): Promise<void>
    onDidChange(listener: (change: SettingsChange) => void): Disposable
}
import type { PromptRequest, PromptService } from "./prompt"

export type SettingsTheme = "light" | "dark" | "system"
export type SettingsLayout = "single" | "split" | "scroll"
export type SettingsLanguage = "en" | "ru"
export type UiFontPreset = "plex-sans" | "system" | "source-serif" | "plex-mono" | "custom"

export interface SettingsState {
    layout: SettingsLayout
    scale: number
    quality: number
    theme: SettingsTheme
    language: SettingsLanguage
    animations: boolean
    preferPdfTitle: boolean
    uiFont: UiFontPreset
    uiCustomFont: string
    uiFontSize: number
}

export interface SettingsStore extends SettingsState {
    getSettings(): SettingsState
    readonly loadErrors: Readonly<Partial<Record<keyof SettingsState, string>>>
    readonly writeErrors: Readonly<Partial<Record<keyof SettingsState, string>>>
    updateSetting<K extends keyof SettingsState>(key: K, value: SettingsState[K]): Promise<void>
    transformSetting<K extends keyof SettingsState>(
        key: K,
        transform: (value: SettingsState[K]) => SettingsState[K],
    ): Promise<void>
    whenSettled(): Promise<void>
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
    /** Request presentation only; repeated requests focus the app-owned singleton. */
    readonly openSettings: () => void
    /** One app presenter per lifetime; retains one request until a presenter subscribes. */
    readonly onDidRequestOpen: (listener: () => void) => Disposable
    /** Post-ACK language intent; undefined cancels an older intent. Never await the presenter. */
    readonly onDidRequestNavigation: (
        listener: (navigate: (() => void) | undefined) => void,
    ) => Disposable
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

/** Minimal document-linked counts; annotation material remains owned by Viewer. */
export interface ReadingSummaryCapability {
    getSummary(documentId: string): Promise<{
        readonly documentId: string
        readonly noteCount: number
        readonly bookmarkCount: number
    } | null>
}

/** Viewer-owned recovery reference only; no document or annotation material. */
export interface ReadingRecoveryCapability {
    readonly documentId: string | null
    readonly status:
        | "closed"
        | "ready"
        | "unavailable"
        | "missing"
        | "provider-unavailable"
        | "deletion-pending"
    retry(): Promise<boolean>
}

/** Committed source-deletion IDs only; annotation payloads never cross the host. */
export interface ReadingDeletionCapability {
    prepare(documentIds: readonly string[]): void
    fence(documentIds: readonly string[], phase: "pending" | "complete" | "retired"): void
    complete(documentIds: readonly string[], signal?: AbortSignal): Promise<void>
    rollback(documentIds: readonly string[]): void
    delete(documentIds: readonly string[], signal?: AbortSignal): Promise<void>
}

/** Small-record admission precedes restoration; payload replay runs after runtime publication. */
export interface ReadingDeletionRecoveryCapability {
    admit(): Promise<void>
    resume(): Promise<boolean>
}

export interface HostContext {
    readingDeletion?: ReadingDeletionCapability
    readingDeletionRecovery?: ReadingDeletionRecoveryCapability
    readingRecovery?: ReadingRecoveryCapability
    readonly providers?: import("./providers").ProviderAvailability
    readingSummaries?: ReadingSummaryCapability
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
