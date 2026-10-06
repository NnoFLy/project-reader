import { SvelteSet } from "svelte/reactivity"
import { browser } from "$app/environment"
import { pushState } from "$app/navigation"
import type { FlatHeading } from "$lib/modules/pdf"
import { vfsStore } from "$lib/modules/documents"
import { type Book, fileNodeToBook } from "./viewerStore.types"
import { safeStorageGet, safeStorageRemove, safeStorageSet } from "$lib/shared/state/safeStorage"

class ViewerStore {
    private book = $state<Book | null>(null)
    private outlineList = $state<FlatHeading[] | null>(null)
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
    private readonly flush = () => this.persistToLocalStorage(true)
    private readonly handleVisibilityChange = () => {
        if (document.visibilityState === "hidden") this.flush()
    }

    constructor() {
        this.vfsUnsubscribers.push(
            vfsStore.onNodesDeleted?.((ids) => {
                if (this.book && ids.includes(this.book.id))
                    void this.clearDeletedBook(this.book.id)
            }) ?? (() => undefined),
        )
        this.vfsUnsubscribers.push(
            vfsStore.onNodeRelinked?.((id) => {
                const node = vfsStore.nodes[id]
                if (!node || node.type !== "file" || this.book?.id !== id) return
                void this.setCurrentBook({
                    ...fileNodeToBook(node),
                    url: "",
                    isLocked: vfsStore.isLockedMap[id],
                })
            }) ?? (() => undefined),
        )

        if (browser) {
            const savedBook = safeStorageGet("book")
            if (savedBook) {
                try {
                    const parsed = JSON.parse(savedBook) as Book
                    // Clean up any stale blob URLs from storage
                    if (parsed.url?.startsWith("blob:")) parsed.url = ""
                    if (parsed.previewDataUrl?.startsWith("blob:")) parsed.previewDataUrl = ""
                    this.book = parsed
                    this.currentPage = parsed.pageNumber || 1
                    this.scrollPosition = parsed.scrollPosition || 0
                } catch (e) {
                    console.error("Failed to parse book from localStorage", e)
                }
            }

            window.addEventListener("visibilitychange", this.handleVisibilityChange)
            window.addEventListener("beforeunload", this.flush)
            this.listening = true
        }
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
        if (this.book?.url) vfsStore.revokeFileUrl(this.book.id, this.book.url)
        for (const id of this.deferredStaleUrls.keys()) this.flushDeferredStaleUrls(id)
        this.pendingBookSwitches.clear()
    }

    get isRestoringHistory() {
        return this._isRestoringHistory
    }

    get activeOutline() {
        return this.outlineList
    }
    set activeOutline(list: FlatHeading[] | null) {
        this.outlineList = list
    }

    activeHeadings = $derived.by(() => {
        if (!this.outlineList || this.outlineList.length === 0) return new SvelteSet<FlatHeading>()

        const onCurrentPage = this.outlineList.filter((h) => h.pageNumber === this.currentPage)
        if (onCurrentPage.length > 0) {
            return new SvelteSet<FlatHeading>(onCurrentPage)
        }

        let precedingCandidate: FlatHeading | null = null
        for (const heading of this.outlineList) {
            if (heading.pageNumber !== undefined && heading.pageNumber < this.currentPage) {
                if (!precedingCandidate || heading.pageNumber >= precedingCandidate.pageNumber!) {
                    precedingCandidate = heading
                }
            }
        }

        const activeSet = new SvelteSet<FlatHeading>()
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
        if (this.book?.id !== id || vfsStore.nodes[id]?.type === "file") return
        const oldBook = this.book
        if (oldBook.url) this.releaseStaleUrl(oldBook.id, oldBook.url)
        this.book = null
        vfsStore.activeFileId = null
        this.persistToLocalStorage(true)
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
        vfsStore.activeFileId = bookId
        const matchingNode = vfsStore.nodes[bookId]
        if (!matchingNode || matchingNode.type !== "file") {
            await this.clearDeletedBook(bookId)
            return
        }

        const contentGeneration = vfsStore.getContentGeneration(bookId)
        let currentUrl = this.book.url
        let acquiredUrl = false
        if (currentUrl && !vfsStore.isCurrentFileUrl(bookId, currentUrl, contentGeneration)) {
            // The active lease belongs to this exact URL, not to whichever URL the
            // node happens to expose after a relink.
            this.releaseStaleUrl(bookId, currentUrl)
            currentUrl = ""
        }
        if (!currentUrl) {
            currentUrl = await vfsStore.getFileUrl(bookId)
            acquiredUrl = !!currentUrl
        }

        if (
            this.disposed ||
            operationDisposalEpoch !== this.disposalEpoch ||
            operationBookSwitchGeneration !== this.bookSwitchGeneration ||
            this.book?.id !== bookId ||
            !vfsStore.isCurrentContent(bookId, contentGeneration)
        ) {
            // This operation may have acquired a new lease; release only this exact URL.
            if (acquiredUrl && currentUrl) this.releaseStaleUrl(bookId, currentUrl)
            return
        }
        const currentNode = vfsStore.nodes[bookId]
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
            isLocked: vfsStore.isLockedMap[currentNode.id],
        }
    }

