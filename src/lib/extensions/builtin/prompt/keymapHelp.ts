export interface KeymapHelpSource {
    label: string
    englishLabel?: string
    keymap?: string | string[]
}

export interface KeymapHelpItem {
    keys: string | string[]
    description: string
    englishDescription?: string
}

export function buildKeymapHelpItems(
    bindings: KeymapHelpSource[],
    normalizeKey: (key: string) => string,
): KeymapHelpItem[] {
    const seen = new Set<string>()
    const items: KeymapHelpItem[] = []

    for (const binding of bindings) {
        if (!binding.label || !binding.keymap) continue
        const keymap = binding.keymap
        const keys = typeof keymap === "string" ? [keymap] : keymap
        const availableKeys = keys.filter((key) => {
            const normalizedKey = normalizeKey(key)
            if (seen.has(normalizedKey)) return false
            seen.add(normalizedKey)
            return true
        })
        if (availableKeys.length === 0) continue
        items.push({
            keys: typeof keymap === "string" ? availableKeys[0] : availableKeys,
            description: binding.label,
            englishDescription: binding.englishLabel,
        })
    }

    return items
}

export function filterKeymapHelpItems(items: KeymapHelpItem[], query: string): KeymapHelpItem[] {
    const normalizedQuery = query.toLowerCase()
    return items.filter(
        (item) =>
            item.description.toLowerCase().includes(normalizedQuery) ||
            item.englishDescription?.toLowerCase().includes(normalizedQuery) ||
            (Array.isArray(item.keys)
                ? item.keys.some((key) => key.toLowerCase().includes(normalizedQuery))
                : item.keys.toLowerCase().includes(normalizedQuery)),
    )
}
