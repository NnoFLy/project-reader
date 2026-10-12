import { browser } from "$app/environment"
import { SvelteSet } from "svelte/reactivity"
import type {
    FolderNode,
    FileNode,
    VFSNodes,
    VFSNode,
    BookMetadata,
    BookPreview,
    FileContent,
    IndexedText,
    ImportCallbacks,
    ImportInput,
    ImportJob,
    ImportResult,
} from "./libraryStore.types"
import { FolderNameError } from "./libraryStore.types"
import { LibraryStorage } from "./libraryStorage"
import type { ExtensionStorage, StorageNamespace } from "$lib/extension-api"
import { createBlobDocumentSource, DOCUMENT_SOURCE_LIMITS } from "$lib/core/files"
import type {
    DocumentSource,
    OpenedDocument,
    PagedDocument,
    RenderedPage,
} from "$lib/document-model"
import pLimit from "p-limit"
import { getLibraryErrorDiagnostic } from "./libraryDiagnostics"

/** The host-owned document capability shared with the viewer. */
export interface VfsDocumentService {
    open(source: DocumentSource, signal?: AbortSignal): Promise<OpenedDocument>
    close(document: OpenedDocument): Promise<void>
}

let installedDocumentService: VfsDocumentService | undefined
const documentServices = new WeakMap<object, VfsDocumentService>()

/** Install the canonical host capability before VFS documents are opened. */
export function installDocumentService(service: VfsDocumentService | undefined): void {
    installedDocumentService = service
}

function isDocumentResourceLimitError(error: unknown): boolean {
    return (
        error instanceof Error &&
        (error.name === "PDFResourceLimitError" || error.name === "DocumentSourceLimitError")
    )
}

function getDocumentService(): VfsDocumentService {
    if (!installedDocumentService) {
        throw new Error("The application document service has not been installed")
    }
    return installedDocumentService
}

async function openDocument(source: DocumentSource): Promise<OpenedDocument> {
    const service = await getDocumentService()
    let document: OpenedDocument
    try {
        document = await service.open(source)
    } catch (error) {
        // Keep adapter diagnostics (including resource-limit names) visible to VFS while
        // retaining DocumentService as the owner of adapter selection and lifecycle.
        if (error instanceof Error && error.cause instanceof Error) throw error.cause
        throw error
    }
    // The service remains responsible for the document's complete discriminated union. Keep
    // the capability paired with every opened document so callers can close either kind.
    documentServices.set(document, service)
    return document
}

async function openBlobDocument(blob: Blob, id: string, name: string): Promise<OpenedDocument> {
    return openDocument(
        createBlobDocumentSource({ id, name, blob, mimeType: blob.type || undefined }),
    )
}

