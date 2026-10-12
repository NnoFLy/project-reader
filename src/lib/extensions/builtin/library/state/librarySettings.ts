export { settingsStore } from "$lib/extensions/builtin/settings"
export { getLanguageName } from "$lib/extensions/builtin/settings"
export { localizedPath } from "$lib/extensions/builtin/settings"

export function isBrowser(): boolean {
    return typeof window !== "undefined"
}
