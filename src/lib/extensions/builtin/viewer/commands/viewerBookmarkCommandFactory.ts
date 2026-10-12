import type { Bookmark } from "$lib/modules/documents"
import { defineCommands } from "$lib/modules/commands"
import type { CommandScope } from "$lib/modules/commands"
import type { PromptService } from "$lib/modules/prompt"
import PromptBookPreview from "../components/PromptBookPreview.svelte"
import { buildBookmarkItems } from "./viewerPromptItems"
import * as m from "$lib/paraglide/messages"

type PromptChooser = Pick<PromptService, "choose" | "close" | "snapshot">

export function createViewerBookmarkCommands(dependencies: {
    prompt: PromptChooser
    scope: Pick<CommandScope, "onDestroy">
    bookmarks: {
        list(): readonly Bookmark[]
        resolveBookName(bookId: string): string
        open(bookmarkId: string): void | Promise<void>
        isToggleBlocked(): boolean
        isCurrentPageBookmarked(): boolean
        toggleCurrentPage(): void
    }
}) {
    const { prompt, scope, bookmarks } = dependencies
    return defineCommands({
        "viewer.bookmark.toggle-page": {
            id: "viewer.bookmark.toggle-page",
            keymap: "b",
            label: () =>
                bookmarks.isCurrentPageBookmarked() ? m.remove_bookmark() : m.add_bookmark(),
            englishLabel: () =>
                bookmarks.isCurrentPageBookmarked()
                    ? m.remove_bookmark({}, { locale: "en" })
                    : m.add_bookmark({}, { locale: "en" }),
            category: "bookmarks",
            disabled: bookmarks.isToggleBlocked,
            preventDefault: true,
            run: () => bookmarks.toggleCurrentPage(),
        },
        "viewer.bookmark.open": {
            id: "viewer.bookmark.open",
            keymap: "shift+b",
            label: () => m.open_bookmark(),
            englishLabel: () => m.open_bookmark({}, { locale: "en" }),
            category: "bookmarks",
            run: async (payload) => {
                let bookmarkId = payload?.bookmarkId
                if (!bookmarkId) {
                    const requestId = "viewer-bookmarks"
                    const stopWatchingScope = scope.onDestroy(() => {
                        if (prompt.snapshot?.request.id === requestId) prompt.close()
                    })
                    bookmarkId = await prompt.choose<string>({
                        id: requestId,
                        items: () => {
                            const bookmarkList = bookmarks.list()
                            const bookmarksById = new Map(
                                bookmarkList.map((bookmark) => [bookmark.id, bookmark]),
                            )
                            return buildBookmarkItems(bookmarkList, bookmarks.resolveBookName).map(
                                (item) => ({
                                    ...item,
                                    presentation: {
                                        kind: "book",
                                        leading: PromptBookPreview,
                                        leadingProps: {
                                            bookId: bookmarksById.get(item.id)?.bookId,
                                        },
                                    },
                                }),
                            )
                        },
                        filter: "fuzzy",
                        emptyLabel: m.no_bookmarks(),
                    })
                    stopWatchingScope()
                }
                if (bookmarkId) await bookmarks.open(bookmarkId)
            },
        },
    })
}
