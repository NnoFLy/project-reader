import type { CommandScope } from "$lib/modules/commands"

export async function confirmLibraryNodeDelete(
    scope: CommandScope | null | undefined,
    nodeId: string,
): Promise<void> {
    await scope?.execute("library.node.delete", { nodeId, confirmed: true })
}
