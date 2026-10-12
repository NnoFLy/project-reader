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
        const keyString = Array.isArray(binding.keymap)
            ? binding.keymap.map(normalizeKey).join(",")
            : normalizeKey(binding.keymap)
        if (seen.has(keyString)) continue
        seen.add(keyString)
        items.push({
            keys: binding.keymap,
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
