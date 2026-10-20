import { SvelteSet } from "svelte/reactivity"
import { browser } from "$app/environment"
import { pushState } from "$app/navigation"
import type { DocumentOutlineEntry } from "$lib/document-model"
import {
    isViewerLibraryCapabilityInstalled,
    getViewerLibraryCapability,
    getViewerLibraryMutationCapability,
    viewerLibraryCapability as vfsStore,
    viewerLibraryMutationCapability as vfsMutations,
} from "../viewerHost"
import { type Book } from "./viewerStore.types"
import type { StorageNamespace } from "$lib/extension-api"
import { getViewerDocumentErrorDiagnostic, type ViewerDocumentLoader } from "../viewerDocument"
import { ReadingWorkspace } from "../readingWorkspace"
import {
    viewerFileCapability,
    type ViewerFileCapability,
    type ViewerLibraryCapability,
    type ViewerLibraryMutationCapability,
} from "../viewerHost"

export interface ViewerStoreOptions {
    files?: ViewerFileCapability
    library?: ViewerLibraryCapability
    mutations?: ViewerLibraryMutationCapability
    loader?: ViewerDocumentLoader
}

export class ViewerStore {
    private files = getViewerLibraryCapability() ?? vfsStore
    private mutations = getViewerLibraryMutationCapability() ?? vfsMutations
    private storage: StorageNamespace | undefined
    private storageGeneration = 0
    private persistenceQueue: Promise<void> = Promise.resolve()

    async configureStorage(storage: StorageNamespace): Promise<void> {
        this.storage = storage
        const generation = ++this.storageGeneration
        const bookSwitchGeneration = this.bookSwitchGeneration
        try {
            const savedBook = await storage.get<Book>("book")
            if (
                this.disposed ||
                generation !== this.storageGeneration ||
                bookSwitchGeneration !== this.bookSwitchGeneration ||
                this.book ||
                !savedBook
            )
                return
            this.book = {
                ...savedBook,
                url: savedBook.url?.startsWith("blob:") ? "" : savedBook.url,
                previewDataUrl: savedBook.previewDataUrl?.startsWith("blob:")
                    ? ""
                    : savedBook.previewDataUrl,
            }
            this.currentPage = savedBook.pageNumber || 1
            this.scrollPosition = savedBook.scrollPosition || 0
        } catch (error) {
            console.error(
                "[ViewerStore] Failed to restore book:",
                getViewerDocumentErrorDiagnostic(error, "Unable to restore viewer state"),
            )
        }
    }

    private book = $state<Book | null>(null)
    private outlineList = $state<DocumentOutlineEntry[] | null>(null)
    private totalPages = $state<number>(0)
    isOutlineLoading = $state(false)

    currentPage = $state(1)
    scrollPosition = $state(0)
    private _isRestoringHistory = false
    lastSetPageState = $state<any>(null)
    private listening = false
    private bookSwitchGeneration = 0
    private disposalEpoch = 0
    private disposed = false
    workspace: ReadingWorkspace
    private readonly vfsUnsubscribers: (() => void)[] = []
    private readonly flush = () => this.persistViewerState(true)
    private readonly handleVisibilityChange = () => {
        if (document.visibilityState === "hidden") this.flush()
    }

    constructor(private readonly options: ViewerStoreOptions = {}) {
        this.files = options.library ?? this.files
        this.mutations = options.mutations ?? this.mutations
        this.workspace = this.createWorkspace()
        this.attachLibraryListeners()
    }

    private createWorkspace(): ReadingWorkspace {
        const files = this.files
        const mutations = this.mutations
        return new ReadingWorkspace({
            files: this.options.files ?? {
                get nodes() {
                    return files.nodes
                },
                get isLockedMap() {
                    return files.isLockedMap
                },
                getFileUrl: (id) => files.getFileUrl(id),
                restoreFileAccess: (id) => viewerFileCapability.restoreFileAccess(id),
                requestRelink: (id) => viewerFileCapability.requestRelink(id),
                waitForRelink: (id) => viewerFileCapability.waitForRelink(id),
                releaseFileUrl: (id, url) => mutations.releaseFileUrl(id, url),
                getContentGeneration: (id) => files.getContentGeneration(id),
                isCurrentContent: (id, generation) => files.isCurrentContent(id, generation),
                isCurrentFileUrl: (id, url, generation) =>
                    files.isCurrentFileUrl(id, url, generation),
                clearForwardHistory: () => mutations.clearForwardHistory(),
            },
            loader: this.options.loader,
            getCurrentBook: () => this.book,
            publish: (book) => this.publishBook(book),
        })
    }

