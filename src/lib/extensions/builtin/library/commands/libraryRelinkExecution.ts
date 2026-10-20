import { vfsStore, type VFSStore } from "../state/libraryStore.svelte"
import { relinkRequest, type RelinkRequestState } from "../state/relinkRequest.svelte"
import { getLibraryErrorDiagnostic } from "../state/libraryDiagnostics"
import * as m from "$lib/paraglide/messages"

export async function relinkLibraryNode(
    nodeId: string,
    fileSource: File | FileSystemFileHandle,
    store: VFSStore = vfsStore,
    request: RelinkRequestState = relinkRequest,
): Promise<boolean> {
    const node = store.nodes[nodeId]
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
        await store.relinkFile(node.id, fileSource)
        await request.complete()
        return true
    } catch (error) {
        console.error("Failed to relink file:", getLibraryErrorDiagnostic(error))
        alert(m.relink_failed())
        return false
    }
}
