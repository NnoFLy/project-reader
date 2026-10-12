import type { Bookmark } from "$lib/modules/documents"
import type { PromptItem } from "$lib/modules/prompt"
import type { SearchMatch } from "../stores/searchStore.svelte"
import * as m from "$lib/paraglide/messages"

export type SearchChoice =
    | { kind: "history"; query: string }
    | { kind: "match"; query: string; matchIndex: number }

export function parsePage(
    query: string,
    currentPage: number,
    totalPages: number,
): number | undefined {
    const cleanQuery = query.replace(/\u200B/g, "").trim()
    if (!cleanQuery) return currentPage
    const page = Number.parseInt(cleanQuery, 10)
    if (!Number.isFinite(page) || page < 1) return undefined
    return Math.min(page, totalPages)
}

export function buildGotoPageItems(query: string, totalPages: number): PromptItem<number>[] {
    const cleanQuery = query.replace(/\u200B/g, "").trim()
    if (!cleanQuery) return []

    const page = parsePage(cleanQuery, 1, totalPages)
    if (page === undefined) return []

    return [
        {
            id: `goto-page-${page}`,
            label: `${m.keymap_goto_page()} ${page}`,
            category: "navigation",
            value: page,
        },
    ]
}

export function buildSearchItems(input: {
    query: string
    history: readonly string[]
    matches: readonly SearchMatch[]
    pageText(page: number): string
}): PromptItem<SearchChoice>[] {
    const cleanQuery = input.query.replace(/\u200B/g, "").trim()
    if (!cleanQuery) {
        return input.history.map((historyQuery) => ({
            id: `search-history-${historyQuery.toLocaleLowerCase()}`,
            label: historyQuery,
            category: "navigation",
            value: { kind: "history", query: historyQuery },
        }))
    }

    return input.matches.slice(0, 200).map((match, matchIndex) => ({
        id: `search-match-${match.pageNumber}-${match.start}-${match.end}`,
        label: `${m.page()} ${match.pageNumber}`,
        description: matchContext(input.pageText(match.pageNumber), match.start, match.end),
        category: "navigation",
        value: { kind: "match", query: cleanQuery, matchIndex },
    }))
}

export function buildBookmarkItems(
    bookmarks: readonly Bookmark[],
    resolveBookName: (bookId: string) => string,
): PromptItem<string>[] {
    return bookmarks.map((bookmark) => ({
        id: bookmark.id,
        label: bookmark.name,
        description: `${resolveBookName(bookmark.bookId)} / ${m.page()} ${bookmark.pageNumber}`,
        category: "bookmarks",
        value: bookmark.id,
        presentation: { kind: "bookmarks" },
    }))
}

function matchContext(text: string, start: number, end: number, contextLength = 40): string {
    const contextStart = Math.max(0, start - contextLength)
    const contextEnd = Math.min(text.length, end + contextLength)
    const prefix = contextStart > 0 ? "..." : ""
    const suffix = contextEnd < text.length ? "..." : ""
    return `${prefix}${text.slice(contextStart, contextEnd)}${suffix}`
}
