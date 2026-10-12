import { commandsStore } from "$lib/modules/commands"

export async function updateLibraryBookMetadata(payload: {
    nodeId: string
    name: string
    author: string | null
    pageNumber: number
}): Promise<void> {
    await commandsStore.execute("library.node.edit-metadata", payload)
}
