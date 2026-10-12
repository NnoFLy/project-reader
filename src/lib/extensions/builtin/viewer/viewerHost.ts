import type { StorageNamespace } from "$lib/extension-api"

export interface ViewerFileNode {
    id: string
    name: string
    type: "file"
    updatedAt: number
    isLocked?: boolean
    parentId?: string | null
    metadata: {
        pageNumber?: number
        scrollPosition?: number
        pdfDest?: string
        totalPages?: number
        author?: string | null
        [key: string]: unknown
    }
}

export interface ViewerFileCapability {
    nodes: Record<string, ViewerFileNode | undefined>
    fileUrls: Record<string, string | undefined>
    isLockedMap: Record<string, boolean | undefined>
    getFileUrl(id: string): Promise<string | undefined>
    restoreFileAccess(id: string): Promise<string | undefined>
    waitForRelink(id: string): Promise<void>
    revokeFileUrl(id: string, url: string): boolean
    getContentGeneration(id: string): number
    isCurrentContent(id: string, generation: number): boolean
    isCurrentFileUrl(id: string, url: string, generation?: number): boolean
    clearForwardHistory(): void
}

const unavailable: ViewerFileCapability = {
    nodes: {},
    fileUrls: {},
    isLockedMap: {},
    getFileUrl: async () => undefined,
    restoreFileAccess: async () => undefined,
    waitForRelink: async () => undefined,
    revokeFileUrl: () => false,
    getContentGeneration: () => 0,
    isCurrentContent: () => false,
    isCurrentFileUrl: () => false,
    clearForwardHistory: () => undefined,
}

let installed: ViewerFileCapability = unavailable
let viewerStorage: StorageNamespace | undefined

export const viewerFileCapability = new Proxy(unavailable, {
    get: (_, key: keyof ViewerFileCapability) => installed[key],
}) as ViewerFileCapability

/** Injects host file access and the viewer's namespaced storage at activation time. */
export function installViewerHostCapabilities(capabilities: {
    files?: ViewerFileCapability
    storage?: StorageNamespace
}): void {
    if (capabilities.files) installed = capabilities.files
    if (capabilities.storage) viewerStorage = capabilities.storage
}

export function getViewerStorage(): StorageNamespace | undefined {
    return viewerStorage
}