async function openUrlDocument(url: string, id: string, name: string): Promise<OpenedDocument> {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Failed to read document source (${response.status})`)
    const blob = await response.blob()
    return openBlobDocument(blob, id, name)
}

async function closeDocument(document: OpenedDocument | null | undefined): Promise<void> {
    if (!document) return
    const service = documentServices.get(document)
    if (service) {
        await service.close(document)
        documentServices.delete(document)
    } else {
        await document.close()
    }
}

function validateRenderBounds(document: PagedDocument): Promise<void> {
    const candidate = document as PagedDocument & {
        validateRenderBounds?: () => Promise<void>
    }
    return candidate.validateRenderBounds?.() ?? Promise.resolve()
}

async function getDocumentDetails(document: PagedDocument): Promise<{
    pageCount: number
    author: string | null
    title: string | null
}> {
    const metadata = document.metadata
    if (metadata) {
        return {
            pageCount: metadata.pageCount ?? document.pageCount,
            author: metadata.author ?? null,
            title: typeof metadata.title === "string" ? metadata.title : null,
        }
    }
    const legacy = document as PagedDocument & {
        getPageNumber?: () => Promise<number>
        getAuthor?: () => Promise<string | null>
        getTitle?: () => Promise<string | null>
    }
    return {
        pageCount: document.pageCount ?? (await legacy.getPageNumber?.()) ?? 0,
        author: (await legacy.getAuthor?.()) ?? null,
        title: (await legacy.getTitle?.()) ?? null,
    }
}

async function renderDocumentPage(
    document: PagedDocument,
    pageNumber: number,
): Promise<RenderedPage> {
    if (document.renderPage) return document.renderPage(pageNumber)
    const legacy = document as PagedDocument & {
        getPage: (page: number) => Promise<unknown>
        getCanvasPage?: (page: unknown) => Promise<string>
    }
    if (!legacy.getCanvasPage) throw new Error("Document does not support page rendering")
    return {
        pageNumber,
        url: await legacy.getCanvasPage(await legacy.getPage(pageNumber)),
        width: 0,
        height: 0,
        mimeType: "image/unknown",
    }
}

interface ImportGenerations {
    content: number
    preview: number
    request: number
    relinkEpoch: number
    relinkOwner: number
    document: OpenedDocument | null
    tempUrl: string
}

type PersistImportResult = ImportGenerations | { rejected: true } | null

type ResourceRollbackOutcome = "rolled-back" | "superseded" | "pending"
type ResourceCleanupMarkerResult = "marked" | "superseded" | "failed"

type FileUrlOwner = "viewer" | "temporary"

interface FileUrlOwnership {
    url: string
    // Each viewer claim is an independent lease. A failed restore must release only
    // the lease it acquired, not the claims held by concurrent restores/viewers.
    viewer: number
    temporary: number
}

export class ContentSupersededError extends Error {
    constructor(message = "File content changed while restoring access") {
        super(message)
        this.name = "ContentSupersededError"
    }
}

export class VFSDisposedError extends Error {
    constructor() {
        super("VFS store was disposed")
        this.name = "VFSDisposedError"
    }
}

interface FileUrlRequest {
    promise: Promise<string>
    requestPermission: boolean
    accessAttempt: number
}

export class VFSStore {
    nodes = $state<VFSNodes>({})
    rootIds = $state<string[]>([])
    selectedId = $state<string | null>(null)
    selectedIds = new SvelteSet<string>()
    activeFileId = $state<string | null>(null)
    currentFolderId = $state<string | null>(null)
    forwardHistory = $state<string[]>([])
    initialized = $state<boolean>(false)
    db: LibraryStorage
    importJobs = $state<ImportJob[]>([])

    activeImportCount = $derived(this.importJobs.filter((job) => job.stage !== "failed").length)

    // Compatibility alias for status/UI call sites while the import-job model is adopted.
    uploadingFiles = $derived(this.importJobs.filter((job) => job.stage !== "failed"))

    // Transient Object URLs managed lazily
    previewUrls = $state<Record<string, string>>({})
    fileUrls = $state<Record<string, string>>({})
    isLockedMap = $state<Record<string, boolean>>({})

    allFiles = $derived(
        Object.values(this.nodes).filter((node) => node.type === "file") as FileNode[],
    )

    currentFolderDescendantIds = $derived.by(() => {
        const targetFolderId = this.currentFolderId
        if (targetFolderId === null) return new Set<string>()

        const descendantIds = new Set<string>()
        const stack = [targetFolderId]
        while (stack.length > 0) {
            const id = stack.pop()!
            const node = this.nodes[id]
            if (node && node.type === "folder") {
                for (const childId of node.childrenIds) {
                    descendantIds.add(childId)
                    stack.push(childId)
                }
            }
        }
        return descendantIds
    })

    private nativeFiles = new Map<string, File | Blob>()
    private nativeHandles = new Map<string, FileSystemFileHandle>()
    private importSources = new Map<string, File | FileSystemFileHandle>()
    private previewUrlRefs: Record<string, number> = {}
    private previewUrlRequests = new Map<string, Promise<string>>()
    private previewInvalidationTails = new Map<string, Promise<void>>()
    private previewRequestVersions = new Map<string, number>()
    private fileUrlRequests = new Map<string, FileUrlRequest>()
    private fileUrlOwnership = new Map<string, FileUrlOwnership>()
    private accessAttemptGenerations = new Map<string, number>()
    private contentRetryVersions = new Map<string, number>()
    private contentGenerations = new Map<string, number>()
    private successfulAccessAttempts = new Map<string, { generation: number; attempt: number }>()
    private previewGenerations = new Map<string, number>()
    private deletingFileIds = new Set<string>()
    private relinkingCounts = new Map<string, number>()
    private relinkEpochs = new Map<string, number>()
    // The epoch that currently owns the in-memory content generation. Relink epochs remain
    // monotonic, while this owner lets a failed older operation roll back only its own state.
    private relinkStateOwners = new Map<string, number>()
    private relinkRetryEpochs = new Map<string, number>()
    private committedRelinks = new Set<string>()
    private restoredRelinks = new Set<string>()
    private persistenceQueue = pLimit(1)
    private activeSourceTasks = new Set<Promise<unknown>>()
    private activeRelinkTasks = new Set<Promise<unknown>>()
    private activeNodeMutations = new Set<Promise<unknown>>()
    private nodeMutationTail: Promise<void> | undefined
    private readonly nodeDeletionStartingListeners = new Set<(ids: string[]) => void>()
    private readonly nodeDeletionListeners = new Set<(ids: string[]) => void>()
    private readonly deletionWaiters = new Map<string, Set<() => void>>()
    private readonly nodeInvalidatedListeners = new Set<(id: string) => void>()
    private readonly contentRestoredListeners = new Set<(id: string) => void>()
    private readonly nodeRelinkedListeners = new Set<(id: string) => void>()
    private readonly relinkWaiters = new Map<string, Set<() => void>>()
    metadataQueue = pLimit(1)
    private initializationPromise: Promise<void> | null = null
    private metadataEnrichmentOwners = 0
    private disposed = false
    private readonly disposalPromise: Promise<void>
    private disposalCompletion: Promise<void> | null = null
    private resolveDisposal!: () => void
    private metadataEnrichmentController: AbortController | null = null
    private metadataEnrichmentTask: Promise<void> | null = null
    private metadataEnrichmentIdleId: number | null = null
    private activeMetadataDocument: OpenedDocument | null = null
    private readonly pendingResourceRollbacks = new Map<
        string,
        { generations: ImportGenerations; parentId: string | null }
    >()
    private readonly resourceRollbackRetryTimers = new Map<string, ReturnType<typeof setTimeout>>()
    private readonly resourceRollbackRetryTasks = new Set<Promise<unknown>>()
    private readonly resourceRollbackTasks = new Set<Promise<unknown>>()
    private readonly resourceOperationTasks = new Set<Promise<unknown>>()
    private readonly resourceRollbackRetryAttempts = new Map<string, number>()
    private readonly resourceCleanupMarkers = new Set<string>()
    private readonly resourceCleanupFailures = new Map<string, unknown>()
    private readonly handleMetadataVisibilityChange = () => {
        if (document.visibilityState === "hidden") this.pauseMetadataEnrichment()
        else if (this.metadataEnrichmentOwners > 0) this.scheduleMetadataEnrichment()
    }

    constructor(initialNodes: VFSNodes = {}, storage?: StorageNamespace) {
        this.db = new LibraryStorage(storage ?? new MemoryLibraryStorageNamespace())
        this.disposalPromise = new Promise<void>((resolve) => {
            this.resolveDisposal = resolve
        })
        this.nodes = initialNodes
        this.rootIds = Object.values(initialNodes)
            .filter((node) => node.parentId === null)
            .map((node) => node.id)
    }

    onNodesDeleting(listener: (ids: string[]) => void): () => void {
        this.nodeDeletionStartingListeners.add(listener)
        return () => this.nodeDeletionStartingListeners.delete(listener)
    }

    onNodesDeleted(listener: (ids: string[]) => void): () => void {
        this.nodeDeletionListeners.add(listener)
        return () => this.nodeDeletionListeners.delete(listener)
    }

    onNodeInvalidated(listener: (id: string) => void): () => void {
        this.nodeInvalidatedListeners.add(listener)
        return () => this.nodeInvalidatedListeners.delete(listener)
    }

    onContentRestored(listener: (id: string) => void): () => void {
        this.contentRestoredListeners.add(listener)
        return () => this.contentRestoredListeners.delete(listener)
    }

    onNodeRelinked(listener: (id: string) => void): () => void {
        this.nodeRelinkedListeners.add(listener)
        return () => this.nodeRelinkedListeners.delete(listener)
    }

    private trackSourceTask<T>(task: Promise<T>): Promise<T> {
        this.activeSourceTasks.add(task)
        void task.then(
            () => this.activeSourceTasks.delete(task),
            () => this.activeSourceTasks.delete(task),
        )
        return task
    }

    get isDisposed(): boolean {
        return this.disposed
    }

    private throwIfDisposed(): void {
        if (this.disposed) throw new VFSDisposedError()
    }

    private async awaitUnlessDisposed<T>(promise: Promise<T>): Promise<T> {
        this.throwIfDisposed()
        return Promise.race([
            promise,
            this.disposalPromise.then(() => {
                throw new VFSDisposedError()
            }),
        ])
    }

    private async awaitResourceOperation<T>(
        promise: Promise<T>,
        onResourceLimit?: () => void,
    ): Promise<T> {
        const observed = promise.catch((error: unknown) => {
            if (isDocumentResourceLimitError(error)) onResourceLimit?.()
            throw error
        })
        let task: Promise<T>
        task = observed.finally(() => this.resourceOperationTasks.delete(task))
        this.resourceOperationTasks.add(task)
        return this.awaitUnlessDisposed(task)
    }

    private serializeNodeMutation<T>(mutation: () => Promise<T>): Promise<T> {
        const predecessor = this.nodeMutationTail
        const result = (async () => {
            this.throwIfDisposed()
            if (predecessor) await this.awaitUnlessDisposed(predecessor)
            this.throwIfDisposed()
            return mutation()
        })()
        const tail = result.then(
            () => undefined,
            () => undefined,
        )
        this.nodeMutationTail = tail
        this.activeNodeMutations.add(result)
        void result.then(
            () => this.activeNodeMutations.delete(result),
            () => this.activeNodeMutations.delete(result),
        )
        void tail.then(() => {
            if (this.nodeMutationTail === tail) this.nodeMutationTail = undefined
        })
        return result
    }

    serializeBookMutation<T>(bookId: string, mutation: () => Promise<T>): Promise<T | undefined> {
        return this.serializeNodeMutation(async () => {
            if (this.deletingFileIds.has(bookId) || this.nodes[bookId]?.type !== "file") {
                return undefined
            }
            this.throwIfDisposed()
            const result = await this.awaitUnlessDisposed(mutation())
            this.throwIfDisposed()
            return result
        })
    }

    /**
     * Serializes metadata-only mutations with node deletion and other VFS mutations.
     * Unlike serializeBookMutation, this remains usable after an orphaned record's file
     * node has disappeared.
     */
    serializeMetadataMutation<T>(mutation: () => Promise<T>): Promise<T | undefined> {
        return this.serializeNodeMutation(async () => {
            this.throwIfDisposed()
            const result = await mutation()
            this.throwIfDisposed()
            return result
        })
    }

    saveIndexedTexts(
        bookId: string,
        records: IndexedText[],
        expectedGeneration = this.contentGeneration(bookId),
    ): Promise<boolean> {
        return this.serializeNodeMutation(async () => {
            if (
                this.deletingFileIds.has(bookId) ||
                this.nodes[bookId]?.type !== "file" ||
                !this.isCurrentContent(bookId, expectedGeneration)
            )
                return false
            await this.awaitUnlessDisposed(this.db.indexedTexts.bulkPut(records))
            return this.isCurrentContent(bookId, expectedGeneration)
        })
    }

    /** Viewer-scoped metadata access; the database tables stay private to the library. */
    getIndexedTexts(bookId: string): Promise<IndexedText[]> {
        return this.db.indexedTexts.getByBookId(bookId)
    }

    getUserNotes(bookId: string): Promise<import("./libraryStore.types").UserNote[]> {
        return this.db.userNotes.getByBookId(bookId)
    }

    getBookmarks(): Promise<import("./libraryStore.types").Bookmark[]> {
        return this.db.bookmarks.getAll()
    }

    putUserNote(note: import("./libraryStore.types").UserNote): Promise<string> {
        return this.db.userNotes.put(note)
    }

    deleteUserNote(id: string): Promise<void> {
        return this.db.userNotes.delete(id)
    }

    putBookmark(bookmark: import("./libraryStore.types").Bookmark): Promise<string> {
        return this.db.bookmarks.put(bookmark)
    }

    deleteBookmark(id: string): Promise<void> {
        return this.db.bookmarks.delete(id)
    }

    deleteBookmarks(ids: string[]): Promise<void> {
        return this.db.bookmarks.bulkDelete(ids)
    }

    pushForwardHistory(id: string | null) {
        if (id) {
            this.forwardHistory.push(id)
        }
    }

    popForwardHistory(): string | undefined {
        return this.forwardHistory.pop()
    }

    clearForwardHistory() {
        this.forwardHistory = []
    }

    currentNodes = $derived.by(() => {
        const ids =
            this.currentFolderId === null
                ? this.rootIds
                : (this.nodes[this.currentFolderId] as FolderNode)?.childrenIds || []
        return ids.map((id) => this.nodes[id]).filter(Boolean)
    })

    sortedCurrentNodes = $derived.by(() => {
        const rank = (node: VFSNode) => (node.isPinned ? 0 : 2) + (node.type === "file" ? 1 : 0)
        return [...this.currentNodes].sort((a, b) => {
            const rankDifference = rank(a) - rank(b)
            return rankDifference || b.updatedAt - a.updatedAt
        })
    })

    toggleSelection(id: string) {
        if (this.selectedIds.has(id)) {
            this.selectedIds.delete(id)
        } else {
            this.selectedIds.add(id)
        }
    }

    clearSelection() {
        this.selectedIds.clear()
    }

    selectAll(ids: string[]) {
        for (const id of ids) {
            this.selectedIds.add(id)
        }
    }

    private async markResourceCleanupPending(
        id: string,
        generations: ImportGenerations,
    ): Promise<ResourceCleanupMarkerResult> {
        const writeMarker = async (): Promise<ResourceCleanupMarkerResult> =>
            this.db.transaction("rw", ["books"], async () => {
                const persisted = await this.db.files.get(id)
                if (
                    !persisted ||
                    this.contentGeneration(id) !== generations.content ||
                    (this.relinkStateOwners.get(id) ?? 0) !== generations.relinkOwner
                ) {
                    return "superseded"
                }
                await this.db.files.put({ ...persisted, cleanupPending: "resource-limit" })
                const current = this.nodes[id]
                if (
                    current?.type === "file" &&
                    this.contentGeneration(id) === generations.content &&
                    (this.relinkStateOwners.get(id) ?? 0) === generations.relinkOwner
                ) {
                    this.nodes[id] = {
                        ...$state.snapshot(current),
                        cleanupPending: "resource-limit",
                    }
                }
                return "marked"
            })

        // Relinks use the node mutation queue too. Serializing live marker writes prevents an
        // older cleanup transaction from overwriting a newer relink after its ownership check.
        return this.disposed ? writeMarker() : this.serializeNodeMutation(writeMarker)
    }

    private async persistResourceCleanupMarker(
        id: string,
        generations: ImportGenerations,
    ): Promise<ResourceCleanupMarkerResult> {
        for (let attempt = 0; attempt < 5; attempt += 1) {
            try {
                const result = await this.markResourceCleanupPending(id, generations)
                if (result === "superseded") return result
                // Keep compatibility with injected/test marker implementations that return
                // void after a successful write.
                this.resourceCleanupMarkers.add(id)
                this.resourceCleanupFailures.delete(id)
                return "marked"
            } catch (error) {
                if (attempt === 4) {
                    this.resourceCleanupFailures.set(id, error)
                    console.error(
                        `[VFSStore] Failed to persist pending cleanup marker for ${id}:`,
                        getLibraryErrorDiagnostic(error),
                    )
                } else {
                    await new Promise<void>((resolve) =>
                        setTimeout(resolve, Math.min(100 * 2 ** attempt, 1600)),
                    )
                }
            }
        }

        return "failed"
    }

    private async cleanupPersistedResourceLimitedFile(id: string): Promise<boolean> {
        try {
            await this.db.transaction(
                "rw",
                [
                    "books",
                    "folders",
                    "previews",
                    "fileContents",
                    "indexedTexts",
                    "userNotes",
                    "bookmarks",
                ],
                async () => {
                    const persisted = await this.db.files.get(id)
                    if (!persisted) return
                    await this.db.files.delete(id)
                    await this.db.previews.delete(id)
                    await this.db.fileContents.delete(id)
                    await this.db.indexedTexts.deleteByBookId(id)
                    await this.db.userNotes.deleteByBookId(id)
                    await this.db.bookmarks.deleteByBookId(id)
                    if (persisted.parentId !== null) {
                        const parent = await this.db.folders.get(persisted.parentId)
                        if (parent) {
                            await this.db.folders.put({
                                ...parent,
                                childrenIds: parent.childrenIds.filter((childId) => childId !== id),
                            })
                        }
                    }
                },
            )
            return true
        } catch (error) {
            console.error(
                `[VFSStore] Failed to clean up resource-limited file ${id}:`,
                getLibraryErrorDiagnostic(error),
            )
            return false
        }
    }

    init(): Promise<void> {
        if (!browser || this.initialized) return Promise.resolve()
        if (this.initializationPromise) return this.initializationPromise

        const initialization = this.serializeNodeMutation(async () => {
            try {
                this.throwIfDisposed()
                // Read and publish the startup snapshot as one serialized mutation. This keeps
                // imports and other node mutations from being overwritten by a late snapshot.
                const [allFolders, allFiles] = await this.awaitUnlessDisposed(
                    Promise.all([this.db.folders.getAll(), this.db.files.getAll()]),
                )
                this.throwIfDisposed()

                const newNodes: VFSNodes = {}
                const lockedMap: Record<string, boolean> = {}
                const cleanedResourceIds = new Set<string>()
                for (const folder of allFolders) newNodes[folder.id] = folder
                for (const fileNode of allFiles) {
                    if (fileNode.cleanupPending === "resource-limit") {
                        const cleaned = await this.cleanupPersistedResourceLimitedFile(fileNode.id)
                        if (!cleaned) {
                            throw new Error(
                                `Failed to clean up resource-limited file ${fileNode.id}`,
                            )
                        }
                        cleanedResourceIds.add(fileNode.id)
                        continue
                    }
                    const normalizedFile = { ...fileNode, isLocked: fileNode.isLocked ?? true }
                    newNodes[fileNode.id] = normalizedFile
                    lockedMap[fileNode.id] = normalizedFile.isLocked
                }

                for (const folder of allFolders) {
                    if (cleanedResourceIds.size > 0) {
                        newNodes[folder.id] = {
                            ...folder,
                            childrenIds: folder.childrenIds.filter(
                                (childId) => !cleanedResourceIds.has(childId),
                            ),
                        }
                    }
                }

                this.throwIfDisposed()
                this.nodes = newNodes
                this.isLockedMap = lockedMap
                this.rootIds = Object.values(newNodes)
                    .filter((node) => node.parentId === null)
                    .map((node) => node.id)
                this.initialized = true
            } catch (error) {
                this.initialized = false
                if (error instanceof VFSDisposedError) return
                console.error("VFS initialization failed:", getLibraryErrorDiagnostic(error))
                throw error
            }
        }).catch((error: unknown) => {
            if (error instanceof VFSDisposedError) return
            throw error
        })

        this.initializationPromise = initialization
        void initialization.then(
            () => {
                if (this.initializationPromise === initialization) this.initializationPromise = null
            },
            () => {
                if (this.initializationPromise === initialization) this.initializationPromise = null
            },
        )
        return initialization
    }

    acquireMetadataEnrichment(): () => void {
        if (!browser) return () => undefined
        this.metadataEnrichmentOwners += 1
        if (this.metadataEnrichmentOwners === 1) {
            document.addEventListener("visibilitychange", this.handleMetadataVisibilityChange)
            this.scheduleMetadataEnrichment()
        }

        let released = false
        return () => {
            if (released) return
            released = true
            this.metadataEnrichmentOwners = Math.max(0, this.metadataEnrichmentOwners - 1)
            if (this.metadataEnrichmentOwners === 0) {
                document.removeEventListener(
                    "visibilitychange",
                    this.handleMetadataVisibilityChange,
                )
                this.pauseMetadataEnrichment()
            }
        }
    }

    private scheduleMetadataEnrichment() {
        if (
            this.metadataEnrichmentOwners === 0 ||
            document.visibilityState === "hidden" ||
            this.metadataEnrichmentTask ||
            this.metadataEnrichmentIdleId !== null
        ) {
            return
        }

        const start = () => {
            this.metadataEnrichmentIdleId = null
            if (this.metadataEnrichmentOwners === 0 || document.visibilityState === "hidden") return
            const controller = new AbortController()
            this.metadataEnrichmentController = controller
            const task = this.runMetadataEnrichment(controller.signal)
            this.metadataEnrichmentTask = task
            void task.finally(() => {
                if (this.metadataEnrichmentTask === task) this.metadataEnrichmentTask = null
                if (this.metadataEnrichmentController === controller) {
                    this.metadataEnrichmentController = null
                }
                if (
                    controller.signal.aborted &&
                    this.metadataEnrichmentOwners > 0 &&
                    document.visibilityState === "visible"
                ) {
                    this.scheduleMetadataEnrichment()
                }
            })
        }

        if (typeof requestIdleCallback !== "undefined") {
            this.metadataEnrichmentIdleId = requestIdleCallback(start, { timeout: 2000 })
        } else {
            this.metadataEnrichmentIdleId = window.setTimeout(start, 250)
        }
    }

    private async runMetadataEnrichment(signal: AbortSignal) {
        await this.init()
        const candidates = this.allFiles.filter((file) => !file.metadata.totalPages)
        for (const candidate of candidates) {
            if (signal.aborted || document.visibilityState === "hidden") return
            await this.enrichLegacyMetadata(candidate.id, signal)
            if (signal.aborted) return
            await new Promise<void>((resolve) => window.setTimeout(resolve, 50))
        }
    }

    private async enrichLegacyMetadata(id: string, signal: AbortSignal) {
        const node = this.nodes[id]
        if (!node || node.type !== "file" || node.metadata.totalPages) return
        const generation = this.contentGeneration(id)
        const url = await this.getFileUrl(id, false, "temporary")
        if (!url || signal.aborted || !this.isCurrentContent(id, generation)) {
            if (url) this.releaseTemporaryFileUrl(id, url)
            return
        }

        let doc: OpenedDocument | null = null
        try {
            doc = await openUrlDocument(url, id, node.name)
            this.activeMetadataDocument = doc
            if (signal.aborted || doc.kind !== "paged") return
            const { pageCount, author } = doc.metadata
            if (signal.aborted || !this.isCurrentContent(id, generation)) return
            await this.updateFile(
                id,
                { metadata: { totalPages: pageCount ?? doc.pageCount, author: author ?? null } },
                true,
                generation,
            )
        } catch (error) {
            if (!signal.aborted) {
                console.warn(
                    `[VFSStore] Failed to enrich metadata for node ${id}:`,
                    getLibraryErrorDiagnostic(error),
                )
            }
        } finally {
            if (this.activeMetadataDocument === doc) this.activeMetadataDocument = null
            await this.awaitUnlessDisposed(closeDocument(doc)).catch(() => undefined)
            this.releaseTemporaryFileUrl(id, url)
        }
    }

    private pauseMetadataEnrichment() {
        if (this.metadataEnrichmentIdleId !== null) {
            if (typeof cancelIdleCallback !== "undefined") {
                cancelIdleCallback(this.metadataEnrichmentIdleId)
            } else {
                clearTimeout(this.metadataEnrichmentIdleId)
            }
            this.metadataEnrichmentIdleId = null
        }
        this.metadataEnrichmentController?.abort()
        this.metadataEnrichmentController = null
        void closeDocument(this.activeMetadataDocument).catch(() => undefined)
    }

    configureStorage(storage: StorageNamespace): void {
        if (this.initialized) return
        this.db = new LibraryStorage(storage)
    }

    dispose(): Promise<void> {
        if (this.disposalCompletion) return this.disposalCompletion
        this.disposed = true
        this.resolveDisposal()
        this.disposalCompletion = this.completeDispose()
        return this.disposalCompletion
    }

    private async completeDispose(): Promise<void> {
        this.metadataEnrichmentOwners = 0
        if (browser && typeof document !== "undefined") {
            document.removeEventListener("visibilitychange", this.handleMetadataVisibilityChange)
        }
        this.pauseMetadataEnrichment()
        await this.metadataEnrichmentTask?.catch(() => undefined)
        this.metadataEnrichmentTask = null
        await Promise.allSettled(this.activeRelinkTasks)
        for (const waiters of this.relinkWaiters.values()) {
            for (const resolve of waiters) resolve()
        }
        this.relinkWaiters.clear()
        for (const waiters of this.deletionWaiters.values()) {
            for (const resolve of waiters) resolve()
        }
        this.deletionWaiters.clear()

        this.fileUrlRequests.clear()
        this.previewUrlRequests.clear()
        // Every mutation checks disposal after persistence awaits, so no late continuation can
        // publish state after this point. Do not wait on arbitrary user/database operations.
        for (const id of Object.keys(this.fileUrls)) this.revokeFileUrl(id, undefined, true)
        for (const id of Object.keys(this.previewUrls)) this.revokePreviewUrl(id, true)
        for (const id of Object.keys(this.previewUrlRefs)) delete this.previewUrlRefs[id]
        this.nativeFiles.clear()
        this.nativeHandles.clear()
        for (const timer of this.resourceRollbackRetryTimers.values()) clearTimeout(timer)
        this.resourceRollbackRetryTimers.clear()
        await Promise.allSettled(this.resourceRollbackRetryTasks)
        await Promise.allSettled(this.resourceRollbackTasks)
        await Promise.race([
            Promise.allSettled(this.resourceOperationTasks),
            new Promise<void>((resolve) => setTimeout(resolve, 250)),
        ])
        await this.rollbackPendingResourceImports()
        this.importSources.clear()
        this.activeSourceTasks.clear()
        this.activeNodeMutations.clear()
        this.nodeDeletionStartingListeners.clear()
        this.nodeDeletionListeners.clear()
        this.nodeInvalidatedListeners.clear()
        this.contentRestoredListeners.clear()
        this.nodeRelinkedListeners.clear()
        // Persistence is owned by the host-provided ExtensionStorage namespace.
    }

    /**
     * Lazily fetches and creates an Object URL for a node's preview.
     */
    async getPreviewUrl(id: string): Promise<string> {
        if (this.disposed || this.deletingFileIds.has(id)) return ""
        this.previewUrlRefs[id] = (this.previewUrlRefs[id] || 0) + 1
        if ((this.relinkingCounts.get(id) ?? 0) > 0) {
            try {
                await this.awaitUnlessDisposed(
                    new Promise<void>((resolve) => {
                        const waiters = this.relinkWaiters.get(id) ?? new Set<() => void>()
                        waiters.add(resolve)
                        this.relinkWaiters.set(id, waiters)
                    }),
                )
            } catch (error) {
                if (error instanceof VFSDisposedError) return ""
                throw error
            }
            if (this.disposed) return ""
            return this.loadOrReusePreviewUrl(id)
        }
        if (this.disposed) return ""
        return this.loadOrReusePreviewUrl(id)
    }

    private async loadOrReusePreviewUrl(id: string): Promise<string> {
        if (this.disposed) return ""
        const invalidation = this.previewInvalidationTails.get(id)
        if (invalidation) {
            try {
                await this.awaitUnlessDisposed(invalidation)
            } catch (error) {
                if (error instanceof VFSDisposedError) return ""
                throw error
            }
        }
        if (this.disposed) return ""
        if (this.previewUrls[id]) return this.previewUrls[id]

        const pending = this.previewUrlRequests.get(id)
        if (pending) return pending

        const request = this.loadPreviewUrl(id)
        this.previewUrlRequests.set(id, request)
        try {
            return await request
        } finally {
            if (this.previewUrlRequests.get(id) === request) this.previewUrlRequests.delete(id)
        }
    }

    private async loadPreviewUrl(id: string): Promise<string> {
        if (this.disposed || this.deletingFileIds.has(id)) return ""
        const generation = this.contentGeneration(id)
        const previewGeneration = this.previewGeneration(id)
        const requestVersion = this.previewRequestVersion(id)
        try {
            const cachedPreview = await this.awaitUnlessDisposed(this.db.previews.get(id))
            if (this.disposed) return ""
            if (cachedPreview) {
                return this.publishPreviewUrl(
                    id,
                    URL.createObjectURL(cachedPreview.data),
                    generation,
                    previewGeneration,
                    requestVersion,
                )
            }

            const fileUrl = await this.getFileUrl(id, false, "temporary")
            if (this.disposed) {
                if (fileUrl) this.releaseTemporaryFileUrl(id, fileUrl)
                return ""
            }
            if (fileUrl) {
                let doc: OpenedDocument | null = null
                try {
                    const node = this.nodes[id]
                    doc = await openUrlDocument(fileUrl, id, node?.name ?? id)
                    if (this.disposed || doc.kind !== "paged") return ""
                    const renderedPage = await this.awaitUnlessDisposed(renderDocumentPage(doc, 1))
                    const pageUrl = renderedPage.url
                    if (pageUrl) {
                        try {
                            await this.savePreview(
                                id,
                                pageUrl,
                                false,
                                generation,
                                previewGeneration,
                                requestVersion,
                            )
                        } finally {
                            URL.revokeObjectURL(pageUrl)
                        }

                        if (
                            !this.isCurrentContent(id, generation) ||
                            !this.isCurrentPreview(id, previewGeneration) ||
                            !this.isCurrentPreviewRequest(id, requestVersion)
                        )
                            return ""
                        const newCachedPreview = await this.awaitUnlessDisposed(
                            this.db.previews.get(id),
                        )
                        if (this.disposed) return ""
                        if (newCachedPreview) {
                            return this.publishPreviewUrl(
                                id,
                                URL.createObjectURL(newCachedPreview.data),
                                generation,
                                previewGeneration,
                                requestVersion,
                            )
                        }
                    }
                } catch (err) {
                    console.warn(
                        `[VFSStore] Failed to dynamically generate preview for node ${id}:`,
                        getLibraryErrorDiagnostic(err),
                    )
                } finally {
                    await this.awaitUnlessDisposed(closeDocument(doc)).catch(() => undefined)
                    this.releaseTemporaryFileUrl(id, fileUrl)
                }
            }
        } catch (e) {
            console.error(`Failed to load preview for node ${id}:`, getLibraryErrorDiagnostic(e))
        }
        return ""
    }

    private publishPreviewUrl(
        id: string,
        url: string,
        generation = this.contentGeneration(id),
        previewGeneration = this.previewGeneration(id),
        requestVersion = this.previewRequestVersion(id),
    ): string {
        if (
            this.disposed ||
            !this.previewUrlRefs[id] ||
            this.nodes[id]?.type !== "file" ||
            !this.isCurrentContent(id, generation) ||
            !this.isCurrentPreview(id, previewGeneration) ||
            !this.isCurrentPreviewRequest(id, requestVersion)
        ) {
            URL.revokeObjectURL(url)
            return ""
        }
        const existingUrl = this.previewUrls[id]
        if (existingUrl && existingUrl !== url) URL.revokeObjectURL(existingUrl)
        this.previewUrls[id] = url
        return url
    }

    async getFilePageCount(id: string): Promise<number | null> {
        const node = this.nodes[id]
        if (!node || node.type !== "file") return null
        const generation = this.contentGeneration(id)
        const url = await this.getFileUrl(id, false, "temporary")
        if (!url || !this.isCurrentContent(id, generation)) {
            if (url) this.releaseTemporaryFileUrl(id, url)
            return null
        }
        let document: OpenedDocument | null = null
        try {
            document = await openUrlDocument(url, id, node.name)
            return document.kind === "paged" ? document.pageCount : null
        } finally {
            await closeDocument(document).catch(() => undefined)
            this.releaseTemporaryFileUrl(id, url)
        }
    }

    getContentGeneration(id: string): number {
        return this.contentGenerations.get(id) ?? 0
    }

    private contentGeneration(id: string): number {
        return this.getContentGeneration(id)
    }

    private contentRetryVersion(id: string): number {
        return this.contentRetryVersions.get(id) ?? 0
    }

    private nextAccessAttempt(id: string): number {
        const attempt = (this.accessAttemptGenerations.get(id) ?? 0) + 1
        this.accessAttemptGenerations.set(id, attempt)
        return attempt
    }

    private isCurrentAccessAttempt(id: string, attempt: number): boolean {
        return this.accessAttemptGenerations.get(id) === attempt
    }

    private retireAccessAttempt(id: string): void {
        this.accessAttemptGenerations.set(id, (this.accessAttemptGenerations.get(id) ?? 0) + 1)
        this.successfulAccessAttempts.delete(id)
    }

    private previewGeneration(id: string): number {
        return this.previewGenerations.get(id) ?? 0
    }

    private previewRequestVersion(id: string): number {
        return this.previewRequestVersions.get(id) ?? 0
    }

    private isCurrentPreview(id: string, generation: number): boolean {
        return this.previewGeneration(id) === generation
    }

    private isCurrentPreviewRequest(id: string, version: number): boolean {
        return this.previewRequestVersion(id) === version
    }

    isCurrentContent(id: string, generation: number): boolean {
        return (
            !this.disposed &&
            !this.deletingFileIds.has(id) &&
            this.nodes[id]?.type === "file" &&
            this.contentGeneration(id) === generation
        )
    }

    isCurrentFileUrl(id: string, url: string, generation = this.contentGeneration(id)): boolean {
        return (
            !this.deletingFileIds.has(id) &&
            this.isCurrentContent(id, generation) &&
            this.nodes[id]?.type === "file" &&
            this.fileUrls[id] === url
        )
    }

    isNodeDeleting(id: string): boolean {
        return this.deletingFileIds.has(id)
    }

    private settleDeletion(id: string): void {
        const waiters = this.deletionWaiters.get(id)
        if (!waiters) return
        this.deletionWaiters.delete(id)
        for (const resolve of waiters) resolve()
    }

    private async waitForDeletion(id: string): Promise<void> {
        if (!this.deletingFileIds.has(id)) return
        await this.awaitUnlessDisposed(
            new Promise<void>((resolve) => {
                const waiters = this.deletionWaiters.get(id) ?? new Set<() => void>()
                waiters.add(resolve)
                this.deletionWaiters.set(id, waiters)
            }),
        )
    }

    async waitForRelink(id: string): Promise<void> {
        if ((this.relinkingCounts.get(id) ?? 0) <= 0) return
        await new Promise<void>((resolve) => {
            const waiters = this.relinkWaiters.get(id) ?? new Set<() => void>()
            waiters.add(resolve)
            this.relinkWaiters.set(id, waiters)
        })
    }

    private async rollbackResourceLimitedImport(
        id: string,
        generations: ImportGenerations,
    ): Promise<ResourceRollbackOutcome> {
        for (let attempt = 0; attempt < 3; attempt += 1) {
            if (this.disposed) return "pending"
            // A relink may never settle (for example, a host file handle can hang). Wait only
            // briefly so callers can observe the waiter while the bounded retry policy remains
            // effective.
            if ((this.relinkingCounts.get(id) ?? 0) > 0) {
                let relinkSettled = false
                const timeout = new Promise<void>((resolve) => setTimeout(resolve, 100))
                await Promise.race([
                    this.waitForRelink(id).then(() => {
                        relinkSettled = true
                    }),
                    timeout,
                ])
                if (!relinkSettled) return "pending"
                continue
            }

            let retryAfterRelink = false
            let outcome: ResourceRollbackOutcome = "rolled-back"
            try {
                await this.serializeNodeMutation(async () => {
                    if ((this.relinkingCounts.get(id) ?? 0) > 0) {
                        retryAfterRelink = true
                        return
                    }
                    if (
                        !this.isCurrentContent(id, generations.content) ||
                        (this.relinkStateOwners.get(id) ?? 0) !== generations.relinkOwner ||
                        this.nodes[id]?.type !== "file"
                    ) {
                        outcome = "superseded"
                        return
                    }

                    const currentRelinkEpoch = this.relinkEpochs.get(id) ?? 0
                    try {
                        await this.deleteNodeUnlocked(id, currentRelinkEpoch)
                    } catch (error) {
                        if (error instanceof ContentSupersededError) {
                            retryAfterRelink = true
                            return
                        }
                        throw error
                    }
                })
            } catch (error) {
                console.error(
                    `[VFSStore] Resource-limited import rollback attempt failed for ${id}:`,
                    getLibraryErrorDiagnostic(error),
                )
                await new Promise<void>((resolve) => setTimeout(resolve, 0))
                continue
            }
            if (retryAfterRelink) continue
            return outcome
        }
        return "pending"
    }

    private trackResourceRollback(
        id: string,
        generations: ImportGenerations,
    ): Promise<ResourceRollbackOutcome> {
        let task: Promise<ResourceRollbackOutcome>
        task = this.rollbackResourceLimitedImport(id, generations).finally(() =>
            this.resourceRollbackTasks.delete(task),
        )
        this.resourceRollbackTasks.add(task)
        return task
    }

    private schedulePendingResourceRollback(id: string): void {
        if (
            this.disposed ||
            this.resourceRollbackRetryTimers.has(id) ||
            this.resourceCleanupFailures.has(id)
        )
            return
        const attempt = (this.resourceRollbackRetryAttempts.get(id) ?? 0) + 1
        if (attempt > 5) {
            const pending = this.pendingResourceRollbacks.get(id)
            if (!pending) return
            const markerTask = this.persistResourceCleanupMarker(id, pending.generations).then(
                (result) => {
                    if (result === "marked" || result === "superseded") {
                        this.pendingResourceRollbacks.delete(id)
                    } else {
                        // Both durable marker stores failed. Keep the pending record and its
                        // explicit failure state, but do not recursively retry forever or claim
                        // that a cleanup marker was written.
                        console.error(
                            `[VFSStore] Resource-limited cleanup remains pending for ${id}; ` +
                                "durable marker persistence failed",
                        )
                    }
                    console.error(
                        `[VFSStore] Resource-limited import rollback exhausted retries for ${id}; ` +
                            "leaving the pending cleanup for the next initialization",
                    )
                },
            )
            this.resourceRollbackRetryTasks.add(markerTask)
            void markerTask.finally(() => this.resourceRollbackRetryTasks.delete(markerTask))
            return
        }
        this.resourceRollbackRetryAttempts.set(id, attempt)
        const delay = Math.min(100 * 2 ** (attempt - 1), 1600)
        const timer = setTimeout(() => {
            this.resourceRollbackRetryTimers.delete(id)
            const pending = this.pendingResourceRollbacks.get(id)
            if (!pending || this.disposed) return
            let task: Promise<void>
            task = this.trackResourceRollback(id, pending.generations)
                .then((outcome) => {
                    if (outcome === "rolled-back" || outcome === "superseded") {
                        this.resourceCleanupMarkers.add(id)
                        this.pendingResourceRollbacks.delete(id)
                        this.resourceRollbackRetryAttempts.delete(id)
                    } else {
                        this.schedulePendingResourceRollback(id)
                    }
                })
                .finally(() => this.resourceRollbackRetryTasks.delete(task))
            this.resourceRollbackRetryTasks.add(task)
        }, delay)
        this.resourceRollbackRetryTimers.set(id, timer)
    }

    private async rollbackPendingResourceImports(): Promise<void> {
        for (const [id, { generations }] of this.pendingResourceRollbacks) {
            let completed = false
            for (let attempt = 0; attempt < 5 && !completed; attempt += 1) {
                if (
                    this.contentGeneration(id) !== generations.content ||
                    (this.relinkStateOwners.get(id) ?? 0) !== generations.relinkOwner
                ) {
                    completed = true
                    break
                }
                completed = await this.cleanupPersistedResourceLimitedFile(id)
                if (!completed && attempt < 4) {
                    await new Promise<void>((resolve) =>
                        setTimeout(resolve, Math.min(100 * 2 ** attempt, 1600)),
                    )
                }
            }
            if (!completed) {
                const markerResult = await this.persistResourceCleanupMarker(id, generations)
                completed = markerResult === "marked" || markerResult === "superseded"
                if (!completed) {
                    console.error(
                        `[VFSStore] Resource-limited cleanup remains pending for ${id}; ` +
                            "the durable marker will be retried on next initialization",
                    )
                }
            }
            if (completed) {
                this.resourceCleanupMarkers.add(id)
                this.pendingResourceRollbacks.delete(id)
            }
        }
    }

    private markSupersededFileRead(id: string, relinkEpoch: number) {
        if ((this.relinkEpochs.get(id) ?? 0) !== relinkEpoch) {
            this.contentRetryVersions.set(id, this.contentRetryVersion(id) + 1)
        }
    }

    private async retryAfterContentSuperseded(
        id: string,
        generation: number,
        relinkEpoch: number,
        relinkObserved: boolean,
    ): Promise<boolean> {
        if (this.disposed) return false
        if (this.deletingFileIds.has(id)) {
            await this.waitForDeletion(id)
            return this.nodes[id]?.type === "file"
        }
        if ((this.relinkingCounts.get(id) ?? 0) > 0) {
            await this.awaitUnlessDisposed(this.waitForRelink(id))
            return this.nodes[id]?.type === "file"
        }
        if (this.isCurrentContent(id, generation)) {
            return relinkObserved || (this.relinkEpochs.get(id) ?? 0) !== relinkEpoch
        }
        return this.nodes[id]?.type === "file"
    }

    private notifyNodeInvalidated(id: string) {
        if (this.disposed) return
        for (const listener of this.nodeInvalidatedListeners) {
            if (this.disposed) return
            try {
                listener(id)
            } catch (error) {
                console.error(
                    "VFS node invalidation listener failed:",
                    getLibraryErrorDiagnostic(error),
                )
            }
        }
    }

    private notifyContentRestored(id: string) {
        if (this.disposed) return
        for (const listener of this.contentRestoredListeners) {
            if (this.disposed) return
            try {
                listener(id)
            } catch (error) {
                console.error(
                    "VFS content restored listener failed:",
                    getLibraryErrorDiagnostic(error),
                )
            }
        }
    }

    private invalidateContent(id: string, notify = true): number {
        const generation = this.contentGeneration(id) + 1
        this.contentGenerations.set(id, generation)
        this.previewGenerations.set(id, this.previewGeneration(id) + 1)
        this.previewRequestVersions.set(id, this.previewRequestVersion(id) + 1)
        this.successfulAccessAttempts.delete(id)
        this.previewUrlRequests.delete(id)
        if (notify) this.notifyNodeInvalidated(id)
        return generation
    }

    async invalidatePreview(id: string) {
        if (this.disposed) return
        const predecessor = this.previewInvalidationTails.get(id) ?? Promise.resolve()
        const operation = predecessor.then(() => this.invalidatePreviewOnce(id))
        const settled = operation.catch(() => undefined)
        this.previewInvalidationTails.set(id, settled)
        try {
            await this.awaitUnlessDisposed(operation)
        } finally {
            if (this.previewInvalidationTails.get(id) === settled) {
                this.previewInvalidationTails.delete(id)
            }
        }
    }

    private async invalidatePreviewOnce(id: string) {
        if (this.disposed) return
        const previousPreviewGeneration = this.previewGeneration(id)
        const previousRequestVersion = this.previewRequestVersion(id)
        const nextPreviewGeneration = previousPreviewGeneration + 1
        const nextRequestVersion = previousRequestVersion + 1
        this.previewGenerations.set(id, nextPreviewGeneration)
        this.previewRequestVersions.set(id, nextRequestVersion)
        // Keep an in-flight request attached while invalidation is pending. If persistence
        // fails and generations are restored, callers must continue sharing that request.
        try {
            await this.serializeNodeMutation(async () => {
                await this.awaitUnlessDisposed(this.db.previews.delete(id))
                this.throwIfDisposed()
                const url = this.previewUrls[id]
                if (url) URL.revokeObjectURL(url)
                delete this.previewUrls[id]
            })
        } catch (error) {
            // Operations for one preview are serialized, so this restores the exact state
            // observed by this operation rather than a version already advanced by a sibling.
            if (
                !this.disposed &&
                this.previewGeneration(id) === nextPreviewGeneration &&
                this.previewRequestVersion(id) === nextRequestVersion
            ) {
                this.previewGenerations.set(id, previousPreviewGeneration)
                this.previewRequestVersions.set(id, previousRequestVersion)
            }
            throw error
        }
        if (this.disposed) return
        this.previewUrlRequests.delete(id)
        this.notifyNodeInvalidated(id)
    }

    revokePreviewUrl(id: string, force = false) {
        if (force) {
            delete this.previewUrlRefs[id]
        } else {
            if (!this.previewUrlRefs[id]) return
            this.previewUrlRefs[id]--
        }

        if (force || !this.previewUrlRefs[id] || this.previewUrlRefs[id] <= 0) {
            const url = this.previewUrls[id]
            if (url) {
                URL.revokeObjectURL(url)
                delete this.previewUrls[id]
            }
            delete this.previewUrlRefs[id]
        }
    }

    /**
     * Lazily fetches and creates an Object URL for a file's content.
     */
    async getFileUrl(
        id: string,
        requestPermission = false,
        owner: FileUrlOwner = "viewer",
        bypassCachedUrl = false,
    ): Promise<string> {
        while (true) {
            if (this.disposed || this.deletingFileIds.has(id) || this.nodes[id]?.type !== "file")
                return ""
            if ((this.relinkingCounts.get(id) ?? 0) > 0) {
                await this.awaitUnlessDisposed(this.waitForRelink(id))
                continue
            }
            if (this.fileUrls[id] && !bypassCachedUrl) {
                this.claimFileUrl(id, this.fileUrls[id], owner)
                return this.fileUrls[id]
            }

            const generation = this.contentGeneration(id)
            const retryVersion = this.contentRetryVersion(id)
            const key = `${id}\u0000${generation}\u0000${bypassCachedUrl ? "revalidate" : "cached"}`
            const pending = this.fileUrlRequests.get(key)
            const relinkEpoch = this.relinkEpochs.get(id) ?? 0
            const sharesPending =
                !bypassCachedUrl && pending && (pending.requestPermission || !requestPermission)
            const accessAttempt = sharesPending ? pending.accessAttempt : this.nextAccessAttempt(id)
            const request = sharesPending
                ? pending.promise
                : this.loadFileUrl(
                      id,
                      requestPermission,
                      generation,
                      relinkEpoch,
                      accessAttempt,
                      bypassCachedUrl,
                  )
            const entry =
                pending && sharesPending
                    ? pending
                    : { promise: request, requestPermission, accessAttempt }
            if (!sharesPending) this.fileUrlRequests.set(key, entry)
            try {
                let url: string
                try {
                    url = await this.awaitUnlessDisposed(request)
                } catch (error) {
                    if (error instanceof VFSDisposedError) return ""
                    throw error
                }
                if (url) {
                    this.claimFileUrl(id, url, owner)
                    return url
                }
                if ((this.relinkingCounts.get(id) ?? 0) > 0) {
                    await this.waitForRelink(id)
                    continue
                }
                if (
                    this.contentGeneration(id) !== generation ||
                    this.contentRetryVersion(id) !== retryVersion
                )
                    continue
                return ""
            } finally {
                if (this.fileUrlRequests.get(key) === entry) this.fileUrlRequests.delete(key)
            }
        }
    }

    private isCurrentFileRead(id: string, generation: number, relinkEpoch: number): boolean {
        return (
            this.isCurrentContent(id, generation) &&
            (this.relinkEpochs.get(id) ?? 0) === relinkEpoch &&
            (this.relinkingCounts.get(id) ?? 0) === 0
        )
    }

    private isCurrentRelink(id: string, generation: number, relinkEpoch: number): boolean {
        return (
            this.isCurrentContent(id, generation) &&
            (this.relinkEpochs.get(id) ?? 0) === relinkEpoch
        )
    }

    private isCurrentRelinkEpoch(id: string, relinkEpoch: number): boolean {
        return (
            (this.relinkEpochs.get(id) ?? 0) === relinkEpoch &&
            (this.relinkingCounts.get(id) ?? 0) === 0
        )
    }

    private async loadFileUrl(
        id: string,
        requestPermission: boolean,
        generation: number,
        relinkEpoch: number,
        accessAttempt: number,
        bypassCachedUrl: boolean,
    ): Promise<string> {
        if (
            this.disposed ||
            (this.relinkingCounts.get(id) ?? 0) > 0 ||
            this.deletingFileIds.has(id)
        )
            return ""
        const node = this.nodes[id]
        if (!node || node.type !== "file") return ""

        try {
            let nativeFile = this.nativeFiles.get(id)
            let nativeHandle = this.nativeHandles.get(id)

            if (!nativeFile && !nativeHandle) {
                const content = await this.awaitUnlessDisposed(this.db.fileContents.get(id))
                if (content) {
                    if (content.file) {
                        nativeFile = content.file
                        this.nativeFiles.set(id, nativeFile)
                    }
                    if (content.handle) {
                        nativeHandle = content.handle
                        this.nativeHandles.set(id, nativeHandle)
                    }
                }
            }
            if (!this.isCurrentFileRead(id, generation, relinkEpoch)) {
                this.markSupersededFileRead(id, relinkEpoch)
                return ""
            }

            if (nativeFile) {
                if (!this.isCurrentFileRead(id, generation, relinkEpoch)) return ""
                const url = URL.createObjectURL(nativeFile)
                this.successfulAccessAttempts.set(id, { generation, attempt: accessAttempt })
                if (!this.isCurrentFileRead(id, generation, relinkEpoch)) {
                    URL.revokeObjectURL(url)
                    return ""
                }
                await this.persistUnlockedAccess(id, generation, relinkEpoch, accessAttempt)
                if (!this.isCurrentFileRead(id, generation, relinkEpoch)) {
                    URL.revokeObjectURL(url)
                    this.markSupersededFileRead(id, relinkEpoch)
                    return ""
                }
                return this.publishFileUrl(id, url, generation, relinkEpoch)
            } else if (nativeHandle) {
                if (!this.isCurrentFileRead(id, generation, relinkEpoch)) return ""
                let status = await nativeHandle.queryPermission({ mode: "read" })
                if (!this.isCurrentFileRead(id, generation, relinkEpoch)) {
                    if (status === "granted") this.markSupersededFileRead(id, relinkEpoch)
                    return ""
                }
                if (status !== "granted" && requestPermission) {
                    status = await nativeHandle.requestPermission({ mode: "read" })
                    if (!this.isCurrentFileRead(id, generation, relinkEpoch)) {
                        if (status === "granted") this.markSupersededFileRead(id, relinkEpoch)
                        return ""
                    }
                }
                if (status === "granted") {
                    const fileObj = await nativeHandle.getFile()
                    if (fileObj.size > DOCUMENT_SOURCE_LIMITS.maxFileBytes) {
                        const error = new Error("Document source exceeds the file size limit")
                        error.name = "DocumentSourceLimitError"
                        throw error
                    }
                    if (!this.isCurrentFileRead(id, generation, relinkEpoch)) {
                        // A validation-only relink can fail before invalidating content. Record
                        // this superseded read explicitly so its caller retries the old handle.
                        this.markSupersededFileRead(id, relinkEpoch)
                        return ""
                    }
                    const url = URL.createObjectURL(fileObj)
                    this.successfulAccessAttempts.set(id, { generation, attempt: accessAttempt })
                    if (!this.isCurrentFileRead(id, generation, relinkEpoch)) {
                        URL.revokeObjectURL(url)
                        this.markSupersededFileRead(id, relinkEpoch)
                        return ""
                    }
                    await this.persistUnlockedAccess(id, generation, relinkEpoch, accessAttempt)
                    if (!this.isCurrentFileRead(id, generation, relinkEpoch)) {
                        URL.revokeObjectURL(url)
                        this.markSupersededFileRead(id, relinkEpoch)
                        return ""
                    }
                    return this.publishFileUrl(id, url, generation, relinkEpoch)
                }
            }
        } catch (e) {
            console.error(`Failed to create file URL for node ${id}:`, getLibraryErrorDiagnostic(e))
        }

        if (
            !bypassCachedUrl &&
            this.fileUrls[id] &&
            this.isCurrentFileRead(id, generation, relinkEpoch)
        )
            return this.fileUrls[id]
        if (!this.isCurrentFileRead(id, generation, relinkEpoch)) return ""
        try {
            await this.serializeNodeMutation(async () => {
                if (
                    !this.isCurrentFileRead(id, generation, relinkEpoch) ||
                    !this.isCurrentAccessAttempt(id, accessAttempt) ||
                    (this.successfulAccessAttempts.get(id)?.generation === generation &&
                        this.successfulAccessAttempts.get(id)?.attempt === accessAttempt)
                )
                    return
                const currentNode = this.nodes[id]
                if (currentNode?.type !== "file") return
                if (currentNode.isLocked) {
                    this.isLockedMap[id] = true
                    return
                }
                const lockedNode: FileNode = { ...$state.snapshot(currentNode), isLocked: true }
                await this.awaitUnlessDisposed(this.db.files.put(lockedNode))
                if (!this.isCurrentFileRead(id, generation, relinkEpoch)) return
                this.nodes[id] = lockedNode
                this.isLockedMap[id] = true
            })
        } catch (error) {
            console.error(
                `Failed to persist locked state for node ${id}:`,
                getLibraryErrorDiagnostic(error),
            )
        }
        return ""
    }

    private publishFileUrl(
        id: string,
        url: string,
        generation: number,
        relinkEpoch: number,
    ): string {
        if (!this.isCurrentFileRead(id, generation, relinkEpoch)) {
            URL.revokeObjectURL(url)
            return ""
        }
        const existingUrl = this.fileUrls[id]
        if (existingUrl) {
            if (existingUrl !== url) URL.revokeObjectURL(url)
            return existingUrl
        }
        this.fileUrls[id] = url
        return url
    }

    private async persistUnlockedAccess(
        id: string,
        generation: number,
        relinkEpoch: number,
        accessAttempt: number,
    ): Promise<void> {
        try {
            await this.serializeNodeMutation(async () => {
                if (
                    !this.isCurrentFileRead(id, generation, relinkEpoch) ||
                    !this.isCurrentAccessAttempt(id, accessAttempt)
                )
                    return
                const node = this.nodes[id]
                if (!node || node.type !== "file" || node.isLocked === false) {
                    if (node?.type === "file") this.isLockedMap[id] = false
                    return
                }
                const unlockedNode: FileNode = { ...$state.snapshot(node), isLocked: false }
                await this.saveFileToDb(unlockedNode)
                if (
                    this.isCurrentFileRead(id, generation, relinkEpoch) &&
                    this.isCurrentAccessAttempt(id, accessAttempt)
                ) {
                    this.nodes[id] = unlockedNode
                    this.isLockedMap[id] = false
                }
            })
        } catch (error) {
            if (!(error instanceof VFSDisposedError))
                console.error(
                    `Failed to persist unlocked state for node ${id}:`,
                    getLibraryErrorDiagnostic(error),
                )
        }
    }

    private claimFileUrl(id: string, url: string, owner: FileUrlOwner) {
        const currentUrl = this.fileUrls[id]
        if (currentUrl !== url) return
        const existing = this.fileUrlOwnership.get(id)
        const ownership: FileUrlOwnership =
            existing?.url === url ? existing : { url, viewer: 0, temporary: 0 }
        if (owner === "viewer") ownership.viewer += 1
        else ownership.temporary += 1
        this.fileUrlOwnership.set(id, ownership)
    }

    releaseTemporaryFileUrl(id: string, url: string) {
        const ownership = this.fileUrlOwnership.get(id)
        if (!ownership || ownership.url !== url || ownership.temporary <= 0) return
        ownership.temporary -= 1
        if (ownership.temporary > 0 || ownership.viewer > 0 || this.fileUrls[id] !== url) return
        this.retireAccessAttempt(id)
        URL.revokeObjectURL(url)
        delete this.fileUrls[id]
        this.fileUrlOwnership.delete(id)
    }

    revokeFileUrl(id: string, expectedUrl?: string, force = false): boolean {
        const url = this.fileUrls[id]
        if (!url || (expectedUrl !== undefined && url !== expectedUrl)) return false
        const ownership = this.fileUrlOwnership.get(id)
        if (!force && ownership?.url === url) {
            // Release one operation's lease. In particular, a failed restore must not
            // revoke a URL still claimed by another concurrent restore.
            // revokeFileUrl releases a viewer lease. Temporary consumers use
            // releaseTemporaryFileUrl so releasing one viewer cannot consume or retire
            // an unrelated temporary access attempt.
            if (ownership.viewer <= 0) return true
            ownership.viewer -= 1
            if (ownership.viewer > 0 || ownership.temporary > 0) return true
            this.retireAccessAttempt(id)
            URL.revokeObjectURL(url)
            delete this.fileUrls[id]
            this.fileUrlOwnership.delete(id)
            return true
        }
        this.retireAccessAttempt(id)
        URL.revokeObjectURL(url)
        delete this.fileUrls[id]
        this.fileUrlOwnership.delete(id)
        return true
    }

    importFiles(
        inputs: ImportInput[],
        parentId: string | null,
        callbacks: ImportCallbacks = {},
    ): Promise<ImportResult[]> {
        if (this.disposed) {
            return Promise.resolve(
                inputs.map((input) => ({
                    id: crypto.randomUUID(),
                    name: input.name,
                    status: "failed" as const,
                })),
            )
        }

        const rejected = new Map<number, ImportResult>()
        const acceptedIndexes: number[] = []
        const accepted = inputs.flatMap((input, inputIndex) => {
            if (this.disposed) {
                rejected.set(inputIndex, {
                    id: crypto.randomUUID(),
                    name: input.name,
                    status: "failed",
                })
                return []
            }
            if (this.isFileSource(input.source)) {
                try {
                    if (input.source.size > DOCUMENT_SOURCE_LIMITS.maxFileBytes)
                        throw new Error("Document source exceeds the file size limit")
                } catch {
                    const result: ImportResult = {
                        id: crypto.randomUUID(),
                        name: input.name,
                        status: "rejected",
                    }
                    rejected.set(inputIndex, result)
                    if (!this.disposed) callbacks.onFailure?.(result, "validation")
                    return []
                }
            }
            const job: ImportJob = {
                id: crypto.randomUUID(),
                name: input.name,
                parentId,
                stage: "queued",
            }
            this.importSources.set(job.id, input.source)
            acceptedIndexes.push(inputIndex)
            return [job]
        })

        // One assignment makes the complete batch observable before any persistence starts.
        if (!this.disposed) this.importJobs = [...this.importJobs, ...accepted]

        const saveTasks = accepted.map((job) =>
            this.persistenceQueue(() =>
                this.serializeNodeMutation(() => this.persistImport(job, callbacks)),
            ).catch((error: unknown) => {
                if (error instanceof VFSDisposedError || this.disposed) return null
                throw error
            }),
        )
        const completionTasks = accepted.map((job, index) =>
            this.metadataQueue(async () => {
                if (this.disposed) {
                    return { id: job.id, name: job.name, status: "failed" } as ImportResult
                }
                try {
                    const generations = await this.awaitUnlessDisposed(saveTasks[index])
                    if (!generations) {
                        return { id: job.id, name: job.name, status: "failed" } as ImportResult
                    }
                    if ("rejected" in generations) {
                        return { id: job.id, name: job.name, status: "rejected" } as ImportResult
                    }
                    return await this.awaitUnlessDisposed(
                        this.enrichImport(job, callbacks, generations),
                    )
                } catch (error) {
                    if (error instanceof VFSDisposedError || this.disposed) {
                        return { id: job.id, name: job.name, status: "failed" } as ImportResult
                    }
                    throw error
                }
            }),
        )

        return this.trackSourceTask(
            Promise.all(completionTasks).then((results) => {
                const imported = new Map(
                    acceptedIndexes.map((inputIndex, resultIndex) => [
                        inputIndex,
                        results[resultIndex],
                    ]),
                )
                return inputs.map(
                    (_, inputIndex) => rejected.get(inputIndex) ?? imported.get(inputIndex)!,
                )
            }),
        )
    }

    private isFileSource(source: File | FileSystemFileHandle): source is File {
        return typeof File !== "undefined" && source instanceof File
    }

    private updateImportJob(id: string, updates: Partial<ImportJob>) {
        if (this.disposed) return
        this.importJobs = this.importJobs.map((job) =>
            job.id === id ? { ...job, ...updates } : job,
        )
    }

    private removeImportJob(id: string) {
        this.importSources.delete(id)
        if (this.disposed) return
        this.importJobs = this.importJobs.filter((job) => job.id !== id)
    }

    private async updatePersistedFolderChildren(
        parentId: string,
        childId: string,
        action: "add" | "remove",
        updatedAt: number,
    ): Promise<FolderNode | null> {
        const persistedParent =
            typeof this.db.folders.get === "function"
                ? await this.db.folders.get(parentId)
                : (this.nodes[parentId] as FolderNode | undefined)
        if (!persistedParent || persistedParent.type !== "folder") return null

        const childrenIds =
            action === "add"
                ? Array.from(new Set([...persistedParent.childrenIds, childId]))
                : persistedParent.childrenIds.filter((id) => id !== childId)
        const updatedParent: FolderNode = {
            ...persistedParent,
            childrenIds,
            updatedAt,
        }
        await this.db.folders.put($state.snapshot(updatedParent) as FolderNode)
        this.throwIfDisposed()
        return updatedParent
    }

    private async publishNodeParentState(
        updatedNode: VFSNode,
        originalParentId: string | null,
    ): Promise<void> {
        this.nodes[updatedNode.id] = updatedNode
        if (originalParentId !== updatedNode.parentId) {
            if (originalParentId === null) {
                this.rootIds = this.rootIds.filter((id) => id !== updatedNode.id)
            } else {
                const originalParent = this.nodes[originalParentId]
                if (originalParent?.type === "folder") {
                    originalParent.childrenIds = originalParent.childrenIds.filter(
                        (id) => id !== updatedNode.id,
                    )
                }
            }
        }

        if (updatedNode.parentId === null) {
            if (!this.rootIds.includes(updatedNode.id)) this.rootIds.push(updatedNode.id)
            return
        }

        this.rootIds = this.rootIds.filter((id) => id !== updatedNode.id)
        const localParent = this.nodes[updatedNode.parentId]
        const persistedParent =
            typeof this.db.folders.get === "function"
                ? await this.db.folders.get(updatedNode.parentId)
                : localParent
        if (!persistedParent || persistedParent.type !== "folder") return
        this.nodes[updatedNode.parentId] = {
            ...persistedParent,
            childrenIds: Array.from(new Set([...persistedParent.childrenIds, updatedNode.id])),
        }
    }

    clearFailedImports() {
        if (this.disposed) return
        const failedIds = new Set(
            this.importJobs.filter((job) => job.stage === "failed").map((job) => job.id),
        )
        this.importJobs = this.importJobs.filter((job) => job.stage !== "failed")
        for (const id of failedIds) this.importSources.delete(id)
    }

    private async persistImport(
        job: ImportJob,
        callbacks: ImportCallbacks,
    ): Promise<PersistImportResult> {
        if (this.disposed) return null
        this.updateImportJob(job.id, { stage: "saving" })
        if (job.parentId !== null) {
            const parent = this.nodes[job.parentId]
            if (!parent || parent.type !== "folder") {
                this.updateImportJob(job.id, { stage: "failed", failure: "persistence" })
                this.importSources.delete(job.id)
                if (!this.disposed) {
                    callbacks.onFailure?.(
                        { id: job.id, name: job.name, status: "failed" },
                        "persistence",
                    )
                }
                return null
            }
        }
        const source = this.importSources.get(job.id)
        if (!source) return null

        let document: OpenedDocument | null = null
        let tempUrl = ""
        let committed = false
        try {
            const isFile = this.isFileSource(source)
            const file = isFile ? source : await this.awaitUnlessDisposed(source.getFile())
            this.throwIfDisposed()
            // Open the bounded source before writing persistent state. Paged documents receive
            // the existing render-bound validation; reflowable documents have no page data to
            // validate or synthesize.
            try {
                document = await openBlobDocument(file, job.id, job.name)
                if (document.kind === "paged") await validateRenderBounds(document)
                this.throwIfDisposed()
            } catch (error) {
                if (isDocumentResourceLimitError(error)) throw error
                // Keep the existing behavior for malformed PDFs: persist the source and report
                // metadata failure from the enrichment phase instead of dropping the import.
                await closeDocument(document).catch(() => undefined)
                document = null
            }

            // Validation happens before persistence, but the loaded document must not remain
            // live while the independent metadata queue catches up with a batch.
            await closeDocument(document).catch(() => undefined)
            document = null

            const now = Date.now()
            const siblingTimestamps = Object.values(this.nodes)
                .filter((node) => node.parentId === job.parentId && node.type === "file")
                .map((node) => node.updatedAt)
            const displayTimestamp = Math.min(now, ...siblingTimestamps) - 1
            const node: FileNode = {
                id: job.id,
                name: job.name,
                type: "file",
                parentId: job.parentId,
                size: file.size,
                createdAt: now,
                updatedAt: displayTimestamp,
                isPinned: false,
                metadata: { pageNumber: 1 },
                isLocked: !isFile,
            }
            const content: FileContent = isFile
                ? { id: job.id, file: new Blob([file], { type: file.type }) }
                : { id: job.id, handle: source }
            const generations: ImportGenerations = {
                content: this.contentGeneration(job.id),
                preview: this.previewGeneration(job.id),
                request: this.previewRequestVersion(job.id),
                relinkEpoch: this.relinkEpochs.get(job.id) ?? 0,
                relinkOwner: this.relinkStateOwners.get(job.id) ?? 0,
                document: null,
                tempUrl: "",
            }
            let updatedParent: FolderNode | null = null

            this.throwIfDisposed()
            await this.db.transaction("rw", ["books", "folders", "fileContents"], async () => {
                this.throwIfDisposed()
                await this.db.files.put(node)
                this.throwIfDisposed()
                await this.db.fileContents.put(content)
                this.throwIfDisposed()
                if (job.parentId !== null) {
                    updatedParent = await this.updatePersistedFolderChildren(
                        job.parentId,
                        job.id,
                        "add",
                        now,
                    )
                    if (!updatedParent) throw new Error("Import parent no longer exists")
                }
                // Register immediately after all records are written. This closes the window
                // where disposal can observe a committed import before enrichment starts.
                this.pendingResourceRollbacks.set(job.id, {
                    generations,
                    parentId: job.parentId,
                })
                committed = true
            })
            this.throwIfDisposed()

            if (isFile) this.nativeFiles.set(job.id, content.file!)
            else this.nativeHandles.set(job.id, source)
            this.throwIfDisposed()
            this.nodes[job.id] = node
            this.isLockedMap[job.id] = !isFile
            if (job.parentId === null) {
                this.rootIds.push(job.id)
            } else if (updatedParent) {
                this.nodes[job.parentId] = updatedParent
            }
            this.updateImportJob(job.id, { stage: "metadata" })
            return {
                ...generations,
            }
        } catch (error) {
            if (!committed) this.pendingResourceRollbacks.delete(job.id)
            if (error instanceof VFSDisposedError || this.disposed) return null
            this.importSources.delete(job.id)
            if (isDocumentResourceLimitError(error)) {
                this.updateImportJob(job.id, { stage: "failed", failure: "invalid-file" })
                callbacks.onFailure?.(
                    { id: job.id, name: job.name, status: "rejected" },
                    "validation",
                )
                return { rejected: true }
            }
            console.error(
                `[VFSStore] Failed to persist import ${job.name}:`,
                getLibraryErrorDiagnostic(error),
            )
            this.updateImportJob(job.id, { stage: "failed", failure: "persistence" })
            if (!this.disposed) {
                callbacks.onFailure?.(
                    { id: job.id, name: job.name, status: "failed" },
                    "persistence",
                )
            }
            return null
        } finally {
            await closeDocument(document).catch(() => undefined)
            if (tempUrl) URL.revokeObjectURL(tempUrl)
        }
    }

    private async enrichImport(
        job: ImportJob,
        callbacks: ImportCallbacks,
        generations: ImportGenerations,
    ): Promise<ImportResult> {
        let tempUrl = generations.tempUrl
        let doc = generations.document
        let previewUrl = ""
        let failed = false
        let resourceLimitFailure = false
        let resourceLimitRegistered = false
        let resourceRollbackTask: Promise<ResourceRollbackOutcome> | null = null
        if (!this.resourceCleanupMarkers.has(job.id)) {
            this.pendingResourceRollbacks.set(job.id, {
                generations,
                parentId: job.parentId,
            })
        }
        const registerResourceLimit = () => {
            if (resourceLimitRegistered || this.resourceCleanupMarkers.has(job.id)) return
            resourceLimitRegistered = true
            const pending = this.pendingResourceRollbacks.get(job.id) ?? {
                generations,
                parentId: job.parentId,
            }
            this.pendingResourceRollbacks.set(job.id, pending)
            this.resourceRollbackRetryAttempts.delete(job.id)
            const handleRollbackOutcome = (outcome: ResourceRollbackOutcome) => {
                if (outcome === "rolled-back" || outcome === "superseded") {
                    this.resourceCleanupMarkers.add(job.id)
                    this.pendingResourceRollbacks.delete(job.id)
                } else {
                    this.schedulePendingResourceRollback(job.id)
                }
            }
            if (!this.disposed) {
                resourceRollbackTask = this.trackResourceRollback(job.id, generations)
                void resourceRollbackTask.then(handleRollbackOutcome)
            } else {
                // The operation can reject after disposal has closed the database. Persist the
                // fallback marker independently so startup can remove the committed import.
                const markerTask = this.persistResourceCleanupMarker(job.id, generations).then(
                    (result) =>
                        handleRollbackOutcome(
                            result === "marked" || result === "superseded"
                                ? "rolled-back"
                                : "pending",
                        ),
                )
                this.resourceRollbackRetryTasks.add(markerTask)
                void markerTask.finally(() => this.resourceRollbackRetryTasks.delete(markerTask))
            }
        }
        const awaitDocumentOperation = <T>(promise: Promise<T>) =>
            this.awaitResourceOperation(promise, registerResourceLimit)
        try {
            this.throwIfDisposed()
            if (!doc) {
                const source = this.importSources.get(job.id)
                if (!source) throw new Error("Import source is unavailable")
                const file = this.isFileSource(source)
                    ? source
                    : await this.awaitUnlessDisposed(source.getFile())
                this.throwIfDisposed()
                doc = await openBlobDocument(file, job.id, job.name)
                if (doc.kind === "paged") await awaitDocumentOperation(validateRenderBounds(doc))
                this.throwIfDisposed()
            }

            if (doc.kind === "paged") {
                const {
                    pageCount: totalPages,
                    author,
                    title: documentTitle,
                } = await awaitDocumentOperation(getDocumentDetails(doc))
                this.throwIfDisposed()
                await awaitDocumentOperation(
                    this.updateFile(
                        job.id,
                        {
                            metadata: {
                                pageNumber: 1,
                                totalPages,
                                author,
                                pdfTitle: documentTitle?.trim() || null,
                            },
                        },
                        true,
                        generations.content,
                    ),
                )
                this.throwIfDisposed()

                const renderedPage = await awaitDocumentOperation(renderDocumentPage(doc, 1))
                this.throwIfDisposed()
                previewUrl = renderedPage.url
                this.throwIfDisposed()
                if (previewUrl) {
                    await awaitDocumentOperation(
                        this.savePreview(
                            job.id,
                            previewUrl,
                            true,
                            generations.content,
                            generations.preview,
                            generations.request,
                        ),
                    )
                    this.throwIfDisposed()
                }
            } else {
                // Reflowable documents have no page count or page bitmap. Preserve only their
                // generic metadata instead of inventing paged values or a fake preview.
                const { author, title } = doc.metadata
                await awaitDocumentOperation(
                    this.updateFile(
                        job.id,
                        {
                            metadata: {
                                author: author ?? null,
                                pdfTitle: typeof title === "string" ? title.trim() || null : null,
                            },
                        },
                        true,
                        generations.content,
                    ),
                )
                this.throwIfDisposed()
            }
        } catch (error) {
            failed = true
            resourceLimitFailure = isDocumentResourceLimitError(error)
            if (resourceLimitFailure) {
                registerResourceLimit()
            }
            const rollbackTask = resourceRollbackTask as Promise<ResourceRollbackOutcome> | null
            if (resourceLimitFailure && rollbackTask) {
                await rollbackTask.catch(() => "pending" as ResourceRollbackOutcome)
            }
            if (!(error instanceof VFSDisposedError) && !this.disposed) {
                console.error(
                    `[VFSStore] Failed to enrich import ${job.name}:`,
                    getLibraryErrorDiagnostic(error),
                )
                if (!resourceLimitFailure) {
                    callbacks.onFailure?.(
                        { id: job.id, name: job.name, status: "imported" },
                        "metadata",
                    )
                }
            }
        } finally {
            if (previewUrl) URL.revokeObjectURL(previewUrl)
            await closeDocument(doc).catch(() => undefined)
            if (tempUrl) URL.revokeObjectURL(tempUrl)
            this.removeImportJob(job.id)
        }

        if (!resourceLimitFailure && !this.disposed) {
            this.pendingResourceRollbacks.delete(job.id)
        }
        if (this.disposed) return { id: job.id, name: job.name, status: "failed" }
        if (resourceLimitFailure) {
            callbacks.onFailure?.({ id: job.id, name: job.name, status: "failed" }, "persistence")
            return { id: job.id, name: job.name, status: "failed" }
        }
        const result: ImportResult = { id: job.id, name: job.name, status: "imported" }
        if (!this.disposed) {
            await this.awaitUnlessDisposed(Promise.resolve(callbacks.onImported?.(result)))
        }
        if (this.disposed) return { id: job.id, name: job.name, status: "failed" }
        if (failed && this.isLockedMap[job.id]) this.revokeFileUrl(job.id)
        return result
    }

    async createFile(
        name: string,
        parentId: string | null,
        fileSource: File | FileSystemFileHandle,
        metadata: Partial<BookMetadata> = {},
    ): Promise<string> {
        const [result] = await this.importFiles([{ name, source: fileSource }], parentId)
        if (!result || result.status !== "imported") throw new Error(`Failed to import ${name}`)
        if (Object.keys(metadata).length > 0) await this.updateFile(result.id, { metadata })
        return result.id
    }

    private normalizeFolderNameText(requestedName: string): string {
        const name = requestedName.trim()
        if (!name) throw new FolderNameError("empty")
        if (name.includes("/")) throw new FolderNameError("slash")
        return name
    }

    normalizeFolderName(
        requestedName: string,
        parentId: string | null,
        excludeFolderId?: string,
    ): string {
        const name = this.normalizeFolderNameText(requestedName)
        const duplicate = Object.values(this.nodes).some(
            (node) =>
                node.type === "folder" &&
                node.parentId === parentId &&
                node.id !== excludeFolderId &&
                node.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase(),
        )
        if (duplicate) throw new FolderNameError("duplicate")
        return name
    }

    async renameFolder(id: string, requestedName: string): Promise<void> {
        return this.serializeNodeMutation(() => this.renameFolderUnlocked(id, requestedName))
    }

    private async renameFolderUnlocked(id: string, requestedName: string): Promise<void> {
        const node = this.nodes[id]
        if (!node || node.type !== "folder") return

        let updated: FolderNode | null = null
        const persist = async () => {
            const foldersTable = this.db.folders as typeof this.db.folders & {
                get?: (folderId: string) => Promise<FolderNode | undefined>
                getAll?: () => Promise<FolderNode[]>
            }
            let base = node
            if (typeof foldersTable.get === "function") {
                const persisted = await this.awaitUnlessDisposed(foldersTable.get(id))
                if (!persisted || persisted.type !== "folder") return
                base = persisted
            }
            const name = this.normalizeFolderNameText(requestedName)
            if (typeof foldersTable.getAll === "function") {
                const folders = await this.awaitUnlessDisposed(foldersTable.getAll())
                const duplicate = folders.some(
                    (folder) =>
                        folder.parentId === base.parentId &&
                        folder.id !== id &&
                        folder.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase(),
                )
                if (duplicate) throw new FolderNameError("duplicate")
            } else {
                this.normalizeFolderName(requestedName, base.parentId, id)
            }
            if (name === base.name) {
                updated = base
                return
            }
            updated = { ...$state.snapshot(base), name, updatedAt: Date.now() }
            await this.awaitUnlessDisposed(this.db.folders.put(updated))
        }
        if (typeof this.db.transaction === "function") {
            await this.db.transaction("rw", ["folders"], persist)
        } else {
            await persist()
        }
        this.throwIfDisposed()
        if (updated) await this.publishNodeParentState(updated, node.parentId)
    }

    async setNodePinned(id: string, isPinned: boolean): Promise<void> {
        return this.serializeNodeMutation(() => this.setNodePinnedUnlocked(id, isPinned))
    }

    private async setNodePinnedUnlocked(id: string, isPinned: boolean): Promise<void> {
        const node = this.nodes[id]
        if (!node || node.isPinned === isPinned) return

        if (node.type === "folder")
            await this.awaitUnlessDisposed(this.db.folders.update(id, { isPinned }))
        else await this.awaitUnlessDisposed(this.db.files.update(id, { isPinned }))
        this.throwIfDisposed()

        const current = this.nodes[id]
        if (current) current.isPinned = isPinned
    }

    async createFolder(name: string, parentId: string | null): Promise<string> {
        return this.serializeNodeMutation(() => this.createFolderUnlocked(name, parentId))
    }

    private async createFolderUnlocked(name: string, parentId: string | null): Promise<string> {
        if (parentId !== null) {
            const parent = this.nodes[parentId]
            if (!parent || parent.type !== "folder") {
                throw new Error("Folder parent must be an existing folder")
            }
        }
        const normalizedName = this.normalizeFolderName(name, parentId)
        const id = crypto.randomUUID()
        const now = Date.now()
        const newFolder: FolderNode = {
            id,
            name: normalizedName,
            type: "folder",
            parentId,
            childrenIds: [],
            createdAt: now,
            updatedAt: now,
            isPinned: false,
        }

        let updatedParent: FolderNode | null = null
        await this.db.transaction("rw", ["folders"], async () => {
            this.throwIfDisposed()
            await this.db.folders.put(newFolder)
            this.throwIfDisposed()
            if (parentId !== null) {
                updatedParent = await this.updatePersistedFolderChildren(parentId, id, "add", now)
                if (!updatedParent) throw new Error("Folder parent no longer exists")
            }
        })
        this.throwIfDisposed()

        this.nodes[id] = newFolder
        if (parentId === null) {
            this.rootIds.push(id)
        } else if (updatedParent) {
            this.nodes[parentId] = updatedParent
        }

        return id
    }

    async deleteNode(id: string) {
        return this.serializeNodeMutation(() => this.deleteNodeUnlocked(id))
    }

    private async deleteNodeUnlocked(id: string, expectedRelinkEpoch?: number) {
        const rootNode = this.nodes[id]
        if (!rootNode) return
        if (
            expectedRelinkEpoch !== undefined &&
            !this.isCurrentRelinkEpoch(id, expectedRelinkEpoch)
        ) {
            return
        }

        const assertRelinkEpoch = () => {
            if (
                expectedRelinkEpoch !== undefined &&
                !this.isCurrentRelinkEpoch(id, expectedRelinkEpoch)
            ) {
                throw new ContentSupersededError("Deletion superseded by a newer relink")
            }
        }

        const nodesById = new Map<string, VFSNode>()
        const collect = (nodeId: string) => {
            const node = this.nodes[nodeId]
            if (!node || nodesById.has(nodeId)) return
            nodesById.set(nodeId, node)
            if (node.type === "folder") {
                for (const cid of node.childrenIds) collect(cid)
            }
        }
        collect(id)
        const originalSubtreeNodes = new Map(nodesById)

        let nodesToDelete = [...nodesById.values()]
        let fileIds = nodesToDelete.filter((n) => n.type === "file").map((n) => n.id)
        let folderIds = nodesToDelete.filter((n) => n.type === "folder").map((n) => n.id)
        const previousGenerations = new Map<string, { content: number; preview: number }>(
            fileIds.map((fileId) => [
                fileId,
                {
                    content: this.contentGeneration(fileId),
                    preview: this.previewGeneration(fileId),
                },
            ]),
        )
        if (rootNode.type === "file") {
            for (const fileId of fileIds) {
                this.deletingFileIds.add(fileId)
                this.invalidateContent(fileId)
            }
        }
        const now = Date.now()
        let deletionCommitted = false
        let updatedParent: FolderNode | null = null
        let deletionParentId = rootNode.parentId
        let persistedRootFound = true

        try {
            // PHASE 4 OPTIMIZATION: Use bulkDelete for efficient batch removal
            await this.db.transaction(
                "rw",
                [
                    "books",
                    "folders",
                    "previews",
                    "fileContents",
                    "indexedTexts",
                    "userNotes",
                    "bookmarks",
                ],
                async () => {
                    this.throwIfDisposed()
                    assertRelinkEpoch()
                    const foldersTable = this.db.folders as typeof this.db.folders & {
                        get?: (folderId: string) => Promise<FolderNode | undefined>
                    }
                    const filesTable = this.db.files as typeof this.db.files & {
                        get?: (fileId: string) => Promise<FileNode | undefined>
                    }
                    if (rootNode.type === "file" && typeof filesTable.get === "function") {
                        const persistedRoot = await this.awaitUnlessDisposed(filesTable.get(id))
                        if (persistedRoot) deletionParentId = persistedRoot.parentId
                        else deletionParentId = null
                    }
                    if (rootNode.type === "folder" && typeof foldersTable.get === "function") {
                        // Rebuild the deletion set exclusively from the current persisted tree.
                        // The in-memory snapshot may still contain children moved elsewhere.
                        nodesById.clear()
                        const persistedRoot = await this.awaitUnlessDisposed(foldersTable.get(id))
                        if (!persistedRoot || persistedRoot.type !== "folder") {
                            persistedRootFound = false
                            deletionParentId = rootNode.parentId
                            nodesToDelete = [rootNode]
                            fileIds = []
                            folderIds = []
                            if (deletionParentId !== null) {
                                updatedParent = await this.updatePersistedFolderChildren(
                                    deletionParentId,
                                    id,
                                    "remove",
                                    now,
                                )
                            }
                        } else {
                            deletionParentId = persistedRoot.parentId
                            const pendingFolders = [id]
                            const visitedFolders = new Set<string>()
                            while (pendingFolders.length > 0) {
                                const folderId = pendingFolders.pop()!
                                if (visitedFolders.has(folderId)) continue
                                visitedFolders.add(folderId)
                                const persistedFolder = await this.awaitUnlessDisposed(
                                    foldersTable.get(folderId),
                                )
                                if (!persistedFolder || persistedFolder.type !== "folder") continue
                                nodesById.set(folderId, persistedFolder)
                                for (const childId of persistedFolder.childrenIds) {
                                    const childFolder = await this.awaitUnlessDisposed(
                                        foldersTable.get(childId),
                                    )
                                    if (
                                        childFolder?.type === "folder" &&
                                        childFolder.parentId === folderId
                                    ) {
                                        nodesById.set(childId, childFolder)
                                        pendingFolders.push(childId)
                                    } else if (typeof filesTable.get === "function") {
                                        const childFile = await this.awaitUnlessDisposed(
                                            filesTable.get(childId),
                                        )
                                        if (childFile && childFile.parentId === folderId) {
                                            nodesById.set(childId, childFile)
                                        }
                                    }
                                }
                            }
                            nodesToDelete = [...nodesById.values()]
                            fileIds = nodesToDelete
                                .filter((node) => node.type === "file")
                                .map((node) => node.id)
                            folderIds = nodesToDelete
                                .filter((node) => node.type === "folder")
                                .map((node) => node.id)
                        }
                    }
                    assertRelinkEpoch()
                    for (const fileId of fileIds) {
                        if (!this.deletingFileIds.has(fileId)) {
                            previousGenerations.set(fileId, {
                                content: this.contentGeneration(fileId),
                                preview: this.previewGeneration(fileId),
                            })
                            this.deletingFileIds.add(fileId)
                            this.invalidateContent(fileId)
                        }
                    }
                    if (fileIds.length > 0) {
                        assertRelinkEpoch()
                        await this.db.files.bulkDelete(fileIds)
                        this.throwIfDisposed()
                        await this.db.previews.bulkDelete(fileIds)
                        this.throwIfDisposed()
                        await this.db.fileContents.bulkDelete(fileIds)
                        this.throwIfDisposed()
                        for (const fileId of fileIds) {
                            await this.db.indexedTexts.deleteByBookId(fileId)
                            this.throwIfDisposed()
                            await this.db.userNotes.deleteByBookId(fileId)
                            this.throwIfDisposed()
                            await this.db.bookmarks.deleteByBookId(fileId)
                            this.throwIfDisposed()
                        }
                    }
                    if (folderIds.length > 0) {
                        assertRelinkEpoch()
                        await this.db.folders.bulkDelete(folderIds)
                        this.throwIfDisposed()
                    }

                    assertRelinkEpoch()
                    if (persistedRootFound && deletionParentId !== null) {
                        updatedParent = await this.updatePersistedFolderChildren(
                            deletionParentId,
                            id,
                            "remove",
                            now,
                        )
                    }
                },
            )
            // The transaction's resolution is the commit point. Disposal can race the
            // continuation immediately afterwards; never restore deletion state once the DB
            // has committed.
            deletionCommitted = true
            this.throwIfDisposed()
        } catch (error) {
            if (!deletionCommitted) {
                for (const fileId of fileIds) {
                    const previous = previousGenerations.get(fileId)!
                    this.deletingFileIds.delete(fileId)
                    this.settleDeletion(fileId)
                    this.contentGenerations.set(fileId, previous.content)
                    this.previewGenerations.set(fileId, previous.preview)
                    this.contentRetryVersions.set(fileId, this.contentRetryVersion(fileId) + 1)
                    this.previewRequestVersions.set(fileId, this.previewRequestVersion(fileId) + 1)
                    this.previewUrlRequests.delete(fileId)
                    this.notifyNodeInvalidated(fileId)
                    this.notifyContentRestored(fileId)
                }
                throw error
            }
            // Disposal may reject the post-commit continuation. Cleanup below still owns the
            // in-memory deletion and must run even though listeners/database are closed.
        }

        // Persistence has committed. Listener failures must not prevent the in-memory
        // deletion cleanup below or leave access requests waiting forever.
        if (!this.disposed) {
            for (const listener of this.nodeDeletionStartingListeners) {
                try {
                    listener(fileIds)
                } catch (error) {
                    console.error(
                        "VFS node deletion listener failed:",
                        getLibraryErrorDiagnostic(error),
                    )
                }
            }
        }
        for (const fileId of fileIds) this.deletingFileIds.delete(fileId)

        const deletedIds = nodesToDelete
            .filter((node) => node.type === "file")
            .map((node) => node.id)
        for (const node of nodesToDelete) {
            if (node.type === "file") {
                this.nativeFiles.delete(node.id)
                this.nativeHandles.delete(node.id)
                this.revokeFileUrl(node.id, undefined, true)
                this.revokePreviewUrl(node.id, true)
                delete this.isLockedMap[node.id]
                // Keep generation tombstones so a late read cannot become current for a reused id.
                for (const key of this.fileUrlRequests.keys()) {
                    if (key.startsWith(`${node.id}\u0000`)) this.fileUrlRequests.delete(key)
                }
            }
            if (this.selectedId === node.id) this.selectedId = null
            if (this.activeFileId === node.id) this.activeFileId = null
            this.selectedIds.delete(node.id)

            delete this.nodes[node.id]
        }

        if (deletionParentId === null) {
            this.rootIds = this.rootIds.filter((rid) => rid !== id)
        } else if (updatedParent) {
            this.nodes[deletionParentId] = updatedParent
        }
        const originalParentId = rootNode.parentId
        if (originalParentId === null && deletionParentId !== null) {
            this.rootIds = this.rootIds.filter((rid) => rid !== id)
        } else if (originalParentId !== null && originalParentId !== deletionParentId) {
            const staleParent = this.nodes[originalParentId]
            if (staleParent?.type === "folder") {
                staleParent.childrenIds = staleParent.childrenIds.filter(
                    (childId) => childId !== id,
                )
            }
        }

        if (
            rootNode.type === "folder" &&
            !this.disposed &&
            typeof this.db.folders.get === "function"
        ) {
            const deletedIdSet = new Set(nodesToDelete.map((node) => node.id))
            const filesTable = this.db.files as typeof this.db.files & {
                get?: (fileId: string) => Promise<FileNode | undefined>
            }
            for (const [candidateId, candidate] of originalSubtreeNodes) {
                if (deletedIdSet.has(candidateId)) continue
                const persisted =
                    candidate.type === "folder"
                        ? await this.db.folders.get(candidateId)
                        : typeof filesTable.get === "function"
                          ? await filesTable.get(candidateId)
                          : undefined
                if (persisted) {
                    await this.publishNodeParentState(persisted, candidate.parentId)
                }
            }
        }
        for (const fileId of fileIds) this.settleDeletion(fileId)

        if (!this.disposed) {
            for (const listener of this.nodeDeletionListeners) {
                try {
                    listener(deletedIds)
                } catch (error) {
                    console.error(
                        "VFS node deleted listener failed:",
                        getLibraryErrorDiagnostic(error),
                    )
                }
            }
        }
    }

    async updateFile(
        id: string,
        updates: Omit<Partial<FileNode>, "metadata"> & { metadata?: Partial<BookMetadata> },
        preserveUpdatedAt = false,
        expectedGeneration?: number,
    ) {
        return this.serializeNodeMutation(() =>
            this.updateFileUnlocked(id, updates, preserveUpdatedAt, expectedGeneration),
        )
    }

    private async updateFileUnlocked(
        id: string,
        updates: Omit<Partial<FileNode>, "metadata"> & { metadata?: Partial<BookMetadata> },
        preserveUpdatedAt: boolean,
        expectedGeneration?: number,
    ) {
        if (expectedGeneration !== undefined && !this.isCurrentContent(id, expectedGeneration)) {
            return
        }
        const node = this.nodes[id]
        if (node && node.type === "file") {
            const updated: FileNode = {
                ...$state.snapshot(node),
                ...(updates.name !== undefined ? { name: updates.name } : {}),
                ...(updates.metadata !== undefined
                    ? { metadata: { ...node.metadata, ...updates.metadata } }
                    : {}),
                updatedAt: preserveUpdatedAt ? node.updatedAt : Date.now(),
            }
            const nextLocked = updates.isLocked ?? this.isLockedMap[id] ?? updated.isLocked
            updated.isLocked = nextLocked
            await this.saveFileToDb(updated)
            this.throwIfDisposed()
            if (
                expectedGeneration !== undefined &&
                !this.isCurrentContent(id, expectedGeneration)
            ) {
                return
            }
            this.nodes[id] = updated
            this.isLockedMap[id] = nextLocked
        }
    }

    async updateNode(id: string, updates: Partial<VFSNode>) {
        const node = this.nodes[id]
        if (!node) return
        if (node.type === "file") return this.updateFile(id, updates as Partial<FileNode>)

        return this.serializeNodeMutation(async () => {
            const current = this.nodes[id]
            if (!current || current.type !== "folder") return

            const folderUpdates = updates as Partial<FolderNode>
            let updated!: FolderNode
            const persist = async () => {
                const foldersTable = this.db.folders as typeof this.db.folders & {
                    get?: (folderId: string) => Promise<FolderNode | undefined>
                }
                const persisted = foldersTable.get
                    ? await this.awaitUnlessDisposed(foldersTable.get(id))
                    : undefined
                if (typeof foldersTable.get === "function" && !persisted) return
                const base = persisted ?? current
                const requestedChildren = folderUpdates.childrenIds
                updated = {
                    ...$state.snapshot(base),
                    ...(folderUpdates.name !== undefined ? { name: folderUpdates.name } : {}),
                    ...(requestedChildren !== undefined
                        ? { childrenIds: Array.from(new Set(requestedChildren)) }
                        : {}),
                    updatedAt: Date.now(),
                }
                await this.awaitUnlessDisposed(this.db.folders.put(updated))
            }
            if (typeof this.db.transaction === "function") {
                await this.db.transaction("rw", ["folders"], persist)
            } else {
                await persist()
            }
            this.throwIfDisposed()
            if (updated) await this.publishNodeParentState(updated, current.parentId)
        })
    }

    async savePreview(
        id: string,
        previewDataUrl: string,
        preserveUpdatedAt = false,
        expectedGeneration = this.contentGeneration(id),
        expectedPreviewGeneration = this.previewGeneration(id),
        expectedPreviewRequestVersion = this.previewRequestVersion(id),
    ): Promise<void> {
        if (this.disposed || !this.isCurrentPreviewRequest(id, expectedPreviewRequestVersion))
            return
        let blob: Blob
        if (previewDataUrl.startsWith("blob:") || previewDataUrl.startsWith("data:")) {
            try {
                const response = await this.awaitUnlessDisposed(fetch(previewDataUrl))
                blob = await this.awaitUnlessDisposed(response.blob())
                if (this.disposed) return
            } catch (e) {
                console.error("Failed to fetch blob for preview", getLibraryErrorDiagnostic(e))
                return
            }
        } else {
            return
        }

        try {
            await this.serializeNodeMutation(async () => {
                this.throwIfDisposed()
                if (
                    !this.isCurrentContent(id, expectedGeneration) ||
                    !this.isCurrentPreview(id, expectedPreviewGeneration) ||
                    !this.isCurrentPreviewRequest(id, expectedPreviewRequestVersion)
                )
                    return
                const node = this.nodes[id]
                if (!node || node.type !== "file") return
                const updated: FileNode = {
                    ...$state.snapshot(node),
                    updatedAt: preserveUpdatedAt ? node.updatedAt : Date.now(),
                }
                await this.db.transaction("rw", ["books", "previews"], async () => {
                    this.throwIfDisposed()
                    await this.db.previews.put({ id, data: blob })
                    this.throwIfDisposed()
                    await this.saveFileToDb(updated)
                    this.throwIfDisposed()
                })
                this.throwIfDisposed()
                const existingUrl = this.previewUrls[id]
                if (existingUrl) URL.revokeObjectURL(existingUrl)
                delete this.previewUrls[id]
                if (
                    !this.isCurrentContent(id, expectedGeneration) ||
                    !this.isCurrentPreview(id, expectedPreviewGeneration) ||
                    !this.isCurrentPreviewRequest(id, expectedPreviewRequestVersion)
                )
                    return
                this.nodes[id] = updated
            })
        } catch (error) {
            if (!(error instanceof VFSDisposedError)) throw error
        }
    }

    async restoreFileAccess(id: string): Promise<string> {
        while (true) {
            if (this.deletingFileIds.has(id)) await this.waitForDeletion(id)
            // A committed deletion is a normal terminal result for a restore request;
            // there is no node left whose access can be restored. A rollback, however,
            // leaves the node present and falls through to a fresh access attempt.
            if (this.nodes[id]?.type !== "file") return ""
            const generation = this.contentGeneration(id)
            const relinkEpoch = this.relinkEpochs.get(id) ?? 0
            const relinkObserved = (this.relinkingCounts.get(id) ?? 0) > 0
            const url = await this.awaitUnlessDisposed(this.getFileUrl(id, true, "viewer", true))
            if (!this.isCurrentContent(id, generation)) {
                if (url && !this.revokeFileUrl(id, url)) URL.revokeObjectURL(url)
                if (
                    await this.retryAfterContentSuperseded(
                        id,
                        generation,
                        relinkEpoch,
                        relinkObserved,
                    )
                )
                    continue
                if (this.nodes[id]?.type !== "file") return ""
                throw new ContentSupersededError()
            }
            if (!url) {
                if (
                    await this.retryAfterContentSuperseded(
                        id,
                        generation,
                        relinkEpoch,
                        relinkObserved,
                    )
                )
                    continue
                if (this.nodes[id]?.type !== "file") return ""
                throw new Error("Failed to restore file access")
            }

            let committed = false
            try {
                await this.serializeNodeMutation(async () => {
                    if (!this.isCurrentContent(id, generation)) return
                    const node = this.nodes[id]
                    if (!node || node.type !== "file") return
                    const updated: FileNode = {
                        ...$state.snapshot(node),
                        isLocked: false,
                        updatedAt: Date.now(),
                    }
                    await this.saveFileToDb(updated)
                    if (!this.isCurrentContent(id, generation)) return
                    this.nodes[id] = updated
                    committed = true
                })
            } catch (error) {
                if (!this.revokeFileUrl(id, url)) URL.revokeObjectURL(url)
                throw error
            }

            if (!committed || !this.isCurrentContent(id, generation)) {
                if (!this.revokeFileUrl(id, url)) URL.revokeObjectURL(url)
                if (
                    await this.retryAfterContentSuperseded(
                        id,
                        generation,
                        relinkEpoch,
                        relinkObserved,
                    )
                )
                    continue
                if (this.nodes[id]?.type !== "file") return ""
                throw new ContentSupersededError()
            }
            return url
        }
    }

    async relinkFile(id: string, fileSource: File | FileSystemFileHandle): Promise<void> {
        const task = this.relinkFileUnlocked(id, fileSource)
        this.activeRelinkTasks.add(task)
        void task.then(
            () => this.activeRelinkTasks.delete(task),
            () => this.activeRelinkTasks.delete(task),
        )
        return this.trackSourceTask(task)
    }

    private async relinkFileUnlocked(
        id: string,
        fileSource: File | FileSystemFileHandle,
    ): Promise<void> {
        this.relinkingCounts.set(id, (this.relinkingCounts.get(id) ?? 0) + 1)
        const relinkEpoch = (this.relinkEpochs.get(id) ?? 0) + 1
        this.relinkEpochs.set(id, relinkEpoch)
        const previousGeneration = this.contentGeneration(id)
        const previousPreviewGeneration = this.previewGeneration(id)
        const previousStateOwner = this.relinkStateOwners.get(id) ?? 0
        let generation = previousGeneration
        let invalidated = false
        let committed = false
        let failed = false
        let failure: unknown
        let superseded = false
        try {
            const isFile = this.isFileSource(fileSource)
            let fileObj: File | null = null
            try {
                fileObj = isFile
                    ? (fileSource as File)
                    : await this.awaitUnlessDisposed((fileSource as FileSystemFileHandle).getFile())
            } catch (e) {
                console.error(
                    "Failed to retrieve file object during VFS relinking:",
                    getLibraryErrorDiagnostic(e),
                )
                throw new Error("Failed to retrieve file object during VFS relinking", { cause: e })
            }

            if (!fileObj) throw new Error("Failed to retrieve file object during VFS relinking")
            const candidateDocument = await openBlobDocument(
                fileObj,
                id,
                this.nodes[id]?.name ?? fileObj.name,
            )
            try {
                if (candidateDocument.kind === "paged") {
                    await this.awaitUnlessDisposed(validateRenderBounds(candidateDocument))
                }
            } finally {
                await closeDocument(candidateDocument).catch(() => undefined)
            }

            const fileContent: FileContent = { id }
            if (isFile) {
                const file = fileObj || (fileSource as File)
                fileContent.file = new Blob([file], { type: file.type })
            } else {
                fileContent.handle = fileSource as FileSystemFileHandle
            }

            await this.serializeNodeMutation(async () => {
                const node = this.nodes[id]
                if (!node || node.type !== "file") throw new Error("Cannot relink a missing file")
                if (
                    (this.relinkEpochs.get(id) ?? 0) !== relinkEpoch ||
                    this.deletingFileIds.has(id)
                ) {
                    superseded = true
                    return
                }
                generation = this.invalidateContent(id)
                this.relinkStateOwners.set(id, relinkEpoch)
                invalidated = true
                const { cleanupPending: _cleanupPending, ...nodeWithoutCleanupMarker } =
                    $state.snapshot(node)
                const updated: FileNode = {
                    ...nodeWithoutCleanupMarker,
                    size: fileObj?.size ?? node.size,
                    metadata: { pageNumber: 1 },
                    isLocked: !isFile,
                    updatedAt: Date.now(),
                }
                const filesTable = this.db.files as typeof this.db.files & {
                    get?: (fileId: string) => Promise<FileNode | undefined>
                    delete?: (fileId: string) => Promise<void>
                }
                const fileContentsTable = this.db.fileContents as typeof this.db.fileContents & {
                    get?: (fileId: string) => Promise<FileContent | undefined>
                    delete?: (fileId: string) => Promise<void>
                }
                const previewsTable = this.db.previews as typeof this.db.previews & {
                    get?: (fileId: string) => Promise<BookPreview | undefined>
                }
                const indexedTextsTable = this.db.indexedTexts as typeof this.db.indexedTexts & {
                    getByBookId?: (bookId: string) => Promise<IndexedText[]>
                    bulkPut?: (records: IndexedText[]) => Promise<string[]>
                }
                const previousFile = filesTable.get
                    ? await this.awaitUnlessDisposed(filesTable.get(id))
                    : undefined
                const previousContent = fileContentsTable.get
                    ? await this.awaitUnlessDisposed(fileContentsTable.get(id))
                    : undefined
                const previousPreview = previewsTable.get
                    ? await this.awaitUnlessDisposed(previewsTable.get(id))
                    : undefined
                const previousIndexedTexts = indexedTextsTable.getByBookId
                    ? await this.awaitUnlessDisposed(indexedTextsTable.getByBookId(id))
                    : undefined
                await this.db.transaction(
                    "rw",
                    ["books", "fileContents", "previews", "indexedTexts"],
                    async () => {
                        this.throwIfDisposed()
                        await this.db.fileContents.put(fileContent)
                        this.throwIfDisposed()
                        await this.db.previews.delete(id)
                        this.throwIfDisposed()
                        await this.db.indexedTexts.deleteByBookId(id)
                        this.throwIfDisposed()
                        await this.saveFileToDb(updated)
                        this.throwIfDisposed()
                        // A fallback must not survive a committed replacement. If removal
                        // fails, abort instead of publishing content that startup would delete.
                    },
                )
                this.throwIfDisposed()
                if (!this.isCurrentRelink(id, generation, relinkEpoch)) {
                    // A newer relink may have invalidated ownership while the transaction was
                    // committing. Restore every record touched above before the next mutation.
                    await this.db.transaction(
                        "rw",
                        ["books", "fileContents", "previews", "indexedTexts"],
                        async () => {
                            this.throwIfDisposed()
                            if (previousFile) {
                                await filesTable.put({
                                    ...previousFile,
                                    ...(node.cleanupPending
                                        ? { cleanupPending: node.cleanupPending }
                                        : {}),
                                })
                            } else if (filesTable.delete) await filesTable.delete(id)
                            this.throwIfDisposed()
                            if (previousContent) await fileContentsTable.put(previousContent)
                            else if (fileContentsTable.delete) await fileContentsTable.delete(id)
                            this.throwIfDisposed()
                            if (previousPreview) await this.db.previews.put(previousPreview)
                            else await this.db.previews.delete(id)
                            this.throwIfDisposed()
                            await this.db.indexedTexts.deleteByBookId(id)
                            this.throwIfDisposed()
                            if (previousIndexedTexts?.length && indexedTextsTable.bulkPut)
                                await indexedTextsTable.bulkPut(previousIndexedTexts)
                            this.throwIfDisposed()
                        },
                    )
                    this.throwIfDisposed()
                    // The newer relink has not necessarily invalidated content yet. Restore
                    // this operation's generation so a newer failed validation cannot strand
                    // access requests; a newer operation may invalidate it again later.
                    this.contentGenerations.set(id, previousGeneration)
                    this.previewGenerations.set(id, previousPreviewGeneration)
                    this.previewRequestVersions.set(id, this.previewRequestVersion(id) + 1)
                    this.relinkStateOwners.set(id, previousStateOwner)
                    this.relinkRetryEpochs.set(id, relinkEpoch)
                    this.previewUrlRequests.delete(id)
                    superseded = true
                    return
                }
                this.revokeFileUrl(id, undefined, true)
                const previewRefs = this.previewUrlRefs[id]
                this.revokePreviewUrl(id, true)
                if (previewRefs) this.previewUrlRefs[id] = previewRefs
                this.nativeFiles.delete(id)
                this.nativeHandles.delete(id)
                if (isFile) this.nativeFiles.set(id, fileContent.file!)
                else this.nativeHandles.set(id, fileContent.handle!)
                this.isLockedMap[id] = updated.isLocked ?? false
                this.nodes[id] = updated
                this.relinkStateOwners.set(id, relinkEpoch)
                this.pendingResourceRollbacks.delete(id)
                this.resourceCleanupMarkers.delete(id)
                this.resourceCleanupFailures.delete(id)
                this.resourceRollbackRetryAttempts.delete(id)
                const retryTimer = this.resourceRollbackRetryTimers.get(id)
                if (retryTimer !== undefined) {
                    clearTimeout(retryTimer)
                    this.resourceRollbackRetryTimers.delete(id)
                }
                committed = true
            })
        } catch (error) {
            failed = true
            failure = error
        }

        if (failed) {
            // Validation happens before content is invalidated. Still mark this epoch as a
            // retry boundary so reads that were already waiting on the old handle do not
            // settle with an empty result after the failed replacement attempt.
            if (
                !invalidated &&
                (this.relinkEpochs.get(id) ?? 0) === relinkEpoch &&
                this.nodes[id]?.type === "file" &&
                !this.deletingFileIds.has(id)
            ) {
                this.relinkRetryEpochs.set(id, relinkEpoch)
            }
            if (
                invalidated &&
                this.isCurrentContent(id, generation) &&
                this.relinkStateOwners.get(id) === relinkEpoch &&
                this.nodes[id]?.type === "file" &&
                !this.deletingFileIds.has(id)
            ) {
                this.contentGenerations.set(id, previousGeneration)
                this.previewGenerations.set(id, previousPreviewGeneration)
                this.previewRequestVersions.set(id, this.previewRequestVersion(id) + 1)
                this.relinkStateOwners.set(id, previousStateOwner)
                this.relinkRetryEpochs.set(id, relinkEpoch)
                this.previewUrlRequests.delete(id)
                this.notifyNodeInvalidated(id)
                this.restoredRelinks.add(id)
            }
        }

        const count = (this.relinkingCounts.get(id) ?? 1) - 1
        if (count > 0) this.relinkingCounts.set(id, count)
        else {
            this.relinkingCounts.delete(id)
            const waiters = this.relinkWaiters.get(id)
            this.relinkWaiters.delete(id)
            for (const resolve of waiters ?? []) resolve()
            if (!this.disposed && this.pendingResourceRollbacks.has(id)) {
                this.schedulePendingResourceRollback(id)
            }
        }
        // A rollback restores the previous content; it is not a committed relink. Only a
        // successfully persisted replacement may notify viewers to acquire a new URL.
        if (committed) this.committedRelinks.add(id)
        if (count <= 0) {
            const hasRestoredRelink = this.restoredRelinks.delete(id)
            if (hasRestoredRelink) this.notifyContentRestored(id)
            const hasSettledRelink = this.committedRelinks.delete(id)
            if (hasSettledRelink && !this.disposed) {
                for (const listener of this.nodeRelinkedListeners) {
                    if (this.disposed) break
                    try {
                        listener(id)
                    } catch (error) {
                        console.error(
                            "VFS node relinked listener failed:",
                            getLibraryErrorDiagnostic(error),
                        )
                    }
                }
            }
        }

        if (failed) throw failure
        if (superseded) {
            throw new ContentSupersededError("Relink was superseded by a newer request")
        }
    }

    private async saveFileToDb(node: FileNode): Promise<void> {
        const plainNode = $state.snapshot(node)
        plainNode.isLocked = node.isLocked
        if (plainNode.metadata) {
            plainNode.metadata.pageNumber = plainNode.metadata.pageNumber || 1
        }
        await this.db.files.put(plainNode)
    }

    async moveNode(id: string, newParentId: string | null) {
        return this.serializeNodeMutation(() => this.moveNodeUnlocked(id, newParentId))
    }

    private async moveNodeUnlocked(id: string, newParentId: string | null) {
        const node = this.nodes[id]
        if (!node) return

        if (newParentId !== null) {
            const target = this.nodes[newParentId]
            if (!target || target.type !== "folder") {
                throw new Error("Move target must be an existing folder")
            }
        }
        if (node.type === "folder" && newParentId !== null) {
            let currentId: string | null = newParentId
            while (currentId) {
                if (currentId === id) {
                    throw new Error("Cannot move a folder into itself or its descendants")
                }
                const current: VFSNode | undefined = this.nodes[currentId]
                currentId = current ? current.parentId : null
            }
        }

        const originalParentId = node.parentId
        let oldParentId = originalParentId
        const now = Date.now()
        let updatedNode: VFSNode = {
            ...$state.snapshot(node),
            parentId: newParentId,
            updatedAt: now,
        }
        let updatedOldParent: FolderNode | null = null
        let updatedNewParent: FolderNode | null = null
        let moveSkipped = false

        await this.db.transaction("rw", ["books", "folders"], async () => {
            this.throwIfDisposed()
            const table =
                node.type === "file"
                    ? (this.db.files as typeof this.db.files & {
                          get?: (fileId: string) => Promise<FileNode | undefined>
                      })
                    : (this.db.folders as typeof this.db.folders & {
                          get?: (folderId: string) => Promise<FolderNode | undefined>
                      })
            const persisted = table.get
                ? await this.awaitUnlessDisposed(
                      (table.get as (nodeId: string) => Promise<VFSNode | undefined>)(id),
                  )
                : undefined
            if (typeof table.get === "function" && !persisted) {
                moveSkipped = true
                return
            }
            const currentNode = persisted ?? node
            oldParentId = currentNode.parentId
            if (oldParentId === newParentId) {
                updatedNode = currentNode
                if (newParentId !== null) {
                    updatedNewParent = await this.updatePersistedFolderChildren(
                        newParentId,
                        id,
                        "add",
                        now,
                    )
                    if (!updatedNewParent) throw new Error("Move target no longer exists")
                }
                return
            }
            updatedNode = {
                ...$state.snapshot(currentNode),
                parentId: newParentId,
                updatedAt: now,
            }
            if (updatedNode.type === "file") await this.saveFileToDb(updatedNode as FileNode)
            else await this.db.folders.put(updatedNode as FolderNode)
            this.throwIfDisposed()
            if (oldParentId !== null) {
                updatedOldParent = await this.updatePersistedFolderChildren(
                    oldParentId,
                    id,
                    "remove",
                    now,
                )
            }
            if (newParentId !== null) {
                updatedNewParent = await this.updatePersistedFolderChildren(
                    newParentId,
                    id,
                    "add",
                    now,
                )
                if (!updatedNewParent) throw new Error("Move target no longer exists")
            }
        })
        this.throwIfDisposed()
        if (moveSkipped) return

        this.nodes[id] = updatedNode
        if (originalParentId !== null && originalParentId !== newParentId) {
            const originalParent = this.nodes[originalParentId]
            if (originalParent?.type === "folder") {
                originalParent.childrenIds = originalParent.childrenIds.filter((cid) => cid !== id)
            }
        }
        if (newParentId !== null && (originalParentId === null || oldParentId === null)) {
            this.rootIds = this.rootIds.filter((rid) => rid !== id)
        }
        if (newParentId === null && (originalParentId !== null || oldParentId !== null)) {
            if (!this.rootIds.includes(id)) this.rootIds.push(id)
        }
        if (updatedOldParent) this.nodes[oldParentId!] = updatedOldParent
        if (updatedNewParent) this.nodes[newParentId!] = updatedNewParent
        const currentNewParent = newParentId === null ? null : this.nodes[newParentId]
        if (currentNewParent?.type === "folder") {
            currentNewParent.childrenIds = currentNewParent.childrenIds.filter(
                (childId, index, children) => childId !== id || children.indexOf(childId) === index,
            )
        }
    }

    selectNode(id: string | null) {
        this.selectedId = id
        if (id && this.nodes[id]?.type === "file") {
            this.activeFileId = id
        }
    }

    getNodePath(id: string): string {
        const node = this.nodes[id]
        if (!node) return ""

        const path: string[] = [node.name]
        let currentParentId = node.parentId

        while (currentParentId) {
            const parent = this.nodes[currentParentId]
            if (parent) {
                path.unshift(parent.name)
                currentParentId = parent.parentId
            } else {
                break
            }
        }

        return path.join(" / ")
    }

    getFolderPath(id: string | null): string {
        if (!id) return ""
        const node = this.nodes[id]
        if (!node) return ""

        const path: string[] = [node.name]
        let currentParentId = node.parentId

        while (currentParentId) {
            const parent = this.nodes[currentParentId]
            if (parent) {
                path.unshift(parent.name)
                currentParentId = parent.parentId
            } else {
                break
            }
        }

        return "/" + path.join("/")
    }

    getFolderIdByPath(path: string | null): string | null {
        if (!path) return null
        const cleanPath = path.startsWith("/") ? path.slice(1) : path
        if (!cleanPath) return null

        const segments = cleanPath
            .split("/")
            .map((s) => s.trim())
            .filter(Boolean)
        if (segments.length === 0) return null

        const folders = Object.values(this.nodes).filter(
            (node) => node.type === "folder",
        ) as FolderNode[]

        let currentId: string | null = null
        for (const segment of segments) {
            const nextNode = folders.find(
                (node) =>
                    node.parentId === currentId &&
                    node.name.toLowerCase() === segment.toLowerCase(),
            )
            if (!nextNode) {
                return null
            }
            currentId = nextNode.id
        }

        return currentId
    }
}

class MemoryLibraryStorageNamespace implements ExtensionStorage {
    private readonly values = new Map<string, unknown>()
    async get<T>(key: string): Promise<T | undefined> {
        return this.values.get(key) as T | undefined
    }
    async set<T>(key: string, value: T): Promise<void> {
        this.values.set(key, value)
    }
    async delete(key: string): Promise<void> {
        this.values.delete(key)
    }
    async has(key: string): Promise<boolean> {
        return this.values.has(key)
    }
    async keys(): Promise<readonly string[]> {
        return [...this.values.keys()]
    }
    async clear(): Promise<void> {
        this.values.clear()
    }
    namespace(name: string): StorageNamespace {
        return new PrefixedLibraryStorageNamespace(this, `${name}:`)
    }
    migrate(
        _version: number,
        _migration: (
            storage: import("$lib/extension-api").StorageNamespace,
        ) => void | Promise<void>,
    ): Promise<void> {
        return Promise.resolve()
    }
    get version(): number {
        return 0
    }
    onChange(_listener: (key: string) => void): { dispose(): void } {
        return { dispose() {} }
    }
}

class PrefixedLibraryStorageNamespace implements ExtensionStorage {
    constructor(
        private readonly parent: MemoryLibraryStorageNamespace,
        private readonly prefix: string,
    ) {}
    get<T>(key: string) {
        return this.parent.get<T>(this.prefix + key)
    }
    set<T>(key: string, value: T) {
        return this.parent.set(this.prefix + key, value)
    }
    delete(key: string) {
        return this.parent.delete(this.prefix + key)
    }
    has(key: string) {
        return this.parent.has(this.prefix + key)
    }
    async keys() {
        return (await this.parent.keys())
            .filter((key) => key.startsWith(this.prefix))
            .map((key) => key.slice(this.prefix.length))
    }
    async clear() {
        for (const key of await this.keys()) await this.delete(key)
    }
    namespace(name: string) {
        return new PrefixedLibraryStorageNamespace(this.parent, `${this.prefix}${name}:`)
    }
    migrate(
        _version: number,
        _migration: (
            storage: import("$lib/extension-api").StorageNamespace,
        ) => void | Promise<void>,
    ): Promise<void> {
        return Promise.resolve()
    }
    get version(): number {
        return 0
    }
    onChange(_listener: (key: string) => void): { dispose(): void } {
        return { dispose() {} }
    }
}

export let vfsStore = new VFSStore()
export let libraryStore = vfsStore

/** Reuses the initial store for the first activation and creates a fresh host store after disposal. */
export function configureLibraryStore(storage: StorageNamespace): VFSStore {
    if (vfsStore.isDisposed) {
        vfsStore = new VFSStore({}, storage)
        libraryStore = vfsStore
    } else {
        vfsStore.configureStorage(storage)
    }
    return vfsStore
}

if (import.meta.hot) {
    import.meta.hot.dispose(() => vfsStore.dispose())
}

export function usePreviewUrl(nodeId: () => string) {
    let url = $state("")
    let requestGeneration = 0
    $effect(() => {
        const id = nodeId()
        requestGeneration++
        if (!id) return
        const load = () => {
            const loadGeneration = ++requestGeneration
            void vfsStore.getPreviewUrl(id).then((val) => {
                if (loadGeneration === requestGeneration) url = val
            })
        }
        const stopInvalidation = vfsStore.onNodeInvalidated?.((invalidatedId) => {
            if (invalidatedId !== id) return
            url = ""
            vfsStore.revokePreviewUrl(id)
            load()
        })
        load()
        return () => {
            requestGeneration++
            stopInvalidation?.()
            vfsStore.revokePreviewUrl(id)
        }
    })
    return {
        get url() {
            return url
        },
        async regenerate() {
            const id = nodeId()
            if (!id) return
            const generation = ++requestGeneration
            await vfsStore.invalidatePreview(id)
            const nextUrl = await vfsStore.getPreviewUrl(id)
            if (generation === requestGeneration) url = nextUrl
            vfsStore.revokePreviewUrl(id)
        },
    }
}

export type {
    Bookmark,
    FileNode,
    FileContent,
    FolderNode,
    FolderNameErrorCode,
    ImportCallbacks,
    ImportInput,
    ImportJob,
    ImportResult,
    IndexedText,
    UserNote,
    VFSNode,
    VFSNodes,
} from "./libraryStore.types"
export { FolderNameError }