    private publishBook(book: Book | null): boolean {
        if (this.disposed) return false
        this.mutations.setActiveFileId(book?.id ?? null)
        this.bookSwitchGeneration++
        this.book = book
        this.currentPage = book?.pageNumber || 1
        this.scrollPosition = book?.scrollPosition || 0
        this.totalPages = book?.totalPages || 0
        this.persistViewerState(true)
        return true
    }

    private attachLibraryListeners() {
        if (!this.options.library && !isViewerLibraryCapabilityInstalled()) return
        this.vfsUnsubscribers.push(
            this.files.onNodesDeleted?.((ids) => {
                if (this.book && ids.includes(this.book.id))
                    void this.clearDeletedBook(this.book.id)
            }) ?? (() => undefined),
        )
        this.vfsUnsubscribers.push(
            this.files.onNodeRelinked?.((id) => {
                const node = this.files.nodes[id]
                if (!node || node.type !== "file" || this.book?.id !== id) return
                void this.workspace.synchronize(true)
            }) ?? (() => undefined),
        )

        if (browser) {
            window.addEventListener("visibilitychange", this.handleVisibilityChange)
            window.addEventListener("beforeunload", this.flush)
            this.listening = true
        }
    }

    reset() {
        this.dispose()
        this.files = this.options.library ?? getViewerLibraryCapability() ?? vfsStore
        this.mutations =
            this.options.mutations ?? getViewerLibraryMutationCapability() ?? vfsMutations
        this.workspace = this.createWorkspace()
        this.disposed = false
        this.book = null
        this.outlineList = null
        this.totalPages = 0
        this.currentPage = 1
        this.scrollPosition = 0
        this.attachLibraryListeners()
    }

