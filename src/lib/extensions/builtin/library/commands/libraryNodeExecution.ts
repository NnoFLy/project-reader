import { type CommandScope, commandsStore } from "$lib/modules/commands"

export async function moveLibraryNodeFromScope(
    scope: CommandScope | null | undefined,
    nodeId: string,
): Promise<void> {
    await scope?.execute("library.node.move", { nodeId })
}

export async function deleteLibraryNodeFromScope(
    scope: CommandScope | null | undefined,
    nodeId: string,
    confirmed = false,
): Promise<void> {
    await scope?.execute("library.node.delete", { nodeId, confirmed })
}

export async function requestLibraryNodeMove(nodeId: string): Promise<void> {
    await commandsStore.execute("library.node.move", { nodeId })
}

export async function requestLibraryNodeDelete(nodeId: string): Promise<void> {
    await commandsStore.execute("library.node.delete", { nodeId })
}