    private saveTimeout: ReturnType<typeof setTimeout> | null = null

    private persistToLocalStorage(immediate = false) {
        if (!browser) return

        if (this.saveTimeout) {
            clearTimeout(this.saveTimeout)
            this.saveTimeout = null
        }

        const save = () => {
            if (this.book) {
                const clean = { ...this.book }
                // Never persist blob URLs
                if (clean.url?.startsWith("blob:")) clean.url = ""
                if (clean.previewDataUrl?.startsWith("blob:")) clean.previewDataUrl = ""
                safeStorageSet("book", JSON.stringify(clean))
            } else {
                safeStorageRemove("book")
            }
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
        if (!vfsStore.revokeFileUrl(id, url) && vfsStore.fileUrls[id] === url)
            URL.revokeObjectURL(url)
    }

    private flushDeferredStaleUrls(id: string) {
        const deferred = this.deferredStaleUrls.get(id)
        if (!deferred) return
        this.deferredStaleUrls.delete(id)
        for (const { url } of deferred) {
            if (!this.disposed && this.book?.id === id && this.book.url === url) continue
            if (!vfsStore.revokeFileUrl(id, url) && vfsStore.fileUrls[id] === url)
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
        const contentGeneration = newBook ? vfsStore.getContentGeneration(newBook.id) : undefined

        if (newBook) {
            const currentNode = vfsStore.nodes[newBook.id]
            if (!currentNode || currentNode.type !== "file") {
                if (newBook.url) this.releaseStaleUrl(newBook.id, newBook.url)
                await this.clearDeletedBook(newBook.id)
                return false
            }
            if (
                newBook.url &&
                !vfsStore.isCurrentFileUrl(newBook.id, newBook.url, contentGeneration)
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
                const loadedUrl = await vfsStore.getFileUrl(newBook.id)
                if (!isCurrentSwitch()) {
                    if (loadedUrl) this.releaseStaleUrl(newBook.id, loadedUrl)
                    return false
                }
                const currentNode = vfsStore.nodes[newBook.id]
                if (
                    !currentNode ||
                    currentNode.type !== "file" ||
                    !loadedUrl ||
                    !vfsStore.isCurrentContent(newBook.id, contentGeneration!) ||
                    !vfsStore.isCurrentFileUrl(newBook.id, loadedUrl, contentGeneration)
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
                            isLocked: vfsStore.isLockedMap[newBook.id] ?? true,
                        }
                        this.persistToLocalStorage(true)
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
        vfsStore.activeFileId = newBookId ?? null
        this.persistToLocalStorage(true)

        if (newBook) {
            this.currentPage = newBook.pageNumber || 1
            this.scrollPosition = newBook.scrollPosition || 0
            this.totalPages = newBook.totalPages || 0
            const isLocked = vfsStore.isLockedMap[newBook.id]
            if (newBook.isLocked !== isLocked) {
                newBook.isLocked = isLocked
                hasChanges = true
            }

            // Only update reactive state if we haven't switched to a different book in the meantime
            if (this.book && this.book.id === newBook.id) {
                if (hasChanges) {
                    this.book = { ...newBook }
                }
                this.persistToLocalStorage(true)
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
        if (this.disposed || vfsStore.isDisposed) return
        const operationDisposalEpoch = this.disposalEpoch
        const resolvedExpectedGeneration =
            expectedGeneration ?? vfsStore.getContentGeneration(book.id)
        const resolvedExpectedBookSwitchGeneration =
            expectedBookSwitchGeneration ?? this.bookSwitchGeneration
        if (
            operationDisposalEpoch !== this.disposalEpoch ||
            resolvedExpectedBookSwitchGeneration !== this.bookSwitchGeneration
        )
            return

        await vfsStore.updateFile(
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
            vfsStore.isDisposed ||
            operationDisposalEpoch !== this.disposalEpoch ||
            resolvedExpectedBookSwitchGeneration !== this.bookSwitchGeneration ||
            !vfsStore.isCurrentContent(book.id, resolvedExpectedGeneration)
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
            this.persistToLocalStorage(false)
        }
    }
}

export const viewerStore = new ViewerStore()

if (import.meta.hot) {
    import.meta.hot.dispose(() => viewerStore.dispose())
}
