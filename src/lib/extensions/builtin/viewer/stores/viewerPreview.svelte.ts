export interface ViewerPreviewCapability {
    getPreviewUrl(id: string): Promise<string>
    onNodeInvalidated(listener: (id: string) => void): () => void
    revokePreviewUrl(id: string, url: string): void
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
        let acquiredUrl = ""
        const release = () => {
            if (acquiredUrl) access.revokePreviewUrl(id, acquiredUrl)
            acquiredUrl = ""
        }
        const load = () => {
            const generation = ++requestGeneration
            void access
                .getPreviewUrl(id)
                .then((value) => {
                    if (generation === requestGeneration) {
                        acquiredUrl = value
                        url = value
                    } else if (value) access.revokePreviewUrl(id, value)
                })
                .catch(() => undefined)
        }
        const stop = access.onNodeInvalidated((invalidatedId) => {
            if (invalidatedId !== id) return
            url = ""
            release()
            load()
        })
        load()
        return () => {
            requestGeneration++
            stop()
            release()
        }
    })
    return {
        get url() {
            return url
        },
    }
}
