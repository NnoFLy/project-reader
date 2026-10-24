import { SvelteSet } from "svelte/reactivity"
import { applyLanguage } from "../language/language"
import { browser } from "$app/environment"
import type { Disposable, SettingsRegistry, StorageNamespace } from "$lib/extension-api"
import { safeStorageGet, safeStorageSet } from "$lib/shared/state/safeStorage"
import { DEFAULT_ANIMATIONS, motionPreferences } from "$lib/shared/state/motion.svelte"

export type Theme = "light" | "dark" | "system"
export type Layout = "single" | "split" | "scroll"
export type Language = "en" | "ru"

export interface Settings {
    layout: Layout
    scale: number
    quality: number
    theme: Theme
    language: Language
    animations: boolean
    preferPdfTitle: boolean
}

interface Constants {
    maxScale: number
    minScale: number
    maxQuality: number
    minQuality: number
    defaultQuality: number
}

export const CONSTANTS: Constants = {
    maxScale: 5,
    minScale: 0.25,
    maxQuality: 5,
    minQuality: 1,
    defaultQuality: 3,
}

export const DEFAULT_SETTINGS: Settings = {
    layout: "scroll",
    scale: 1.5,
    quality: CONSTANTS.defaultQuality,
    theme: "system",
    language: "ru",
    animations: DEFAULT_ANIMATIONS,
    preferPdfTitle: true,
}

const BOOTSTRAP_STORAGE_KEY = "settings"

function persistBootstrapSetting(key: "theme" | "animations", value: Theme | boolean): void {
    const stored = safeStorageGet(BOOTSTRAP_STORAGE_KEY)
    let bootstrap: Record<string, unknown> = {}

    if (stored) {
        try {
            const parsed: unknown = JSON.parse(stored)
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
                bootstrap = { ...(parsed as Record<string, unknown>) }
            }
        } catch {
            // Replace invalid bootstrap data with the next valid setting value.
        }
    }

    bootstrap[key] = value
    safeStorageSet(BOOTSTRAP_STORAGE_KEY, JSON.stringify(bootstrap))
}

function readLegacySettings(): Partial<Settings> {
    const stored = safeStorageGet(BOOTSTRAP_STORAGE_KEY)
    if (!stored) return {}

    try {
        return sanitizeSettings(JSON.parse(stored))
    } catch {
        return {}
    }
}

export const SETTING_IDS = {
    theme: "settings.theme",
    layout: "settings.layout",
    scale: "settings.scale",
    quality: "settings.quality",
    language: "settings.language",
    animations: "settings.animations",
    preferPdfTitle: "settings.prefer-pdf-title",
} as const

export type SettingId = (typeof SETTING_IDS)[keyof typeof SETTING_IDS]

export function sanitizeSettings(parsed: unknown): Partial<Settings> {
    const sanitized: Partial<Settings> = {}
    if (!parsed || typeof parsed !== "object") return sanitized

    const value = parsed as Record<string, unknown>
    if (["single", "split", "scroll"].includes(value.layout as string)) {
        sanitized.layout = value.layout as Layout
    }
    if (
        typeof value.scale === "number" &&
        Number.isFinite(value.scale) &&
        value.scale >= CONSTANTS.minScale &&
        value.scale <= CONSTANTS.maxScale
    ) {
        sanitized.scale = value.scale
    }
    if (["light", "dark", "system"].includes(value.theme as string)) {
        sanitized.theme = value.theme as Theme
    }
    if (["en", "ru"].includes(value.language as string)) {
        sanitized.language = value.language as Language
    }
    if (typeof value.animations === "boolean") sanitized.animations = value.animations
    if (typeof value.preferPdfTitle === "boolean") {
        sanitized.preferPdfTitle = value.preferPdfTitle
    }
    if (
        typeof value.quality === "number" &&
        Number.isInteger(value.quality) &&
        value.quality >= CONSTANTS.minQuality &&
        value.quality <= CONSTANTS.maxQuality
    ) {
        sanitized.quality = value.quality
    }
    return sanitized
}

