import type {
    HostContext,
    PromptHostCapability,
    SettingsCapability,
    StorageNamespace,
} from "$lib/extension-api"
import type { Bookmark, UserNote } from "$lib/core/documents"
export type { PromptItem, PromptService } from "$lib/extension-api"

export type ViewerPromptCapability = PromptHostCapability
export type ViewerSettingsCapability = SettingsCapability

export interface ViewerLibraryCapability {
    readonly nodes: Readonly<Record<string, ViewerFileNode | undefined>>
    readonly allFiles: readonly ViewerFileNode[]
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
    /** Release the viewer's lease; URL lifetime remains host-owned. */
    releaseFileUrl(id: string, url?: string): boolean
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
export type { Bookmark, UserNote } from "$lib/core/documents"

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
    readonly nodes: Readonly<Record<string, ViewerFileNode | undefined>>
    readonly isLockedMap: Readonly<Record<string, boolean | undefined>>
    getFileUrl(id: string): Promise<string | undefined>
    restoreFileAccess(id: string): Promise<string | undefined>
    /** Ask the host to present its file-relink flow for an inaccessible node. */
    requestRelink(id: string): void
    waitForRelink(id: string): Promise<void>
    /** Release the viewer's lease; URL lifetime remains host-owned. */
    releaseFileUrl(id: string, url: string): boolean
    getContentGeneration(id: string): number
    isCurrentContent(id: string, generation: number): boolean
    isCurrentFileUrl(id: string, url: string, generation?: number): boolean
    clearForwardHistory(): void
}

const unavailable: ViewerFileCapability = {
    nodes: {},
    isLockedMap: {},
    getFileUrl: async () => undefined,
    restoreFileAccess: async () => undefined,
    requestRelink: () => undefined,
    waitForRelink: async () => undefined,
    releaseFileUrl: () => false,
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
let installedSettings: ViewerSettingsCapability | undefined
let installedHost: HostContext | undefined

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
        const prompt = installedPrompt ?? installedHost?.prompt
        if (!prompt) throw new Error("The viewer prompt capability is unavailable")
        return prompt[key]
    },
}) as ViewerPromptCapability

export function installViewerHostCapabilities(capabilities: {
    files?: ViewerFileCapability
    library?: ViewerLibraryCapability
    libraryMutations?: ViewerLibraryMutationCapability
    storage?: StorageNamespace
    prompt?: ViewerPromptCapability
    settings?: ViewerSettingsCapability
    host?: HostContext
}): void {
    installed = capabilities.files ?? unavailable
    installedLibrary = capabilities.library
    installedLibraryMutations = capabilities.libraryMutations
    viewerStorage = capabilities.storage
    installedPrompt = capabilities.prompt
    installedSettings = capabilities.settings
    installedHost = capabilities.host
}

export const promptStore = new Proxy({} as ViewerPromptCapability["promptStore"], {
    get: (_, key: keyof ViewerPromptCapability["promptStore"]) =>
        viewerPromptCapability.promptStore[key],
}) as ViewerPromptCapability["promptStore"]

export const settingsStore = new Proxy({} as ViewerSettingsCapability["settingsStore"], {
    get: (_, key: keyof ViewerSettingsCapability["settingsStore"]) =>
        viewerSettingsCapability.settingsStore[key],
    set: (_, key: keyof ViewerSettingsCapability["settingsStore"], value: unknown) => {
        Reflect.set(viewerSettingsCapability.settingsStore, key, value)
        return true
    },
}) as ViewerSettingsCapability["settingsStore"]

export const CONSTANTS = new Proxy({} as ViewerSettingsCapability["CONSTANTS"], {
    get: (_, key: keyof ViewerSettingsCapability["CONSTANTS"]) =>
        viewerSettingsCapability.CONSTANTS[key],
}) as ViewerSettingsCapability["CONSTANTS"]
export const DEFAULT_SETTINGS = new Proxy({} as ViewerSettingsCapability["DEFAULT_SETTINGS"], {
    get: (_, key: keyof ViewerSettingsCapability["DEFAULT_SETTINGS"]) =>
        viewerSettingsCapability.DEFAULT_SETTINGS[key],
}) as ViewerSettingsCapability["DEFAULT_SETTINGS"]
export const settingsCommands = new Proxy({} as ViewerSettingsCapability["settingsCommands"], {
    get: (_, key: string) => viewerSettingsCapability.settingsCommands[key],
}) as ViewerSettingsCapability["settingsCommands"]
export const localizedPath = (path: string) => viewerSettingsCapability.localizedPath(path)
export const getLanguageName = (locale: string) => viewerSettingsCapability.getLanguageName(locale)
export const getLocalizedCurrentHref = (
    url: URL,
    locale: ViewerSettingsCapability["DEFAULT_SETTINGS"]["language"],
) => viewerSettingsCapability.getLocalizedCurrentHref(url, locale)
export type Theme = ViewerSettingsCapability["DEFAULT_SETTINGS"]["theme"]
export type AppLocale = ViewerSettingsCapability["DEFAULT_SETTINGS"]["language"]

export const viewerSettingsCapability = new Proxy({} as ViewerSettingsCapability, {
    get: (_, key: keyof ViewerSettingsCapability) => {
        const settings = installedSettings ?? installedHost?.settings
        if (!settings) throw new Error("The viewer settings capability is unavailable")
        return settings[key]
    },
}) as ViewerSettingsCapability

export function getViewerStorage(): StorageNamespace | undefined {
    return viewerStorage
}
