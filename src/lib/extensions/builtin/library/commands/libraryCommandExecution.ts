import { commandsStore } from "$lib/modules/commands"

/** Svelte-facing typed execution helpers for library controls. */
export async function createLibraryFolder(name: string): Promise<void> {
    await commandsStore.execute("library.folder.create", { name })
}

export async function renameLibraryFolder(nodeId: string, name: string): Promise<void> {
    await commandsStore.execute("library.node.rename", { nodeId, name })
}
