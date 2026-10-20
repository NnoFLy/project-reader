type HighlightContributions = Map<object, Map<string, readonly Range[]>>
const registries = new WeakMap<HighlightRegistry, HighlightContributions>()

function publish(registry: HighlightRegistry, owners: HighlightContributions, name: string): void {
    const ranges = [...owners.values()].flatMap((values) => values.get(name) ?? [])
    if (ranges.length) registry.set(name, new Highlight(...ranges))
    else registry.delete(name)
}

/** CSS highlight names are document-global; each reader contributes and removes only its ranges. */
export function createViewerHighlights() {
    const owner = {}
    let registry: HighlightRegistry | undefined
    const clear = () => {
        if (!registry) return
        const owners = registries.get(registry)
        const values = owners?.get(owner)
        if (owners && values) {
            owners.delete(owner)
            for (const name of values.keys()) publish(registry, owners, name)
        }
        registry = undefined
    }
    return {
        set(name: string, ranges: readonly Range[]) {
            if (typeof CSS === "undefined" || !CSS.highlights || typeof Highlight === "undefined")
                return
            if (registry && registry !== CSS.highlights) clear()
            registry = CSS.highlights
            let owners = registries.get(registry)
            if (!owners) {
                owners = new Map()
                registries.set(registry, owners)
            }
            let values = owners.get(owner)
            if (!values) {
                values = new Map()
                owners.set(owner, values)
            }
            values.set(name, ranges)
            publish(registry, owners, name)
        },
        clear,
    }
}
