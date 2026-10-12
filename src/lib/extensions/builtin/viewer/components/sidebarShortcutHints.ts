import { KeyboardHandler } from "$lib/modules/commands"

export type SidebarShortcutPair = { display: string }

function toKeys(keymap?: string | string[]): string[] {
    if (!keymap) return []
    return Array.isArray(keymap) ? keymap : [keymap]
}

export function isSidebarShortcutInputSafe(key: string): boolean {
    const normalized = KeyboardHandler.normalize(key)
    if (normalized.includes("+")) return true
    return ["arrowdown", "arrowup", "enter", "escape"].includes(normalized)
}

export function formatSidebarShortcut(key: string): string {
    return KeyboardHandler.getFormattedParts(key)
        .map((part) => {
            if (part === "Ctrl") return "C"
            if (part === "Win" || part === "⌘") return "M"
            if (part === "Alt" || part === "⌥") return "A"
            if (part === "Shift") return "S"
            return part.length === 1 ? part.toLowerCase() : part
        })
        .join("-")
}

export function buildSidebarNavigationHints(
    nextKeymap: string | string[] | undefined,
    previousKeymap: string | string[] | undefined,
    inputFocused: boolean,
): SidebarShortcutPair[] {
    const filter = (key: string) => !inputFocused || isSidebarShortcutInputSafe(key)
    const nextKeys = toKeys(nextKeymap).filter(filter)
    const previousKeys = toKeys(previousKeymap).filter(filter)

    return nextKeys.flatMap((nextKey, index) => {
        const previousKey = previousKeys[index]
        return previousKey
            ? [
                  {
                      display: `${formatSidebarShortcut(nextKey)}/${formatSidebarShortcut(previousKey)}`,
                  },
              ]
            : []
    })
}

export function findSidebarShortcut(
    keymap: string | string[] | undefined,
    expected: string,
): string {
    const normalizedExpected = KeyboardHandler.normalize(expected)
    const match = toKeys(keymap).find(
        (key) => KeyboardHandler.normalize(key) === normalizedExpected,
    )
    return formatSidebarShortcut(match ?? expected)
}
