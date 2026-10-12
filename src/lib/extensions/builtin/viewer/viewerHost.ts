import type { CommandRegistry, StorageNamespace } from "$lib/extension-api"
import type { CommandScope } from "$lib/modules/commands"
import type { PromptService } from "$lib/modules/prompt"

export interface ViewerPromptCapability {
    promptStore: PromptService
    getPromptCommandRegistry: () => CommandRegistry | undefined
    openCommandPalette: (
        source?: CommandScope | CommandRegistry,
        initialQuery?: string,
    ) => Promise<void>
}

export interface ViewerLibraryCapability {
    readonly nodes: Readonly<Record<string, ViewerFileNode | undefined>>
    readonly allFiles: readonly ViewerFileNode[]
    readonly fileUrls: Readonly<Record<string, string>>
    readonly isLockedMap: Readonly<Record<string, boolean>>
    readonly initialized: boolean
    readonly isDisposed: boolean
    getFileUrl(id: string): Promise<string | undefined>
    getContentGeneration(id: string): number
    isCurrentContent(id: string, generation: number): boolean
    isCurrentFileUrl(id: string, url: string, generation?: number): boolean
    onNodesDeleted(listener: (ids: string[]) => void): () => void
    onNodesDeleting(listener: (ids: string[]) => void): () => void
    onNodeRelinked(listener: (id: string) => void): () => void
    onContentRestored(listener: (id: string) => void): () => void
    onNodeInvalidated(listener: (id: string) => void): () => void
    isNodeDeleting(id: string): boolean
    getIndexedTexts(bookId: string): Promise<readonly IndexedText[]>
    getUserNotes(bookId: string): Promise<readonly UserNote[]>
    getBookmarks(): Promise<readonly Bookmark[]>
    getPreviewUrl(id: string): Promise<string>
    getFolderPath(id: string): string
}

/** Viewer writes are explicitly separate from the read-only library state capability. */
export interface ViewerLibraryMutationCapability {
    revokeFileUrl(id: string, url?: string): boolean
    setActiveFileId(id: string | null): void
    serializeBookMutation<T>(id: string, mutation: () => Promise<T>): Promise<T | undefined>
    serializeMetadataMutation<T>(mutation: () => Promise<T>): Promise<T | undefined>
    saveIndexedTexts(id: string, records: unknown[], generation?: number): Promise<boolean>
    putUserNote(note: UserNote): Promise<string>
    deleteUserNote(id: string): Promise<void>
    putBookmark(bookmark: Bookmark): Promise<string>
    deleteBookmark(id: string): Promise<void>
    deleteBookmarks(ids: string[]): Promise<void>
    revokePreviewUrl(id: string): void
    invalidatePreview(id: string): Promise<void>
    updateFile(
        id: string,
        changes: Record<string, unknown>,
        ...options: unknown[]
    ): Promise<unknown>
    pushForwardHistory(id: string | null): void
    clearForwardHistory(): void
}

export type IndexedText = {
    id: string
    bookId: string
    pageNumber: number
    text: string
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
let installedLibraryMutations: ViewerLibraryMutationCapability | undefined
let viewerStorage: StorageNamespace | undefined
let installedPrompt: ViewerPromptCapability | undefined

export const viewerFileCapability = new Proxy(unavailable, {
    get: (_, key: keyof ViewerFileCapability) => installed[key],
}) as ViewerFileCapability

/** The canonical read-only library capability configured by builtin activation. */
export const viewerLibraryCapability = new Proxy({} as ViewerLibraryCapability, {
    get: (_, key: keyof ViewerLibraryCapability) => {
        if (!installedLibrary) throw new Error("The viewer library capability is unavailable")
        const value = installedLibrary[key]
        return typeof value === "function" ? value.bind(installedLibrary) : value
    },
}) as ViewerLibraryCapability

/** The only library mutations available to the viewer. */
export const viewerLibraryMutationCapability = new Proxy({} as ViewerLibraryMutationCapability, {
    get: (_, key: keyof ViewerLibraryMutationCapability) => {
        if (!installedLibraryMutations)
            throw new Error("The viewer library mutation capability is unavailable")
        const value = installedLibraryMutations[key]
        return typeof value === "function" ? value.bind(installedLibraryMutations) : value
    },
}) as ViewerLibraryMutationCapability

export function isViewerLibraryCapabilityInstalled(): boolean {
    return installedLibrary !== undefined
}

export function getViewerLibraryCapability(): ViewerLibraryCapability | undefined {
    return installedLibrary
}

export function getViewerLibraryMutationCapability(): ViewerLibraryMutationCapability | undefined {
    return installedLibraryMutations
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
    libraryMutations?: ViewerLibraryMutationCapability
    storage?: StorageNamespace
    prompt?: ViewerPromptCapability
}): void {
    installed = capabilities.files ?? unavailable
    installedLibrary = capabilities.library
    installedLibraryMutations = capabilities.libraryMutations
    viewerStorage = capabilities.storage
    installedPrompt = capabilities.prompt
}

export function getViewerStorage(): StorageNamespace | undefined {
    return viewerStorage
}