    dispose() {
        if (this.disposed) return
        this.disposed = true
        this.disposalEpoch++
        this.bookSwitchGeneration++
        for (const unsubscribe of this.vfsUnsubscribers.splice(0)) unsubscribe()
        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout)
            this.saveTimeout = null
        }
        if (browser && this.listening) {
            window.removeEventListener("visibilitychange", this.handleVisibilityChange)
            window.removeEventListener("beforeunload", this.flush)
            this.listening = false
        }
        return this.workspace.dispose()
    }

    get library() {
        return this.files
    }
    get libraryMutations() {
        return this.mutations
    }

    get isRestoringHistory() {
        return this._isRestoringHistory
    }

    get activeOutline() {
        return this.outlineList
    }
    set activeOutline(list: DocumentOutlineEntry[] | null) {
        this.outlineList = list
    }

    activeHeadings = $derived.by(() => {
        if (!this.outlineList || this.outlineList.length === 0)
            return new SvelteSet<DocumentOutlineEntry>()

        const onCurrentPage = this.outlineList.filter((h) => h.pageNumber === this.currentPage)
        if (onCurrentPage.length > 0) {
            return new SvelteSet<DocumentOutlineEntry>(onCurrentPage)
        }

        let precedingCandidate: DocumentOutlineEntry | null = null
        for (const heading of this.outlineList) {
            if (heading.pageNumber !== undefined && heading.pageNumber < this.currentPage) {
                if (!precedingCandidate || heading.pageNumber >= precedingCandidate.pageNumber!) {
                    precedingCandidate = heading
                }
            }
        }

        const activeSet = new SvelteSet<DocumentOutlineEntry>()
        if (precedingCandidate) {
            activeSet.add(precedingCandidate)
        }
        return activeSet
    })

    get activeTotalPages() {
        return this.totalPages
    }
    set activeTotalPages(pages: number) {
        this.totalPages = pages
    }

    goToPage(page: number, options?: { scrollPosition?: number; isJump?: boolean }) {
        if (page >= 1 && (this.totalPages === 0 || page <= this.totalPages)) {
            const oldPage = this.currentPage
            const oldScroll = this.scrollPosition
            const targetScroll = options?.scrollPosition ?? 0
            const isPositionChanged =
                page !== oldPage ||
                (options?.scrollPosition !== undefined &&
                    Math.abs(targetScroll - oldScroll) > 0.001)

            // Push the target position to browser history using SvelteKit's pushState
            if (options?.isJump && isPositionChanged && !this._isRestoringHistory && browser) {
                const state = {
                    _pdfjump: true,
                    page: page,
                    scrollPosition: targetScroll,
                    bookId: this.book?.id,
                }
                this.lastSetPageState = state
                pushState("", state)
            }

            this.currentPage = page
            if (options?.scrollPosition !== undefined) {
                this.scrollPosition = options.scrollPosition
            } else if (page !== oldPage) {
                this.scrollPosition = 0
            }

            if (this.book) {
                this.book.pageNumber = this.currentPage
                this.book.scrollPosition = this.scrollPosition
            }
        }
    }

    /** Called by SvelteKit state routing to restore a previously saved jump position. */
    restoreFromHistoryState(state: {
        _pdfjump: true
        page: number
        scrollPosition: number
        bookId: string
    }) {
        if (state.bookId !== this.book?.id) return
        this.lastSetPageState = state
        if (state.page === this.currentPage && state.scrollPosition === this.scrollPosition) return
        this._isRestoringHistory = true
        try {
            this.goToPage(state.page, { scrollPosition: state.scrollPosition })
        } finally {
            this._isRestoringHistory = false
        }
    }

    private async clearDeletedBook(id: string) {
        if (this.book?.id !== id || this.files.nodes[id]?.type === "file") return
        await this.workspace.synchronize()
    }

    syncWithBooks(): Promise<void> {
        return this.workspace.synchronize()
    }

    private saveTimeout: ReturnType<typeof setTimeout> | null = null

    private persistViewerState(immediate = false) {
        if (!browser) return

        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout)
            this.saveTimeout = null
        }

        const save = () => {
            const storage = this.storage
            if (!storage) return
            let savedBook: Book | undefined
            if (this.book) {
                const clean = { ...this.book }
                // Never persist blob URLs
                if (clean.url?.startsWith("blob:")) clean.url = ""
                if (clean.previewDataUrl?.startsWith("blob:")) clean.previewDataUrl = ""
                savedBook = clean
            }
            this.persistenceQueue = this.persistenceQueue
                .then(() => (savedBook ? storage.set("book", savedBook) : storage.delete("book")))
                .catch((error) => {
                    console.error(
                        "[ViewerStore] Failed to persist book:",
                        getViewerDocumentErrorDiagnostic(error, "Unable to save viewer state"),
                    )
                })
        }

        if (immediate) {
            save()
        } else {
            this.saveTimeout = setTimeout(save, 500)
        }
    }

    setCurrentBook(book: Book | null): Promise<boolean> {
        return this.workspace.setCurrentBook(book)
    }

    getCurrentBook(): Book | null {
        return this.book
    }

    getBookSwitchGeneration(): number {
        return this.bookSwitchGeneration
    }

    async updateBook(
        book: Book,
        expectedGeneration?: number,
        expectedBookSwitchGeneration?: number,
    ) {
        // Check disposal before evaluating default arguments or touching the VFS. HMR can
        // leave a late metadata callback holding an otherwise valid Book value.
        if (this.disposed || this.files.isDisposed) return
        const operationDisposalEpoch = this.disposalEpoch
        const resolvedExpectedGeneration =
            expectedGeneration ?? this.files.getContentGeneration(book.id)
        const resolvedExpectedBookSwitchGeneration =
            expectedBookSwitchGeneration ?? this.bookSwitchGeneration
        if (
            operationDisposalEpoch !== this.disposalEpoch ||
            resolvedExpectedBookSwitchGeneration !== this.bookSwitchGeneration
        )
            return

        await this.mutations.updateFile(
            book.id,
            {
                name: book.name,
                isLocked: book.isLocked,
                metadata: {
                    pageNumber: book.pageNumber,
                    scrollPosition: book.scrollPosition,
                    pdfDest: book.pdfDest,
                    totalPages: book.totalPages,
                    author: book.author,
                },
            },
            false,
            resolvedExpectedGeneration,
        )

        if (
            this.disposed ||
            this.files.isDisposed ||
            operationDisposalEpoch !== this.disposalEpoch ||
            resolvedExpectedBookSwitchGeneration !== this.bookSwitchGeneration ||
            !this.files.isCurrentContent(book.id, resolvedExpectedGeneration)
        )
            return
        if (this.book && this.book.id === book.id) {
            // Avoid redundant state updates if data is identical
            if (
                this.book.pageNumber === book.pageNumber &&
                this.book.scrollPosition === book.scrollPosition &&
                this.book.name === book.name &&
                this.book.isLocked === book.isLocked &&
                this.book.pdfDest === book.pdfDest &&
                this.book.totalPages === book.totalPages &&
                this.book.author === book.author
            ) {
                return
            }

            this.book = book
            this.persistViewerState(false)
        }
    }
}

export let viewerStore = new ViewerStore()

/** Select the UI-facing store without changing any previous instance\'s ownership. */
export function installViewerStore(store: ViewerStore): void {
    viewerStore = store
}

if (import.meta.hot) {
    import.meta.hot.dispose(() => viewerStore.dispose())
}
