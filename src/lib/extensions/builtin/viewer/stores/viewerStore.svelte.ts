import { SvelteSet } from "svelte/reactivity"
import { browser } from "$app/environment"
import { pushState } from "$app/navigation"
import type { DocumentOutlineEntry } from "$lib/document-model"
import {
    isViewerLibraryCapabilityInstalled,
    getViewerLibraryCapability,
    viewerLibraryCapability as vfsStore,
} from "../viewerHost"
import { type Book, fileNodeToBook } from "./viewerStore.types"
import type { StorageNamespace } from "$lib/extension-api"

class ViewerStore {
    private files = getViewerLibraryCapability() ?? vfsStore
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
            console.error("[ViewerStore] Failed to restore book:", error)
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
    private syncPromise: Promise<void> | null = null
    private readonly pendingBookSwitches = new Map<string, number>()
    private readonly deferredStaleUrls = new Map<string, { id: string; url: string }[]>()
    private readonly vfsUnsubscribers: (() => void)[] = []
    private readonly flush = () => this.persistViewerState(true)
    private readonly handleVisibilityChange = () => {
        if (document.visibilityState === "hidden") this.flush()
    }

    constructor() {
        this.attachLibraryListeners()
    }

    private attachLibraryListeners() {
        if (!isViewerLibraryCapabilityInstalled()) return
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
                void this.setCurrentBook({
                    ...fileNodeToBook(node),
                    url: "",
                    isLocked: this.files.isLockedMap[id],
                })
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
        this.files = getViewerLibraryCapability() ?? vfsStore
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
        if (this.book?.url) this.files.revokeFileUrl(this.book.id, this.book.url)
        for (const id of this.deferredStaleUrls.keys()) this.flushDeferredStaleUrls(id)
        this.pendingBookSwitches.clear()
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
        const oldBook = this.book
        if (oldBook.url) this.releaseStaleUrl(oldBook.id, oldBook.url)
        this.book = null
        this.files.activeFileId = null
        this.persistViewerState(true)
    }

    async syncWithBooks() {
        // A sync has one URL lease to publish. Share the in-flight operation so concurrent
        // lifecycle callbacks cannot each claim and publish the same book URL.
        if (this.syncPromise) return this.syncPromise
        const operation = this.syncWithBooksUnlocked()
        this.syncPromise = operation
        void operation.then(
            () => {
                if (this.syncPromise === operation) this.syncPromise = null
            },
            () => {
                if (this.syncPromise === operation) this.syncPromise = null
            },
        )
        return operation
    }

