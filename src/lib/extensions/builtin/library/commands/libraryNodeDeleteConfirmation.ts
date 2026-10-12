import type { CommandScope } from "./commandsStore.svelte"

export async function confirmLibraryNodeDelete(
    scope: CommandScope | null | undefined,
    nodeId: string,
): Promise<void> {
    await scope?.execute("library.node.delete", { nodeId, confirmed: true })
}
