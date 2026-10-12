import { defineCommands, type AnyCommandDefinition } from "$lib/modules/commands"

interface ViewerListCommandOptions {
    nextLabel: () => string
    /** English aliases mirror each localized list action. */
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

export function createViewerListCommands(
    options: ViewerListCommandOptions,
): AnyCommandDefinition[] {
    return Object.values(
        defineCommands({
            "viewer.list.next": {
                id: "viewer.list.next",
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
            "viewer.list.previous": {
                id: "viewer.list.previous",
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
            "viewer.list.select": {
                id: "viewer.list.select",
                keymap: "enter",
                label: options.selectLabel,
                englishLabel: options.selectEnglishLabel,
                category: "navigation",
                palette: false,
                disabled: options.disabled,
                run: options.select,
            },
            "viewer.list.search": {
                id: "viewer.list.search",
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
