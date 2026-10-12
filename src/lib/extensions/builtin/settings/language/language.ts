import { resolve } from "$app/paths"
import { browser } from "$app/environment"
import { localizeHref, setLocale } from "$lib/paraglide/runtime"
import { settingsStore } from "../state/settingsStore.svelte"

export type AppLocale = "ru" | "en"

export function getLocalizedCurrentHref(url: URL, locale: AppLocale): string {
    const href = url.pathname + url.search + url.hash
    return localizeHref(href, { locale })
}

export function localizedPath(href: string): string {
    return resolve(localizeHref(href) as any)
}

export function switchLanguage(locale: AppLocale, url: URL): void {
    settingsStore.language = locale
    setLocale(locale, { reload: false })

    const href = resolve(getLocalizedCurrentHref(url, locale) as any)
    if (
        browser &&
        href !== window.location.pathname + window.location.search + window.location.hash
    ) {
        window.location.href = href
    }
}
