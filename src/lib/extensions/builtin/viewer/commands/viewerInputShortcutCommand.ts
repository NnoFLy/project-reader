import type { AnyCommandDefinition } from "$lib/extensions/builtin/library/commands/commands.types"

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
