import { resolve } from "$app/paths"
import { browser } from "$app/environment"
import { localizeHref, setLocale } from "$lib/paraglide/runtime"

export type AppLocale = "ru" | "en"

export function getLocalizedCurrentHref(url: URL, locale: AppLocale): string {
    const href = url.pathname + url.search + url.hash
    return localizeHref(href, { locale })
}

export function localizedPath(href: string): string {
    return resolve(localizeHref(href) as any)
}

/** Called only for an acknowledged preference, never an attempted write. */
export function applyLanguage(locale: AppLocale, url?: URL): (() => void) | undefined {
    setLocale(locale, { reload: false })
    if (!browser) return
    document.cookie = `PARAGLIDE_LOCALE=${locale}; path=/; max-age=31536000; SameSite=Lax`
    document.documentElement.lang = locale
    document.documentElement.dir = "ltr"
    if (!url) return
    const href = resolve(getLocalizedCurrentHref(url, locale) as any)
    if (
        browser &&
        href !== window.location.pathname + window.location.search + window.location.hash
    ) {
        return () => {
            window.location.href = href
        }
    }
}
