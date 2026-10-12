export { settingsStore } from "$lib/modules/settings"
export { getLanguageName } from "$lib/modules/settings"
export { localizedPath } from "$lib/modules/settings"

export function isBrowser(): boolean {
    return typeof window !== "undefined"
}
