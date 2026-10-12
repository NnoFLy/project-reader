import { useCommands, type CommandScope } from "./commandsStore.svelte"
import type { AnyCommandDefinition } from "./commands.types"

export function useModalCommands(
    definitions: readonly AnyCommandDefinition[],
    parent: CommandScope | null,
): CommandScope {
    return useCommands(definitions, parent, { keyboardBoundary: true })
}
