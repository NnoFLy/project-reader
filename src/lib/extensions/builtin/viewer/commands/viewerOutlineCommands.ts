import { defineCommands, type AnyCommandDefinition } from "$lib/modules/commands"

interface ViewerOutlineCommandOptions {
    nextLabel: () => string
    /** English aliases mirror each localized outline action. */
    nextEnglishLabel: () => string
    previousLabel: () => string
    previousEnglishLabel: () => string
    selectLabel: () => string
    selectEnglishLabel: () => string
    searchLabel: () => string
    searchEnglishLabel: () => string
    disabled: () => boolean
    shouldHandleNavigationKey: (event: KeyboardEvent) => boolean
    next: () => void
    previous: () => void
    select: () => void
    search: () => void
}

export function createViewerOutlineCommands(
    options: ViewerOutlineCommandOptions,
): AnyCommandDefinition[] {
    return Object.values(
        defineCommands({
            "viewer.outline.next": {
                id: "viewer.outline.next",
                keymap: ["j", "arrowdown", "ctrl+n", "ctrl+j"],
                label: options.nextLabel,
                englishLabel: options.nextEnglishLabel,
                category: "navigation",
                palette: false,
                allowInInputs: true,
                disabled: options.disabled,
                shouldHandleKey: options.shouldHandleNavigationKey,
                run: options.next,
            },
            "viewer.outline.previous": {
                id: "viewer.outline.previous",
                keymap: ["k", "arrowup", "ctrl+p", "ctrl+k"],
                label: options.previousLabel,
                englishLabel: options.previousEnglishLabel,
                category: "navigation",
                palette: false,
                allowInInputs: true,
                disabled: options.disabled,
                shouldHandleKey: options.shouldHandleNavigationKey,
                run: options.previous,
            },
            "viewer.outline.select": {
                id: "viewer.outline.select",
                keymap: "enter",
                label: options.selectLabel,
                englishLabel: options.selectEnglishLabel,
                category: "navigation",
                palette: false,
                disabled: options.disabled,
                run: options.select,
            },
            "viewer.outline.search": {
                id: "viewer.outline.search",
                keymap: "/",
                label: options.searchLabel,
                englishLabel: options.searchEnglishLabel,
                category: "commands",
                palette: false,
                disabled: options.disabled,
                run: options.search,
            },
        }),
    ).filter(Boolean) as AnyCommandDefinition[]
}
