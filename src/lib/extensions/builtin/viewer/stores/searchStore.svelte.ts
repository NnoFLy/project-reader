import { SvelteMap } from "svelte/reactivity"
import { viewerStore } from "./viewerStore.svelte"
import {
    isViewerLibraryCapabilityInstalled,
    getViewerLibraryCapability,
    viewerLibraryCapability as vfsStore,
} from "../viewerHost"
import type { ViewerDocument } from "../viewerDocument"
import { getSafeStorage } from "$lib/shared/state/safeStorage"
import { untrack } from "svelte"
import {
    LocalSearchHistoryRepository,
    type SearchHistoryRepository,
} from "./searchHistoryRepository"

export interface SearchMatch {
    pageNumber: number
    start: number
    end: number
}

export class SearchStore {
    private files = getViewerLibraryCapability() ?? vfsStore
    query = $state("")
    matches = $state.raw<SearchMatch[]>([])
    private _currentMatchIndex = $state(-1)
    get currentMatchIndex() {
        return this._currentMatchIndex
    }
    set currentMatchIndex(value: number) {
        this._currentMatchIndex = value
        this.updateCSSHighlights()
    }

    isActive = $state(false)
    isIndexing = $state(false)
    isSearching = $state(false)
    pageTexts = new SvelteMap<number, { original: string }>()

    searchHistory = $state<string[]>([])
    searchStartPage = $state<number | null>(null)

    private readonly historyRepository: SearchHistoryRepository
    private currentPdf: ViewerDocument | null = null
    private currentBookId: string | null = null

    constructor(
        historyRepository: SearchHistoryRepository = new LocalSearchHistoryRepository(
            getSafeStorage(),
        ),
    ) {
        this.historyRepository = historyRepository
        this.vfsUnsubscribe = isViewerLibraryCapabilityInstalled()
            ? this.files.onContentRestored((bookId) => {
                  if (this.currentBookId !== bookId || !this.currentPdf) return
                  this.restartIndexing()
              })
            : () => undefined
    }

    private restartIndexing() {
        const pdf = this.currentPdf
        const bookId = this.currentBookId
        if (!pdf || !bookId) return

        const query = this.query
        this.searchRequestId += 1
        this.documentGeneration += 1
        this.matches = []
        this.notifyMatchesChanged()
        this._currentMatchIndex = -1
        this.isSearching = false
        this.pageTexts.clear()
        this.pageRanges.clear()
        this.currentSearchAbortController?.abort()
        this.currentSearchAbortController = null
        this.indexingAbortController?.abort()
        this.indexingAbortController = null
        this.isActive = Boolean(query.trim())
        this.isIndexing = false
        this.updateCSSHighlights()
        void this.startIndexing()
    }

    addToHistory(q: string) {
        const bookId = this.currentBookId
        const trimmed = q.trim()
        if (!bookId || !trimmed) return

        const filtered = this.searchHistory.filter(
            (item) => item.toLocaleLowerCase() !== trimmed.toLocaleLowerCase(),
        )
        this.searchHistory = [trimmed, ...filtered].slice(0, 10)
        this.historyRepository.save(bookId, this.searchHistory)
    }

    clearHistory() {
        const bookId = this.currentBookId
        if (!bookId) return
        this.searchHistory = []
        this.historyRepository.clear(bookId)
    }
    private pageRanges = new SvelteMap<number, Range[]>()
    private searchTimeoutId: any = null
    private currentSearchAbortController: AbortController | null = null
    private indexingAbortController: AbortController | null = null
    private vfsUnsubscribe: () => void
    private searchRequestId = 0
    private documentGeneration = 0
    private matchesChangedListeners = new Set<() => void>()

    onMatchesChanged(listener: () => void) {
        this.matchesChangedListeners.add(listener)
        return () => this.matchesChangedListeners.delete(listener)
    }

    private notifyMatchesChanged() {
        for (const listener of this.matchesChangedListeners) listener()
    }

    initDocument({ pdf, bookId }: { pdf: ViewerDocument; bookId: string }) {
        if (this.currentPdf === pdf && this.currentBookId === bookId) return
        this.currentPdf = pdf
        this.currentBookId = bookId
        this.searchRequestId += 1
        this.documentGeneration += 1

        this.isActive = false
        this.query = ""
        this.matches = []
        this.notifyMatchesChanged()
        this._currentMatchIndex = -1
        this.searchStartPage = null
        this.isSearching = false
        this.searchHistory = this.historyRepository.load(bookId)
        this.pageTexts.clear()
        this.pageRanges.clear()
        this.updateCSSHighlights()

        if (this.searchTimeoutId) {
            clearTimeout(this.searchTimeoutId)
            this.searchTimeoutId = null
        }
        if (this.currentSearchAbortController) {
            this.currentSearchAbortController.abort()
            this.currentSearchAbortController = null
        }
        this.indexingAbortController?.abort()
        this.indexingAbortController = null

        this.isIndexing = false
    }

