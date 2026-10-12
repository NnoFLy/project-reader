import { useCommands } from "./commandsStore.svelte"
import { createLibraryCardCommands, type LibraryCardCommandContext } from "./cardEntityCommands"

export function useLibraryCardCommands(context: LibraryCardCommandContext) {
    return useCommands(Object.values(createLibraryCardCommands(context)), undefined, {
        autoActivate: false,
    })
}