    private async syncWithBooksUnlocked() {
        if (!this.book || this.pendingBookSwitches.size > 0) return
        const operationDisposalEpoch = this.disposalEpoch
        const operationBookSwitchGeneration = this.bookSwitchGeneration
        const bookId = this.book.id
        this.files.activeFileId = bookId
        const matchingNode = this.files.nodes[bookId]
        if (!matchingNode || matchingNode.type !== "file") {
            await this.clearDeletedBook(bookId)
            return
        }

        const contentGeneration = this.files.getContentGeneration(bookId)
        let currentUrl = this.book.url
        let acquiredUrl = false
        if (currentUrl && !this.files.isCurrentFileUrl(bookId, currentUrl, contentGeneration)) {
            // The active lease belongs to this exact URL, not to whichever URL the
            // node happens to expose after a relink.
            this.releaseStaleUrl(bookId, currentUrl)
            currentUrl = ""
        }
        if (!currentUrl) {
            currentUrl = await this.files.getFileUrl(bookId)
            acquiredUrl = !!currentUrl
        }

        if (
            this.disposed ||
            operationDisposalEpoch !== this.disposalEpoch ||
            operationBookSwitchGeneration !== this.bookSwitchGeneration ||
            this.book?.id !== bookId ||
            !this.files.isCurrentContent(bookId, contentGeneration)
        ) {
            // This operation may have acquired a new lease; release only this exact URL.
            if (acquiredUrl && currentUrl) this.releaseStaleUrl(bookId, currentUrl)
            return
        }
        const currentNode = this.files.nodes[bookId]
        if (!currentNode || currentNode.type !== "file") {
            if (acquiredUrl && currentUrl) this.releaseStaleUrl(bookId, currentUrl)
            await this.clearDeletedBook(bookId)
            return
        }

        const localPageNumber = this.book.pageNumber
        const localScrollPosition = this.book.scrollPosition

        this.book = {
            ...fileNodeToBook(currentNode),
            pageNumber: localPageNumber,
            scrollPosition: localScrollPosition,
            url: currentUrl,
            previewDataUrl: "",
            isLocked: this.files.isLockedMap[currentNode.id],
        }
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
                    console.error("[ViewerStore] Failed to persist book:", error)
                })
        }

        if (immediate) {
            save()
        } else {
            this.saveTimeout = setTimeout(save, 500)
        }
    }

    private releaseStaleUrl(id: string, url: string) {
        // Each switch owns the lease returned by getFileUrl. Release stale switches
        // immediately even when another switch for the same book is still pending.
        if (!this.files.revokeFileUrl(id, url) && this.files.fileUrls[id] === url)
            URL.revokeObjectURL(url)
    }

    private flushDeferredStaleUrls(id: string) {
        const deferred = this.deferredStaleUrls.get(id)
        if (!deferred) return
        this.deferredStaleUrls.delete(id)
        for (const { url } of deferred) {
            if (!this.disposed && this.book?.id === id && this.book.url === url) continue
            if (!this.files.revokeFileUrl(id, url) && this.files.fileUrls[id] === url)
                URL.revokeObjectURL(url)
        }
    }

    async setCurrentBook(newBook: Book | null): Promise<boolean> {
        const newBookId = newBook?.id
        if (newBookId) {
            this.pendingBookSwitches.set(
                newBookId,
                (this.pendingBookSwitches.get(newBookId) ?? 0) + 1,
            )
        }
        try {
            return await this.setCurrentBookUnlocked(newBook)
        } finally {
            if (newBookId) {
                const count = (this.pendingBookSwitches.get(newBookId) ?? 1) - 1
                if (count > 0) this.pendingBookSwitches.set(newBookId, count)
                else {
                    this.pendingBookSwitches.delete(newBookId)
                    this.flushDeferredStaleUrls(newBookId)
                }
            }
        }
    }

    private async setCurrentBookUnlocked(newBook: Book | null): Promise<boolean> {
        if (this.disposed) return false
        const oldBook = this.book
        const newBookId = newBook?.id
        const generation = ++this.bookSwitchGeneration
        const disposalEpoch = this.disposalEpoch
        const isCurrentSwitch = () =>
            !this.disposed &&
            disposalEpoch === this.disposalEpoch &&
            generation === this.bookSwitchGeneration
        const contentGeneration = newBook ? this.files.getContentGeneration(newBook.id) : undefined

        if (newBook) {
            const currentNode = this.files.nodes[newBook.id]
            if (!currentNode || currentNode.type !== "file") {
                if (newBook.url) this.releaseStaleUrl(newBook.id, newBook.url)
                await this.clearDeletedBook(newBook.id)
                return false
            }
            if (
                newBook.url &&
                !this.files.isCurrentFileUrl(newBook.id, newBook.url, contentGeneration)
            ) {
                this.releaseStaleUrl(newBook.id, newBook.url)
                return false
            }
        }

        let hasChanges = false
        if (newBook) {
            // Resolve a missing URL before publishing the replacement book. This keeps an
            // access failure from replacing a usable active book with a URL-less one.
            if (!newBook.url) {
                const loadedUrl = await this.files.getFileUrl(newBook.id)
                if (!isCurrentSwitch()) {
                    if (loadedUrl) this.releaseStaleUrl(newBook.id, loadedUrl)
                    return false
                }
                const currentNode = this.files.nodes[newBook.id]
                if (
                    !currentNode ||
                    currentNode.type !== "file" ||
                    !loadedUrl ||
                    !this.files.isCurrentContent(newBook.id, contentGeneration!) ||
                    !this.files.isCurrentFileUrl(newBook.id, loadedUrl, contentGeneration)
                ) {
                    if (loadedUrl) this.releaseStaleUrl(newBook.id, loadedUrl)
                    if (!currentNode || currentNode.type !== "file") {
                        await this.clearDeletedBook(newBook.id)
                    } else if (oldBook?.id === newBook.id && this.book?.id === newBook.id) {
                        // The old URL was revoked by relinking; keep the previous book identity
                        // but expose the failed access as locked rather than publishing a blank,
                        // unlocked replacement.
                        this.book = {
                            ...oldBook,
                            url: "",
                            isLocked: this.files.isLockedMap[newBook.id] ?? true,
                        }
                        this.persistViewerState(true)
                    }
                    return false
                }
                newBook.url = loadedUrl
                hasChanges = true
            }
        }

        // A replacement owns the old lease only until the replacement commits. Compare
        // exact URLs so same-ID relinks cannot strand the previous URL lease.
        if (oldBook?.url && (oldBook.id !== newBookId || oldBook.url !== newBook?.url)) {
            this.releaseStaleUrl(oldBook.id, oldBook.url)
        }

        // Set the active book state only after a missing URL has been resolved.
        this.book = newBook
        this.files.activeFileId = newBookId ?? null
        this.persistViewerState(true)

        if (newBook) {
            this.currentPage = newBook.pageNumber || 1
            this.scrollPosition = newBook.scrollPosition || 0
            this.totalPages = newBook.totalPages || 0
            const isLocked = this.files.isLockedMap[newBook.id]
            if (newBook.isLocked !== isLocked) {
                newBook.isLocked = isLocked
                hasChanges = true
            }

            // Only update reactive state if we haven't switched to a different book in the meantime
            if (this.book && this.book.id === newBook.id) {
                if (hasChanges) {
                    this.book = { ...newBook }
                }
                this.persistViewerState(true)
            }
        }
        return true
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

        await this.files.updateFile(
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

export const viewerStore = new ViewerStore()

if (import.meta.hot) {
    import.meta.hot.dispose(() => viewerStore.dispose())
}
