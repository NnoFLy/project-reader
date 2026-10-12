import { afterEach, describe, expect, it, vi } from "vitest"
import { buildBookmarkItems, buildSearchItems, parsePage } from "./viewerPromptItems"
import { SearchStore, searchStore } from "../stores/searchStore.svelte"
import { LocalSearchHistoryRepository, normalizeHistory } from "../stores/searchHistoryRepository"
import { vfsStore } from "$lib/modules/documents"
import type { ViewerDocument } from "../viewerDocument"

afterEach(() => {
    searchStore.reset()
    delete vfsStore.nodes["cached-book"]
    delete vfsStore.nodes["search-book"]
    delete vfsStore.nodes["cancelled-book"]
})

describe("viewer Prompt item builders", () => {
    it("parses and clamps page input", () => {
        expect(parsePage("", 4, 20)).toBe(4)
        expect(parsePage("99", 4, 20)).toBe(20)
        expect(parsePage("0", 4, 20)).toBeUndefined()
    })

    it("builds history for an empty query and capped match results otherwise", () => {
        expect(
            buildSearchItems({
                query: "",
                history: ["Needle"],
                matches: [],
                pageText: () => "",
            })[0]?.value,
        ).toEqual({ kind: "history", query: "Needle" })

        const items = buildSearchItems({
            query: "needle",
            history: [],
            matches: Array.from({ length: 205 }, (_, index) => ({
                pageNumber: index + 1,
                start: 0,
                end: 6,
            })),
            pageText: () => "needle in context",
        })
        expect(items).toHaveLength(200)
        expect(items[0]?.id).toBe("search-match-1-0-6")
    })

    it("builds bookmark items without reading stores", () => {
        const items = buildBookmarkItems(
            [
                {
                    id: "bookmark-1",
                    bookId: "book-1",
                    pageNumber: 7,
                    name: "Chapter",
                    createdAt: 1,
                },
            ],
            () => "Book",
        )
        expect(items[0]).toMatchObject({
            id: "bookmark-1",
            label: "Chapter",
            value: "bookmark-1",
        })
    })
})

