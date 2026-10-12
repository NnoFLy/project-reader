export { settingsStore } from "$lib/core/settings"
export { getLanguageName } from "$lib/core/settings"
export { localizedPath } from "$lib/core/settings"

export function isBrowser(): boolean {
    return typeof window !== "undefined"
}