/**
 * The settings extension owns the reactive state, while the host owns the registry and storage.
 * Keeping this adapter here lets existing app consumers use the same synchronous settings API
 * without bypassing the extension's registered controls or its durable storage namespace.
 */
export class SettingsStore {
    private settings = $state<Settings>({
        ...DEFAULT_SETTINGS,
        animations: readLegacySettings().animations ?? DEFAULT_SETTINGS.animations,
    })
    private registeredIds = $state<ReadonlySet<string>>(new SvelteSet<string>())
    private disposed = false
    private configuration = new AbortController()
    private registry: SettingsRegistry | undefined
    private subscription: Disposable | undefined
    private readonly revisions: Partial<Record<SettingId, number>> = {}
    private languageRevision = 0
    private readonly writes: Partial<Record<keyof Settings, Promise<void>>> = {}
    readonly loadErrors = $state<Partial<Record<keyof Settings, string>>>({})
    readonly writeErrors = $state<Partial<Record<keyof Settings, string>>>({})
    private colorSchemeQuery: MediaQueryList | null = null
    private readonly handleColorSchemeChange = () => {
        if (this.theme === "system") this.updateDOM()
    }

    private readonly requestNavigation: ((navigate: (() => void) | undefined) => void) | undefined

    constructor(requestNavigation?: (navigate: (() => void) | undefined) => void) {
        this.requestNavigation = requestNavigation
        motionPreferences.enabled = this.settings.animations
        if (browser) {
            document.documentElement.dataset.motion = this.settings.animations ? "on" : "off"
            this.colorSchemeQuery = window.matchMedia("(prefers-color-scheme: dark)")
            this.colorSchemeQuery.addEventListener("change", this.handleColorSchemeChange)
            this.updateDOM()
        }
    }

    configure(registry: SettingsRegistry, storage: StorageNamespace): Promise<void> {
        if (this.disposed) return Promise.resolve()
        this.configuration.abort()
        this.configuration = new AbortController()
        this.registry = registry
        this.subscription?.dispose()
        this.registeredIds = new SvelteSet(registry.list().map(({ id }) => id))
        const { signal } = this.configuration
        const bootstrapImport = Symbol("settings bootstrap import")
        this.subscription = registry.onDidChange((change) => {
            if (signal.aborted || change.kind !== "value") return
            const key = (Object.keys(SETTING_IDS) as (keyof Settings)[]).find(
                (key) => SETTING_IDS[key] === change.settingId,
            )
            if (!key) return
            this.revisions[SETTING_IDS[key]] = (this.revisions[SETTING_IDS[key]] ?? 0) + 1
            delete this.loadErrors[key]
            delete this.writeErrors[key]
            // Import ACKs remain authoritative, but only interactive successes request navigation.
            this.applySetting(key, change.value as never, change.provenance !== bootstrapImport)
        })
        return this.loadRegisteredValues(registry, storage, signal, bootstrapImport)
    }

    isRegistered(id: SettingId): boolean {
        return this.registeredIds.has(id)
    }

    dispose() {
        this.disposed = true
        this.configuration.abort()
        this.subscription?.dispose()
        this.colorSchemeQuery?.removeEventListener("change", this.handleColorSchemeChange)
        this.colorSchemeQuery = null
    }

    getSettings(): Settings {
        return this.settings
    }

    updateSetting<K extends keyof Settings>(key: K, value: Settings[K]): Promise<void> {
        return this.queueSetting(key, value)
    }

    transformSetting<K extends keyof Settings>(
        key: K,
        transform: (value: Settings[K]) => Settings[K],
    ): Promise<void> {
        return this.queueSetting(key, transform)
    }

