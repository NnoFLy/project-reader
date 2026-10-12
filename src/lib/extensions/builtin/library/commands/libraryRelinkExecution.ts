import { vfsStore } from "$lib/modules/documents"
import { relinkRequest } from "../state/relinkRequest.svelte"
import * as m from "$lib/paraglide/messages"

export async function relinkLibraryNode(
    nodeId: string,
    fileSource: File | FileSystemFileHandle,
): Promise<boolean> {
    const node = vfsStore.nodes[nodeId]
    if (!node || node.type !== "file") return false

    const originalName = node.name
    const newName = fileSource.name
    if (
        originalName &&
        newName &&
        originalName !== newName &&
        !confirm(m.relink_warning({ newName, originalName }))
    ) {
        return false
    }

    try {
        await vfsStore.relinkFile(node.id, fileSource)
        await relinkRequest.complete()
        return true
    } catch (error) {
        console.error("Failed to relink file:", error)
        alert(m.relink_failed())
        return false
    }
}
