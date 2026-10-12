import { useCommands } from "$lib/modules/commands"
import { createLibraryCardCommands, type LibraryCardCommandContext } from "./cardEntityCommands"

export function useLibraryCardCommands(context: LibraryCardCommandContext) {
    return useCommands(Object.values(createLibraryCardCommands(context)), undefined, {
        autoActivate: false,
    })
}
