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
import type { ViewerDocumentLoader } from "../viewerDocument"
import { ReadingWorkspace, type ReadingSnapshot } from "../readingWorkspace"
import {
    ReadingStorage,
    type ReadingDocumentState,
    type ReadingLayout,
    type ReadingStorageError,
} from "../readingStorage"
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
    writeSignal?: AbortSignal
    defaults?: () => Pick<ReadingDocumentState, "scale" | "layout">
    onStorageError?: (error: ReadingStorageError) => void
}

export class ViewerStore {
    private files = getViewerLibraryCapability() ?? vfsStore
    private mutations = getViewerLibraryMutationCapability() ?? vfsMutations
    async configureStorage(storage: StorageNamespace): Promise<void> {
        await this.workspace.restore(new ReadingStorage(storage))
    }

    reading = $state.raw<ReadingSnapshot>({
        documentId: null,
        state: { pageNumber: 1, scrollPosition: 0, scale: 1.5, layout: "scroll" },
        status: "closed",
    })
    private pageNumber = $state(1)
    private pageScroll = $state(0)

    get currentPage() {
        return this.pageNumber
    }
    set currentPage(value: number) {
        if (this.disposed) return
        this.workspace.setPosition(value, this.pageScroll)
    }
    get scrollPosition() {
        return this.pageScroll
    }
    set scrollPosition(value: number) {
        if (this.disposed) return
        this.workspace.setPosition(this.pageNumber, value)
    }
    get scale() {
        return this.reading.state.scale
    }
    set scale(value: number) {
        this.workspace.setScale(value)
    }
    get layout(): ReadingLayout {
        return this.reading.state.layout
    }
    set layout(value: ReadingLayout) {
        this.workspace.setLayout(value)
    }

    flushReadingState(): Promise<void> {
        return this.workspace.flush()
    }

    private book = $state<Book | null>(null)
    private outlineList = $state<DocumentOutlineEntry[] | null>(null)
    private totalPages = $state<number>(0)
    isOutlineLoading = $state(false)

    private _isRestoringHistory = false
    lastSetPageState = $state<any>(null)
    private listening = false
    private bookSwitchGeneration = 0
    private disposalEpoch = 0
    private disposed = false
    workspace: ReadingWorkspace
    private readonly vfsUnsubscribers: (() => void)[] = []
    private readonly flush = () => {
        void this.workspace.flush()
    }
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
            writeSignal: this.options.writeSignal,
            defaults: this.options.defaults,
            onStorageError: this.options.onStorageError,
            onChange: (snapshot) => {
                this.reading = snapshot
                this.pageNumber = snapshot.state.pageNumber
                this.pageScroll = snapshot.state.scrollPosition
                if (this.book && this.book.id === snapshot.documentId) {
                    this.book.pageNumber = snapshot.state.pageNumber
                    this.book.scrollPosition = snapshot.state.scrollPosition
                }
            },
            getCurrentBook: () => this.book,
            publish: (book) => this.publishBook(book),
        })
    }

    private publishBook(book: Book | null): boolean {
        if (this.disposed) return false
        this.mutations.setActiveFileId(book?.id ?? null)
        this.bookSwitchGeneration++
        this.book = book
        this.pageNumber = book?.pageNumber || 1
        this.pageScroll = book?.scrollPosition || 0
        this.totalPages = book?.totalPages || 0
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
        this.pageNumber = 1
        this.pageScroll = 0
        this.reading = this.workspace.snapshot
        this.attachLibraryListeners()
    }

    dispose() {
        if (this.disposed) return
        this.disposed = true
        this.disposalEpoch++
        this.bookSwitchGeneration++
        for (const unsubscribe of this.vfsUnsubscribers.splice(0)) unsubscribe()
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
                this.book.name === book.name &&
                this.book.isLocked === book.isLocked &&
                this.book.pdfDest === book.pdfDest &&
                this.book.totalPages === book.totalPages &&
                this.book.author === book.author
            ) {
                return
            }

            this.book = {
                ...book,
                pageNumber: this.currentPage,
                scrollPosition: this.scrollPosition,
            }
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
