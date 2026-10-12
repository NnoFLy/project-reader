import { defineCommands } from "$lib/modules/commands"
import type { CommandScope } from "$lib/modules/commands"
import type { PromptService } from "$lib/modules/prompt"
import { buildSearchItems, type SearchChoice } from "./viewerPromptItems"
import type { SearchMatch } from "../stores/searchStore.svelte"
import * as m from "$lib/paraglide/messages"

type InteractivePrompt = Pick<PromptService, "open" | "close" | "refresh" | "snapshot">

export interface ViewerSearchPort {
    readonly query: string
    readonly matches: readonly SearchMatch[]
    readonly currentMatchIndex: number
    readonly searchHistory: readonly string[]
    readonly isActive: boolean
    readonly isIndexing: boolean
    readonly isSearching: boolean
    startIndexing(): Promise<void>
    begin(startPage: number): void
    setQuery(query: string): void
    selectMatch(query: string, matchIndex: number): SearchMatch | undefined
    next(): void
    previous(): void
    close(): void
    clearHistory(): void
    onMatchesChanged(listener: () => void): () => void
    pageText(page: number): string
}

export function createViewerSearchCommands(dependencies: {
    prompt: InteractivePrompt
    search: ViewerSearchPort
    viewer: { getCurrentPage(): number; goToPage(page: number, options: { isJump: boolean }): void }
    scope: Pick<CommandScope, "onDestroy">
}) {
    const { prompt, search, viewer, scope } = dependencies
    const requestId = "viewer-search"

    const selectMatch = (query: string, matchIndex: number) => {
        const match = search.selectMatch(query, matchIndex)
        if (!match) return
        viewer.goToPage(match.pageNumber, {
            isJump: match.pageNumber !== viewer.getCurrentPage(),
        })
        prompt.close()
    }

    const openSearch = async () => {
        search.begin(viewer.getCurrentPage())
        void search.startIndexing()
        const stopRefreshing = search.onMatchesChanged(() => {
            if (prompt.snapshot?.request.id === requestId) prompt.refresh()
        })
        const stopWatchingScope = scope.onDestroy(() => {
            if (prompt.snapshot?.request.id === requestId) prompt.close()
        })
        try {
            await prompt.open<SearchChoice>({
                id: requestId,
                placeholder: m.keymap_search(),
                initialQuery: search.query,
                items: (query) =>
                    buildSearchItems({
                        query,
                        history: search.searchHistory,
                        matches: search.matches,
                        pageText: search.pageText,
                    }),
                filter: "none",
                closeOnSelect: false,
                loadingLabel: m.searching_document(),
                emptyLabel: m.search_history_empty(),
                isLoading: () =>
                    Boolean(search.query.trim()) && (search.isIndexing || search.isSearching),
                onQueryChange: (query) => search.setQuery(query.replace(/\u200B/g, "")),
                onSelect: (choice, controls) => {
                    if (choice.kind === "history") {
                        controls.setQuery(choice.query)
                        return "keep-open"
                    }
                    selectMatch(choice.query, choice.matchIndex)
                    return "close"
                },
            })
        } finally {
            stopRefreshing()
            stopWatchingScope()
        }
    }

    return defineCommands({
        "viewer.search": {
            id: "viewer.search",
            keymap: "/",
            label: () => m.keymap_search(),
            englishLabel: () => m.keymap_search({}, { locale: "en" }),
            category: "commands",
            preventDefault: true,
            run: async (payload) => {
                if (payload?.query === undefined || payload.matchIndex === undefined) {
                    await openSearch()
                    return
                }
                selectMatch(payload.query, payload.matchIndex)
            },
        },
        "viewer.search.close": {
            id: "viewer.search.close",
            label: () => m.close_search(),
            englishLabel: () => m.close_search({}, { locale: "en" }),
            category: "commands",
            run: () => search.close(),
        },
        "viewer.search.next": {
            id: "viewer.search.next",
            keymap: "n",
            label: () => m.keymap_next_match(),
            englishLabel: () => m.keymap_next_match({}, { locale: "en" }),
            category: "navigation",
            preventDefault: true,
            run: () => search.next(),
        },
        "viewer.search.previous": {
            id: "viewer.search.previous",
            keymap: "shift+n",
            label: () => m.keymap_prev_match(),
            englishLabel: () => m.keymap_prev_match({}, { locale: "en" }),
            category: "navigation",
            preventDefault: true,
            run: () => search.previous(),
        },
        "viewer.search.history.clear": {
            id: "viewer.search.history.clear",
            label: () => m.clear_search_history(),
            englishLabel: () => m.clear_search_history({}, { locale: "en" }),
            category: "commands",
            disabled: () => search.searchHistory.length === 0,
            run: () => {
                search.clearHistory()
                const snapshot = prompt.snapshot
                if (snapshot?.request.id === requestId && !snapshot.query.trim()) {
                    prompt.refresh()
                }
            },
        },
    })
}
