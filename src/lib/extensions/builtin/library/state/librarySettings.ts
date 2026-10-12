import { browser } from "$app/environment"

export const settingsStore = {
    animations: true,
    preferPdfTitle: true,
    theme: "system",
}

export function localizedPath(path: string): string {
    return path
}

export function getLanguageName(locale: string): string {
    try {
        return new Intl.DisplayNames([locale], { type: "language" }).of(locale) ?? locale
    } catch {
        return locale
    }
}

export function isBrowser(): boolean {
    return browser
}
