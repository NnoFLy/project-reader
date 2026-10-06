import { browser } from "$app/environment"
import { motionPreferences } from "$lib/shared/state/motion.svelte"
import { safeStorageGet, safeStorageSet } from "$lib/shared/state/safeStorage"

export type Theme = "light" | "dark" | "system"
export type Layout = "single" | "split" | "scroll"

export interface Settings {
    layout: Layout
    scale: number
    quality: number
    theme: Theme
    language: "en" | "ru"
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
    animations: true,
    preferPdfTitle: true,
}

export function sanitizeSettings(parsed: unknown): Partial<Settings> {
    const sanitized: Partial<Settings> = {}
    if (!parsed || typeof parsed !== "object") return sanitized

    const value = parsed as Record<string, unknown>
    if (["single", "split", "scroll"].includes(value.layout as string)) {
        sanitized.layout = value.layout as Layout
    }
    if (
        typeof value.scale === "number" &&
        value.scale >= CONSTANTS.minScale &&
        value.scale <= CONSTANTS.maxScale
    ) {
        sanitized.scale = value.scale
    }
    if (["light", "dark", "system"].includes(value.theme as string)) {
        sanitized.theme = value.theme as Theme
    }
    if (["en", "ru"].includes(value.language as string)) {
        sanitized.language = value.language as Settings["language"]
    }
    if (typeof value.animations === "boolean") sanitized.animations = value.animations
    if (typeof value.preferPdfTitle === "boolean") {
        sanitized.preferPdfTitle = value.preferPdfTitle
    }
    if (
        typeof value.quality === "number" &&
        value.quality >= CONSTANTS.minQuality &&
        value.quality <= CONSTANTS.maxQuality
    ) {
        sanitized.quality = value.quality
    }
    return sanitized
}

class SettingsStore {
    private settings = $state<Settings>({ ...DEFAULT_SETTINGS })
    private colorSchemeQuery: MediaQueryList | null = null
    private readonly handleColorSchemeChange = () => {
        if (this.theme === "system") this.updateDOM()
    }

    constructor() {
        if (browser) {
            const savedSettings = safeStorageGet("settings")
            if (savedSettings) {
                try {
                    const parsed = JSON.parse(savedSettings)
                    const sanitized = sanitizeSettings(parsed)
                    this.settings = { ...this.settings, ...sanitized }
                    if (sanitized.language) {
                        document.cookie = `PARAGLIDE_LOCALE=${sanitized.language}; path=/; max-age=31536000; SameSite=Lax`
                    }
                } catch (e) {
                    console.error("Failed to parse settings from localStorage", e)
                }
            } else {
                this.theme = (safeStorageGet("theme") as Theme) || "system"
            }

            motionPreferences.enabled = this.settings.animations
            document.documentElement.dataset.motion = this.settings.animations ? "on" : "off"
            this.colorSchemeQuery = window.matchMedia("(prefers-color-scheme: dark)")
            this.colorSchemeQuery.addEventListener("change", this.handleColorSchemeChange)
            this.updateDOM()
        }
    }

    dispose() {
        this.colorSchemeQuery?.removeEventListener("change", this.handleColorSchemeChange)
        this.colorSchemeQuery = null
    }

    getSettings(): Settings {
        return this.settings
    }

    updateSetting<K extends keyof Settings>(key: K, value: Settings[K]): void {
        // Mutate the deep state property so Svelte can invalidate only consumers of
        // this setting. Replacing the whole object reruns effects that read quality
        // when unrelated settings such as scale, theme, or animations change.
        this.settings[key] = value
        if (browser) {
            safeStorageSet("settings", JSON.stringify(this.settings))
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
        this.updateSetting("layout", value)
    }

    get scale(): Settings["scale"] {
        return this.settings.scale
    }

    set scale(value: Settings["scale"]) {
        this.updateSetting("scale", value)
    }

    get theme(): Settings["theme"] {
        return this.settings.theme
    }

    set theme(value: Settings["theme"]) {
        this.updateSetting("theme", value)
        this.updateDOM()
    }

    get language(): Settings["language"] {
        return this.settings.language
    }

    set language(value: Settings["language"]) {
        this.updateSetting("language", value)
        if (browser) {
            document.cookie = `PARAGLIDE_LOCALE=${value}; path=/; max-age=31536000; SameSite=Lax`
            document.documentElement.lang = value
            document.documentElement.dir = "ltr"
        }
    }

    get animations(): Settings["animations"] {
        return this.settings.animations
    }

    set animations(value: Settings["animations"]) {
        this.updateSetting("animations", value)
        motionPreferences.enabled = value
        if (browser) document.documentElement.dataset.motion = value ? "on" : "off"
    }

    get quality(): Settings["quality"] {
        return this.settings.quality
    }

    set quality(value: Settings["quality"]) {
        this.updateSetting("quality", value)
    }

    get preferPdfTitle(): Settings["preferPdfTitle"] {
        return this.settings.preferPdfTitle
    }

    set preferPdfTitle(value: Settings["preferPdfTitle"]) {
        this.updateSetting("preferPdfTitle", value)
    }

    updateDOM() {
        if (!browser) return
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
}

export const settingsStore = new SettingsStore()

if (import.meta.hot) {
    import.meta.hot.dispose(() => settingsStore.dispose())
}
