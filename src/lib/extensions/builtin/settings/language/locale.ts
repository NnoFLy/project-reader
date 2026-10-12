const FALLBACK_LANGUAGE_NAMES: Record<string, Record<string, string>> = {
    en: { en: "English", ru: "Russian" },
    ru: { en: "Английский", ru: "Русский" },
}

/**
 * Returns the capitalized name of a language in the requested display locale,
 * using the standard Intl.DisplayNames API with deterministic supported-locale fallbacks.
 */
export function getLanguageName(locale: string, displayLocale = locale): string {
    try {
        const displayName = new Intl.DisplayNames([displayLocale], { type: "language" }).of(locale)
        if (displayName) {
            return displayName.charAt(0).toUpperCase() + displayName.slice(1)
        }
    } catch {
        // Fall through to deterministic names for supported locales.
    }
    return (
        FALLBACK_LANGUAGE_NAMES[displayLocale]?.[locale] ??
        FALLBACK_LANGUAGE_NAMES.en?.[locale] ??
        locale.toUpperCase()
    )
}
