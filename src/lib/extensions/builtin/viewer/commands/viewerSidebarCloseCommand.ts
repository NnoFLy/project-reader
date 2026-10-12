import { defineCommands, type AnyCommandDefinition } from "$lib/modules/commands"

interface ViewerSidebarCloseCommandOptions {
    label: () => string
    /** English search and keyboard-help alias for the localized label. */
    englishLabel: () => string
    disabled: () => boolean
    shouldHandleKey: (event: KeyboardEvent) => boolean
    close: () => void
}

export function createViewerSidebarCloseCommand(
    options: ViewerSidebarCloseCommandOptions,
): AnyCommandDefinition {
    return defineCommands({
        "viewer.sidebar.close": {
            id: "viewer.sidebar.close",
            keymap: ["escape", "q", "ctrl+c", "ctrl+["],
            label: options.label,
            englishLabel: options.englishLabel,
            category: "navigation",
            allowInInputs: true,
            dismissFocusedElement: true,
            disabled: options.disabled,
            shouldHandleKey: options.shouldHandleKey,
            run: options.close,
        },
    })["viewer.sidebar.close"]!
}
