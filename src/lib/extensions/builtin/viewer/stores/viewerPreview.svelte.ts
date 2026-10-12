import { getViewerLibraryCapability, getViewerLibraryMutationCapability } from "../viewerHost"

export function useViewerPreviewUrl(nodeId: () => string) {
    let url = $state("")
    let requestGeneration = 0
    $effect(() => {
        const id = nodeId()
        const files = getViewerLibraryCapability()
        const mutations = getViewerLibraryMutationCapability()
        requestGeneration++
        if (!id || !files || !mutations) return
        const load = () => {
            const generation = ++requestGeneration
            void files.getPreviewUrl(id).then((value) => {
                if (generation === requestGeneration) url = value
            })
        }
        const stop = files.onNodeInvalidated((invalidatedId) => {
            if (invalidatedId !== id) return
            url = ""
            mutations.revokePreviewUrl(id)
            load()
        })
        load()
        return () => {
            requestGeneration++
            stop()
            mutations.revokePreviewUrl(id)
        }
    })
    return {
        get url() {
            return url
        },
    }
}