    async startIndexing() {
        if (!this.currentPdf || this.isIndexing || this.pageTexts.size > 0) return

        const pdf = this.currentPdf
        const bookId = this.currentBookId
        if (!bookId) return
        this.isIndexing = true
        const controller = new AbortController()
        this.indexingAbortController = controller
        const { signal } = controller
        const totalPages = pdf.pageCount
        const generation = this.files.getContentGeneration(bookId)

        try {
            // 1. Try to load from IndexedDB first
            const cachedTexts = await this.files.db.indexedTexts.getByBookId(bookId)
            if (
                cachedTexts &&
                cachedTexts.length === totalPages &&
                this.currentPdf === pdf &&
                this.currentBookId === bookId &&
                this.files.isCurrentContent(bookId, generation)
            ) {
                const tempMap = new Map<number, { original: string }>()
                for (const record of cachedTexts) {
                    tempMap.set(record.pageNumber, { original: record.text })
                }
                // Batch update to SvelteMap
                for (const [pageNum, text] of tempMap) {
                    if (
                        this.currentPdf !== pdf ||
                        this.currentBookId !== bookId ||
                        !this.files.isCurrentContent(bookId, generation)
                    )
                        return
                    this.pageTexts.set(pageNum, text)
                }
                return
            }

            // 2. Extract through a bounded queue instead of allocating one promise per page.
            const documentGeneration = this.documentGeneration
            let nextPage = 1
            let recordsToSave: { pageNumber: number; text: string }[] = []
            const isCurrent = () =>
                !signal.aborted &&
                this.documentGeneration === documentGeneration &&
                this.currentPdf === pdf &&
                this.currentBookId === bookId &&
                this.files.isCurrentContent(bookId, generation)
            const flushRecords = async () => {
                if (!recordsToSave.length || !isCurrent()) return
                const batch = recordsToSave
                recordsToSave = []
                await this.files.saveIndexedTexts(
                    bookId,
                    batch.map((record) => ({
                        id: `${bookId}_${record.pageNumber}`,
                        bookId,
                        pageNumber: record.pageNumber,
                        text: record.text,
                    })),
                    generation,
                )
            }
            const extractPage = async (pageNumber: number) => {
                for (let attempt = 0; attempt < 2; attempt += 1) {
                    if (!isCurrent()) return null
                    try {
                        return await pdf.getText(pageNumber)
                    } catch (error) {
                        if (attempt === 1) {
                            console.warn(
                                `[SearchStore] Failed to extract page ${pageNumber} after retry:`,
                                error,
                            )
                            return null
                        }
                        await new Promise((resolve) => setTimeout(resolve, 25))
                    }
                }
                return null
            }
            const extract = async () => {
                while (isCurrent()) {
                    const pageNumber = nextPage++
                    if (pageNumber > totalPages) return
                    const textContent = await extractPage(pageNumber)
                    if (!isCurrent()) return
                    if (!textContent) continue
                    const text = textContent.map((item) => item.text).join("")
                    this.pageTexts.set(pageNumber, { original: text })
                    recordsToSave.push({ pageNumber, text })
                    if (recordsToSave.length >= 25) await flushRecords()
                    await new Promise((resolve) => setTimeout(resolve, 4))
                }
            }

            const extractionResults = await Promise.allSettled([extract(), extract()])
            for (const result of extractionResults) {
                if (result.status === "rejected" && !signal.aborted) {
                    console.error("[SearchStore] Failed to extract PDF text:", result.reason)
                }
            }
            await flushRecords()
        } catch (e) {
            if (!signal.aborted) console.error("[SearchStore] Failed to index PDF:", e)
        } finally {
            if (this.indexingAbortController === controller) {
                this.indexingAbortController = null
                if (this.currentPdf === pdf && this.currentBookId === bookId) {
                    this.isIndexing = false
                    if (this.query.trim() && this.files.isCurrentContent(bookId, generation)) {
                        this.setQuery(this.query)
                    }
                }
            }
        }
    }

    begin(startPage: number) {
        this.searchStartPage = startPage
    }