describe("viewer search indexing", () => {
    it("reruns a waiting query after uncached full indexing", async () => {
        vfsStore.nodes["search-book"] = { id: "search-book", type: "file" } as any
        vi.spyOn(vfsStore.db.indexedTexts, "getByBookId").mockResolvedValueOnce([])
        vi.spyOn(vfsStore.db.indexedTexts, "bulkPut").mockResolvedValueOnce("search-book_1")
        const pdf = {
            pageCount: 1,
            getText: vi.fn().mockResolvedValue([{ text: "needle" }]),
        } as unknown as ViewerDocument
        searchStore.initDocument({ pdf, bookId: "search-book" })
        searchStore.setQuery("needle")
        const setQuery = vi.spyOn(searchStore, "setQuery")

        await searchStore.startIndexing()

        expect(pdf.getText).toHaveBeenCalledWith(1)
        expect(setQuery).toHaveBeenCalledWith("needle")
        expect(searchStore.pageTexts.get(1)?.original).toBe("needle")
    })

    it("does not let cancelled indexing clear replacement indexing state", async () => {
        const store = new SearchStore()
        vfsStore.nodes["replacement-book"] = { id: "replacement-book", type: "file" } as any
        vi.spyOn(vfsStore.db.indexedTexts, "getByBookId").mockResolvedValue([])
        const resolvers: ((value: { text: string }[]) => void)[] = []
        const pdf = {
            pageCount: 1,
            getText: vi.fn(
                () =>
                    new Promise<{ text: string }[]>((resolve) => {
                        resolvers.push(resolve)
                    }),
            ),
        } as unknown as ViewerDocument
        store.initDocument({ pdf, bookId: "replacement-book" })

        const firstIndex = store.startIndexing()
        await vi.waitFor(() => expect(resolvers).toHaveLength(1))
        ;(store as any).restartIndexing()
        await vi.waitFor(() => expect(resolvers).toHaveLength(2))
        expect(store.isIndexing).toBe(true)

        resolvers[0]([{ text: "stale" }])
        await firstIndex
        expect(store.isIndexing).toBe(true)

        resolvers[1]([{ text: "fresh" }])
        await vi.waitFor(() => expect(store.isIndexing).toBe(false))
        expect(store.pageTexts.get(1)?.original).toBe("fresh")
        store.dispose()
    })

    it("retries a failed page extraction before completing indexing", async () => {
        vfsStore.nodes["retry-book"] = { id: "retry-book", type: "file" } as any
        vi.spyOn(vfsStore.db.indexedTexts, "getByBookId").mockResolvedValueOnce([])
        vi.spyOn(vfsStore.db.indexedTexts, "bulkPut").mockResolvedValueOnce("retry-book_1")
        const pdf = {
            pageCount: 1,
            getText: vi
                .fn()
                .mockRejectedValueOnce(new Error("temporary extraction failure"))
                .mockResolvedValueOnce([{ text: "retried" }]),
        } as unknown as ViewerDocument
        searchStore.initDocument({ pdf, bookId: "retry-book" })

        await searchStore.startIndexing()

        expect(pdf.getText).toHaveBeenCalledTimes(2)
        expect(searchStore.pageTexts.get(1)?.original).toBe("retried")
        expect(searchStore.isIndexing).toBe(false)
        delete vfsStore.nodes["retry-book"]
    })

    it("stops requesting pages after reset during extraction", async () => {
        vfsStore.nodes["cancelled-book"] = { id: "cancelled-book", type: "file" } as any
        vi.spyOn(vfsStore.db.indexedTexts, "getByBookId").mockResolvedValueOnce([])
        const textResolvers: ((value: { text: string }[]) => void)[] = []
        const pdf = {
            pageCount: 20,
            getText: vi.fn(
                () =>
                    new Promise<{ text: string }[]>((resolve) => {
                        textResolvers.push(resolve)
                    }),
            ),
        } as unknown as ViewerDocument
        searchStore.initDocument({ pdf, bookId: "cancelled-book" })

        const indexing = searchStore.startIndexing()
        await vi.waitFor(() => expect(pdf.getText).toHaveBeenCalled())
        searchStore.reset()
        for (const resolve of textResolvers) resolve([{ text: "stale" }])
        await indexing

        expect(pdf.getText).toHaveBeenCalledTimes(2)
        expect(searchStore.pageTexts.size).toBe(0)
        expect(searchStore.isIndexing).toBe(false)
    })

    it("loads cached text by the explicit book id", async () => {
        vfsStore.nodes["cached-book"] = {
            id: "cached-book",
            name: "cached-book.pdf",
            type: "file",
            parentId: null,
            size: 1,
            createdAt: 1,
            updatedAt: 1,
            isPinned: false,
            metadata: { pageNumber: 1 },
        }
        const getByBookId = vi
            .spyOn(vfsStore.db.indexedTexts, "getByBookId")
            .mockResolvedValueOnce([
                { id: "cached-book_1", bookId: "cached-book", pageNumber: 1, text: "cached" },
            ])
        const pdf = { pageCount: 1, getText: vi.fn() } as unknown as ViewerDocument
        searchStore.initDocument({ pdf, bookId: "cached-book" })

        await searchStore.startIndexing()

        expect(getByBookId).toHaveBeenCalledWith("cached-book")
        expect(pdf.getText).not.toHaveBeenCalled()
        expect(searchStore.pageTexts.get(1)?.original).toBe("cached")
        delete vfsStore.nodes["cached-book"]
    })
})

describe("search history repository", () => {
    function storage() {
        const values = new Map<string, string>()
        return {
            getItem: (key: string) => values.get(key) ?? null,
            setItem: (key: string, value: string) => values.set(key, value),
            removeItem: (key: string) => values.delete(key),
        }
    }

    it("deduplicates case-insensitively and caps each history", () => {
        expect(
            normalizeHistory(["One", "one", ...Array.from({ length: 12 }, (_, i) => `${i}`)]),
        ).toEqual(["One", "0", "1", "2", "3", "4", "5", "6", "7", "8"])
    })

    it("isolates and clears histories by book", () => {
        const repository = new LocalSearchHistoryRepository(storage())
        repository.save("book-a", ["alpha"])
        repository.save("book-b", ["beta"])
        repository.clear("book-a")
        expect(repository.load("book-a")).toEqual([])
        expect(repository.load("book-b")).toEqual(["beta"])
    })

    it("loads and persists history for the active book session", () => {
        const repository = new LocalSearchHistoryRepository(storage())
        const store = new SearchStore(repository)
        const pdfA = { pageCount: 1 } as ViewerDocument
        const pdfB = { pageCount: 1 } as ViewerDocument

        store.initDocument({ pdf: pdfA, bookId: "book-a" })
        store.addToHistory("alpha")
        store.initDocument({ pdf: pdfB, bookId: "book-b" })
        store.addToHistory("beta")
        store.initDocument({ pdf: pdfA, bookId: "book-a" })

        expect(store.searchHistory).toEqual(["alpha"])
        store.clearHistory()
        expect(repository.load("book-a")).toEqual([])
        expect(repository.load("book-b")).toEqual(["beta"])
    })

    it("fails safely for malformed storage", () => {
        const broken = storage()
        broken.setItem("viewer.searchHistory.v1", "not-json")
        expect(new LocalSearchHistoryRepository(broken).load("book")).toEqual([])
    })
})