    private queueSetting<K extends keyof Settings>(
        key: K,
        value: Settings[K] | ((value: Settings[K]) => Settings[K]),
    ): Promise<void> {
        if (this.disposed) return Promise.reject(new Error("Settings are disposed"))
        const registry = this.registry
        if (!registry) {
            // Legacy standalone consumers have no host or durable registry.
            this.applySetting(key, typeof value === "function" ? value(this.settings[key]) : value)
            return Promise.resolve()
        }
        const id = SETTING_IDS[key]
        this.revisions[id] = (this.revisions[id] ?? 0) + 1
        const { signal } = this.configuration
        const result = (this.writes[key] ?? Promise.resolve())
            .then(async () => {
                signal.throwIfAborted()
                // Read through the registry so previously admitted catalog writes also settle.
                const next =
                    typeof value === "function"
                        ? value(await registry.getValue<Settings[K]>(id))
                        : value
                signal.throwIfAborted()
                await registry.setValue(id, next)
            })
            .catch((error) => {
                if (!signal.aborted) this.writeErrors[key] = "Unable to save preference"
                throw error
            })
        // A rejected operation must not poison subsequent relative commands.
        const settled = result.then(
            () => undefined,
            () => undefined,
        )
        this.writes[key] = settled
        void settled.then(() => {
            if (this.writes[key] === settled) delete this.writes[key]
        })
        return result
    }

    async whenSettled(): Promise<void> {
        while (Object.values(this.writes).length) await Promise.all(Object.values(this.writes))
    }

    private setFromProperty<K extends keyof Settings>(key: K, value: Settings[K]): void {
        // Property bindings cannot await; the acknowledged API exposes failures to callers,
        // and writeErrors keeps compatibility bindings from silently losing the failure.
        void this.updateSetting(key, value).catch(() => undefined)
    }

    private applySetting<K extends keyof Settings>(
        key: K,
        value: Settings[K],
        committed = false,
        cacheBootstrap = true,
    ): void {
        this.settings[key] = value
        if (key === "language") {
            const navigate = applyLanguage(
                value as Language,
                committed && browser ? new URL(window.location.href) : undefined,
            )
            if (committed) {
                const { signal } = this.configuration
                const revision = ++this.languageRevision
                const currentNavigation = navigate
                    ? () => {
                          if (!signal.aborted && revision === this.languageRevision) navigate()
                      }
                    : undefined
                // Never await presentation from a value notification: its own write must settle first.
                if (this.requestNavigation) this.requestNavigation(currentNavigation)
                else currentNavigation?.()
            }
        }
        if (key === "theme") {
            persistBootstrapSetting("theme", value as Theme)
            this.updateDOM()
        }
        if (key === "animations") {
            motionPreferences.enabled = value as boolean
            if (cacheBootstrap) persistBootstrapSetting("animations", value as boolean)
            if (browser) document.documentElement.dataset.motion = value ? "on" : "off"
        }
    }

    layout_next() {
        const layouts: Settings["layout"][] = ["single", "split", "scroll"]
        const index = layouts.indexOf(this.layout)
        this.layout = layouts[(index + 1) % layouts.length]
        return this.layout
    }

    get layout(): Settings["layout"] {
        return this.settings.layout
    }

    set layout(value: Settings["layout"]) {
        this.setFromProperty("layout", value)
    }

    get scale(): Settings["scale"] {
        return this.settings.scale
    }

    set scale(value: Settings["scale"]) {
        this.setFromProperty("scale", value)
    }

    get theme(): Settings["theme"] {
        return this.settings.theme
    }

    set theme(value: Settings["theme"]) {
        this.setFromProperty("theme", value)
    }

    get language(): Settings["language"] {
        return this.settings.language
    }

    set language(value: Settings["language"]) {
        this.setFromProperty("language", value)
    }

    get animations(): Settings["animations"] {
        return this.settings.animations
    }

    set animations(value: Settings["animations"]) {
        this.setFromProperty("animations", value)
    }

    get quality(): Settings["quality"] {
        return this.settings.quality
    }

    set quality(value: Settings["quality"]) {
        this.setFromProperty("quality", value)
    }

    get preferPdfTitle(): Settings["preferPdfTitle"] {
        return this.settings.preferPdfTitle
    }

