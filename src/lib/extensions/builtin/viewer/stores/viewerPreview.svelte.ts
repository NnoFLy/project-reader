export interface ViewerPreviewCapability {
    getPreviewUrl(id: string): Promise<string>
    onNodeInvalidated(listener: (id: string) => void): () => void
    revokePreviewUrl(id: string): void
}

export function useViewerPreviewUrl(
    nodeId: () => string,
    getAccess: () => ViewerPreviewCapability | undefined,
) {
    let url = $state("")
    let requestGeneration = 0
    $effect(() => {
        const id = nodeId()
        const access = getAccess()
        requestGeneration++
        if (!id || !access) return
        const load = () => {
            const generation = ++requestGeneration
            void access.getPreviewUrl(id).then((value) => {
                if (generation === requestGeneration) url = value
            })
        }
        const stop = access.onNodeInvalidated((invalidatedId) => {
            if (invalidatedId !== id) return
            url = ""
            access.revokePreviewUrl(id)
            load()
        })
        load()
        return () => {
            requestGeneration++
            stop()
            access.revokePreviewUrl(id)
        }
    })
    return {
        get url() {
            return url
        },
    }
}
