import type { StorageNamespace } from "$lib/extension-api"
export interface ViewerPromptCapability {
    promptStore: any
    getPromptCommandRegistry: () => any
    openCommandPalette: (source?: any, initialQuery?: string) => Promise<void>
}

export interface ViewerLibraryCapability {
    nodes: Record<string, ViewerFileNode | undefined>
    allFiles: readonly ViewerFileNode[]
    fileUrls: Record<string, string>
    isLockedMap: Record<string, boolean>
    initialized: boolean
    isDisposed: boolean
    activeFileId: string | null
    db: any
    getFileUrl(id: string): Promise<string | undefined>
    revokeFileUrl(id: string, url?: string): boolean
    getContentGeneration(id: string): number
    isCurrentContent(id: string, generation: number): boolean
    isCurrentFileUrl(id: string, url: string, generation?: number): boolean
    onNodesDeleted(listener: (ids: string[]) => void): () => void
    onNodesDeleting(listener: (ids: string[]) => void): () => void
    onNodeRelinked(listener: (id: string) => void): () => void
    onContentRestored(listener: (id: string) => void): () => void
    onNodeInvalidated(listener: (id: string) => void): () => void
    isNodeDeleting(id: string): boolean
    serializeBookMutation<T>(id: string, mutation: () => Promise<T>): Promise<T | undefined>
    serializeMetadataMutation<T>(mutation: () => Promise<T>): Promise<T | undefined>
    saveIndexedTexts(id: string, records: unknown[], generation?: number): Promise<boolean>
    updateFile(
        id: string,
        changes: Record<string, unknown>,
        ...options: unknown[]
    ): Promise<unknown>
    pushForwardHistory(id: string | null): void
    clearForwardHistory(): void
    getFolderPath(id: string): string
    getPreviewUrl(id: string): Promise<string>
    revokePreviewUrl(id: string): void
    invalidatePreview(id: string): Promise<void>
}
export type Bookmark = {
    id: string
    bookId: string
    pageNumber: number
    name: string
    createdAt: number
}
export type UserNote = {
    id: string
    bookId: string
    pageNumber: number
    start: number
    end: number
    text: string
    noteContent: string
    color: "yellow" | "green" | "blue" | "pink" | "purple"
    createdAt: number
}

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
let installedLibrary: ViewerLibraryCapability | undefined
let viewerStorage: StorageNamespace | undefined
let installedPrompt: ViewerPromptCapability | undefined

export const viewerFileCapability = new Proxy(unavailable, {
    get: (_, key: keyof ViewerFileCapability) => installed[key],
}) as ViewerFileCapability

/** The canonical library capability configured by builtin activation. */
export const viewerLibraryCapability = new Proxy({} as ViewerLibraryCapability, {
    get: (_, key: keyof ViewerLibraryCapability) => {
        if (!installedLibrary) throw new Error("The viewer library capability is unavailable")
        const value = installedLibrary[key]
        return typeof value === "function" ? value.bind(installedLibrary) : value
    },
    set: (_, key: keyof ViewerLibraryCapability, value: unknown) => {
        if (!installedLibrary) throw new Error("The viewer library capability is unavailable")
        Reflect.set(installedLibrary, key, value)
        return true
    },
}) as ViewerLibraryCapability

export function isViewerLibraryCapabilityInstalled(): boolean {
    return installedLibrary !== undefined
}

export function getViewerLibraryCapability(): ViewerLibraryCapability | undefined {
    return installedLibrary
}

/** Injects host file access, library state, and namespaced storage at activation time. */
export const viewerPromptCapability = new Proxy({} as ViewerPromptCapability, {
    get: (_, key: keyof ViewerPromptCapability) => {
        if (!installedPrompt) throw new Error("The viewer prompt capability is unavailable")
        return installedPrompt[key]
    },
}) as ViewerPromptCapability

export function installViewerHostCapabilities(capabilities: {
    files?: ViewerFileCapability
    library?: ViewerLibraryCapability
    storage?: StorageNamespace
    prompt?: ViewerPromptCapability
}): void {
    installed = capabilities.files ?? unavailable
    installedLibrary = capabilities.library
    viewerStorage = capabilities.storage
    installedPrompt = capabilities.prompt
}

export function getViewerStorage(): StorageNamespace | undefined {
    return viewerStorage
}