    set preferPdfTitle(value: Settings["preferPdfTitle"]) {
        this.setFromProperty("preferPdfTitle", value)
    }

    updateDOM() {
        if (!browser || this.disposed) return
        const isDark =
            this.theme === "dark" ||
            (this.theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)

        document.documentElement.lang = this.language
        document.documentElement.dir = "ltr"

        const activeThemeColor = isDark ? "#000000" : "#f5f0e1"
        for (const meta of document.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
            const isDarkMeta = meta.id.endsWith("dark")
            meta.content =
                this.theme === "system" ? (isDarkMeta ? "#000000" : "#f5f0e1") : activeThemeColor
            meta.media =
                this.theme === "system"
                    ? isDarkMeta
                        ? "(prefers-color-scheme: dark)"
                        : "(prefers-color-scheme: light)"
                    : "all"
        }

        switch (this.theme) {
            case "dark":
                document.documentElement.classList.add("dark")
                document.documentElement.classList.remove("light")
                document.documentElement.style.colorScheme = "dark"
                break
            case "light":
                document.documentElement.classList.add("light")
                document.documentElement.classList.remove("dark")
                document.documentElement.style.colorScheme = "light"
                break
            default:
                if (isDark) {
                    document.documentElement.classList.add("dark")
                    document.documentElement.classList.remove("light")
                    document.documentElement.style.colorScheme = "dark"
                } else {
                    document.documentElement.classList.remove("dark")
                    document.documentElement.classList.remove("light")
                    document.documentElement.style.colorScheme = "light"
                }
                break
        }
    }

    private async loadRegisteredValues(
        registry: SettingsRegistry,
        storage: StorageNamespace,
        signal: AbortSignal,
        bootstrapImport: symbol,
    ): Promise<void> {
        const legacySettings = readLegacySettings()
        await Promise.all(
            (Object.entries(SETTING_IDS) as [keyof Settings, SettingId][]).map(
                async ([key, id]) => {
                    const setting = registry.get(id)
                    if (!setting) return
                    const revision = this.revisions[id] ?? 0
                    const current = () =>
                        !signal.aborted &&
                        registry.get(id) === setting &&
                        (this.revisions[id] ?? 0) === revision
                    try {
                        // Only the existing legacy import needs to distinguish missing from default.
                        const stored =
                            legacySettings[key] === undefined && key !== "animations"
                                ? undefined
                                : await storage.get(id)
                        const value = await registry.getValue(id)
                        if (!current()) return
                        if (legacySettings[key] !== undefined && stored === undefined) {
                            const imported = await registry.initializeValue(
                                id,
                                legacySettings[key],
                                bootstrapImport,
                            )
                            if (
                                !imported.initialized &&
                                current() &&
                                (!setting.validate || setting.validate(imported.value))
                            ) {
                                this.applySetting(key, imported.value as never)
                                delete this.loadErrors[key]
                            }
                        } else if (!setting.validate || setting.validate(value)) {
                            this.applySetting(
                                key,
                                value as never,
                                false,
                                key !== "animations" ||
                                    stored !== undefined ||
                                    legacySettings.animations !== undefined,
                            )
                            delete this.loadErrors[key]
                        }
                    } catch {
                        if (current()) this.loadErrors[key] = "Unable to load preference"
                    }
                },
            ),
        )
    }
}

export let settingsStore = new SettingsStore()
let bootstrapStore: SettingsStore | undefined = settingsStore

/** Select the UI-facing adapter without changing any previous application's ownership. */
export function installSettingsStore(store: SettingsStore): void {
    if (bootstrapStore && bootstrapStore !== store) {
        bootstrapStore.dispose()
        bootstrapStore = undefined
    }
    settingsStore = store
}

export function configureSettings(
    registry: SettingsRegistry,
    storage: StorageNamespace,
): Promise<void> {
    return settingsStore.configure(registry, storage)
}

if (import.meta.hot) {
    import.meta.hot.dispose(() => settingsStore.dispose())
}