    setQuery(newQuery: string) {
        this.searchRequestId += 1
        this.query = newQuery

        if (this.searchTimeoutId) {
            clearTimeout(this.searchTimeoutId)
            this.searchTimeoutId = null
        }

        if (this.currentSearchAbortController) {
            this.currentSearchAbortController.abort()
            this.currentSearchAbortController = null
        }
        const trimmed = newQuery.trim()
        if (!trimmed) {
            this.isActive = false
            this.matches = []
            this.notifyMatchesChanged()
            this._currentMatchIndex = -1
            this.isSearching = false
            this.pageRanges.clear()
            this.updateCSSHighlights()
            return
        }

        this.isActive = true
        this.isSearching = true
        if (this.isIndexing) return
        if (this.pageTexts.size === 0) {
            this.isSearching = false
            this.notifyMatchesChanged()
            return
        }
        this.searchTimeoutId = setTimeout(() => {
            void this.runSearch(trimmed)
        }, 150)
    }

    private async runSearch(q: string) {
        const document = this.currentPdf
        const bookId = this.currentBookId
        const searchId = this.searchRequestId
        const controller = new AbortController()
        this.currentSearchAbortController = controller
        const normalizedQuery = q.toLocaleLowerCase()
        const startPage = this.searchStartPage ?? 1
        const pageNumbers = [...this.pageTexts.keys()].sort((a, b) => {
            const distanceA = a >= startPage ? a - startPage : a + this.pageTexts.size
            const distanceB = b >= startPage ? b - startPage : b + this.pageTexts.size
            return distanceA - distanceB
        })
        const matches: SearchMatch[] = []

        for (const pageNumber of pageNumbers) {
            if (
                controller.signal.aborted ||
                this.currentPdf !== document ||
                this.currentBookId !== bookId ||
                this.query.trim() !== q ||
                this.searchRequestId !== searchId
            )
                return
            const text = this.pageTexts.get(pageNumber)?.original.toLocaleLowerCase() ?? ""
            let index = text.indexOf(normalizedQuery)
            while (index !== -1 && matches.length < 10000) {
                matches.push({ pageNumber, start: index, end: index + normalizedQuery.length })
                index = text.indexOf(normalizedQuery, index + 1)
            }
            if (matches.length >= 10000) break
            await new Promise<void>((resolve) => setTimeout(resolve, 0))
        }

        if (
            controller.signal.aborted ||
            this.currentPdf !== document ||
            this.currentBookId !== bookId ||
            this.searchRequestId !== searchId
        )
            return
        this.matches = matches
        this.isSearching = false
        this.currentSearchAbortController = null
        this.notifyMatchesChanged()
        this._currentMatchIndex = this.findNearestMatchIndex(matches, startPage)
        if (this._currentMatchIndex !== -1) this.goToCurrentMatch()
        this.updateCSSHighlights()
    }

    selectMatch(query: string, matchIndex: number): SearchMatch | undefined {
        const match = this.matches[matchIndex]
        if (!match) return undefined
        this.addToHistory(query)
        this.currentMatchIndex = matchIndex
        this.isActive = true
        return match
    }

    next() {
        if (this.matches.length === 0) return
        this.currentMatchIndex = (this.currentMatchIndex + 1) % this.matches.length
        this.goToCurrentMatch()
    }

    previous() {
        if (this.matches.length === 0) return
        this.currentMatchIndex =
            (this.currentMatchIndex - 1 + this.matches.length) % this.matches.length
        this.goToCurrentMatch()
    }

    prev() {
        this.previous()
    }

    close() {
        this.isActive = false
        this.setQuery("")
    }

    private goToCurrentMatch() {
        if (this.currentMatchIndex >= 0 && this.currentMatchIndex < this.matches.length) {
            const match = this.matches[this.currentMatchIndex]
            const currentBook = viewerStore.getCurrentBook()

            // Only trigger a page jump if the match is on a different page.
            // This prevents resetting scrollPosition to 0 for matches on the same page.
            if (currentBook && currentBook.pageNumber !== match.pageNumber) {
                if (viewerStore.goToPage) {
                    viewerStore.goToPage(match.pageNumber)
                }
            }
        }
    }

    private findNearestMatchIndex(matches: SearchMatch[], targetPage: number): number {
        if (matches.length === 0) return -1
        let nearestIdx = 0
        let minDistance = Infinity
        for (let i = 0; i < matches.length; i++) {
            const dist = Math.abs(matches[i].pageNumber - targetPage)
            if (dist < minDistance) {
                minDistance = dist
                nearestIdx = i
            }
        }
        return nearestIdx
    }

