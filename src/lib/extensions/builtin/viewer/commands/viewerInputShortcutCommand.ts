import type { AnyCommandDefinition } from "$lib/modules/commands"

export function withViewerInputShortcut(
    command: AnyCommandDefinition,
    keymap: string[],
    disabled: () => boolean,
    shouldHandleKey: (event: KeyboardEvent) => boolean,
): AnyCommandDefinition {
    return {
        ...command,
        keymap,
        allowInInputs: true,
        disabled,
        shouldHandleKey,
    }
}
