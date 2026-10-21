import type { SettingsCapability } from "$lib/extension-api"

let installed: SettingsCapability | undefined

export function installSettingsCapability(capability?: SettingsCapability): () => void {
    installed = capability
    return () => {
        if (installed === capability) installed = undefined
    }
}

export const settingsStore = new Proxy({} as SettingsCapability["settingsStore"], {
    get: (_, key: keyof SettingsCapability["settingsStore"]) => {
        if (!installed) throw new Error("The settings capability is unavailable")
        return installed.settingsStore[key]
    },
    set: (_, key: keyof SettingsCapability["settingsStore"], value: unknown) => {
        if (!installed) throw new Error("The settings capability is unavailable")
        Reflect.set(installed.settingsStore, key, value)
        return true
    },
}) as SettingsCapability["settingsStore"]

export const CONSTANTS = new Proxy({} as SettingsCapability["CONSTANTS"], {
    get: (_, key: keyof SettingsCapability["CONSTANTS"]) => {
        if (!installed) throw new Error("The settings capability is unavailable")
        return installed.CONSTANTS[key]
    },
}) as SettingsCapability["CONSTANTS"]

export const DEFAULT_SETTINGS = new Proxy({} as SettingsCapability["DEFAULT_SETTINGS"], {
    get: (_, key: keyof SettingsCapability["DEFAULT_SETTINGS"]) => {
        if (!installed) throw new Error("The settings capability is unavailable")
        return installed.DEFAULT_SETTINGS[key]
    },
}) as SettingsCapability["DEFAULT_SETTINGS"]

export const settingsCommands = new Proxy({} as SettingsCapability["settingsCommands"], {
    get: (_, key: string) => {
        if (!installed) throw new Error("The settings capability is unavailable")
        return installed.settingsCommands[key]
    },
}) as SettingsCapability["settingsCommands"]

export const localizedPath = (path: string) => {
    if (!installed) throw new Error("The settings capability is unavailable")
    return installed.localizedPath(path)
}
export const getLanguageName = (locale: string) => {
    if (!installed) throw new Error("The settings capability is unavailable")
    return installed.getLanguageName(locale)
}
export const getLocalizedCurrentHref = (
    url: URL,
    locale: SettingsCapability["DEFAULT_SETTINGS"]["language"],
) => {
    if (!installed) throw new Error("The settings capability is unavailable")
    return installed.getLocalizedCurrentHref(url, locale)
}
export type Theme = SettingsCapability["DEFAULT_SETTINGS"]["theme"]
export type AppLocale = SettingsCapability["DEFAULT_SETTINGS"]["language"]