    get activeRange(): Range | null {
        if (this._currentMatchIndex < 0 || this._currentMatchIndex >= this.matches.length) {
            return null
        }
        const activeMatch = this.matches[this._currentMatchIndex]
        const ranges = this.pageRanges.get(activeMatch.pageNumber)
        if (!ranges) return null

        // Scan backward to count how many matches on the same page precede activeMatch
        let indexOnPage = 0
        for (let i = this._currentMatchIndex - 1; i >= 0; i--) {
            if (this.matches[i].pageNumber === activeMatch.pageNumber) {
                indexOnPage++
            } else {
                break
            }
        }

        if (indexOnPage < ranges.length) {
            return ranges[indexOnPage]
        }
        return null
    }

    private highlightUpdatePending = false
    private highlightFrameId: number | null = null

    registerPageRanges(pageNumber: number, ranges: Range[]) {
        this.pageRanges.set(pageNumber, ranges)
        this.queueHighlightUpdate()
    }

    unregisterPageRanges(pageNumber: number) {
        if (this.pageRanges.has(pageNumber)) {
            this.pageRanges.delete(pageNumber)
            this.queueHighlightUpdate()
        }
    }

    private queueHighlightUpdate() {
        if (this.highlightUpdatePending) return
        this.highlightUpdatePending = true
        if (typeof requestAnimationFrame !== "undefined") {
            this.highlightFrameId = requestAnimationFrame(() => {
                this.highlightFrameId = null
                this.highlightUpdatePending = false
                this.updateCSSHighlights()
            })
        } else {
            this.highlightUpdatePending = false
            this.updateCSSHighlights()
        }
    }

    private updateCSSHighlights() {
        if (typeof CSS === "undefined" || !CSS.highlights) return

        untrack(() => {
            const allMatchRanges: Range[] = []
            const allActiveRanges: Range[] = []
            const activeRange = this.activeRange

            for (const ranges of this.pageRanges.values()) {
                for (const r of ranges) {
                    if (
                        r &&
                        r.startContainer &&
                        r.startContainer.isConnected &&
                        r.endContainer &&
                        r.endContainer.isConnected
                    ) {
                        if (r === activeRange) {
                            allActiveRanges.push(r)
                        } else {
                            allMatchRanges.push(r)
                        }
                    }
                }
            }

            try {
                CSS.highlights.set("search-match", new Highlight(...allMatchRanges))
                CSS.highlights.set("search-match-active", new Highlight(...allActiveRanges))
            } catch (e) {
                console.error("[SearchStore] Failed to update CSS Highlights:", e)
            }
        })
    }

    resetLifecycle() {
        this.dispose()
        this.files = getViewerLibraryCapability() ?? vfsStore
        this.vfsUnsubscribe = isViewerLibraryCapabilityInstalled()
            ? this.files.onContentRestored((bookId) => {
                  if (this.currentBookId !== bookId || !this.currentPdf) return
                  this.restartIndexing()
              })
            : () => undefined
    }

    dispose() {
        this.vfsUnsubscribe()
        this.reset()
        if (this.highlightFrameId !== null && typeof cancelAnimationFrame !== "undefined") {
            cancelAnimationFrame(this.highlightFrameId)
            this.highlightFrameId = null
            this.highlightUpdatePending = false
        }
        this.matchesChangedListeners.clear()
        if (typeof CSS !== "undefined" && CSS.highlights) {
            CSS.highlights.delete("search-match")
            CSS.highlights.delete("search-match-active")
        }
    }

    reset() {
        this.searchRequestId += 1
        this.documentGeneration += 1
        this.currentPdf = null
        this.currentBookId = null
        this.isActive = false
        this.query = ""
        this.matches = []
        this.notifyMatchesChanged()
        this._currentMatchIndex = -1
        this.searchStartPage = null
        this.isSearching = false
        this.searchHistory = []
        this.pageTexts.clear()
        this.pageRanges.clear()
        this.isIndexing = false
        if (this.searchTimeoutId) {
            clearTimeout(this.searchTimeoutId)
            this.searchTimeoutId = null
        }
        if (this.currentSearchAbortController) {
            this.currentSearchAbortController.abort()
            this.currentSearchAbortController = null
        }
        this.indexingAbortController?.abort()
        this.indexingAbortController = null
        if (this.highlightFrameId !== null && typeof cancelAnimationFrame !== "undefined") {
            cancelAnimationFrame(this.highlightFrameId)
            this.highlightFrameId = null
            this.highlightUpdatePending = false
        }
        this.updateCSSHighlights()
    }
}

export const searchStore = new SearchStore()

if (import.meta.hot) {
    import.meta.hot.dispose(() => searchStore.dispose())
}
