import { describe, expect, it, vi } from "vitest"
import type { PromptRequest, PromptService, PromptSnapshot } from "$lib/modules/prompt"
import { createViewerNavigationCommands } from "./viewerNavigationCommands"
import { createViewerSearchCommands, type ViewerSearchPort } from "./viewerSearchCommands"
import { createViewerDisplayCommands } from "./viewerDisplayCommands"
import { createViewerBookmarkCommands } from "./viewerBookmarkCommandFactory"
import * as m from "$lib/paraglide/messages"

function promptService(): PromptService & { snapshot: PromptSnapshot | null } {
    return {
        snapshot: null,
        isOpen: false,
        query: "",
        open: vi.fn(async () => undefined) as PromptService["open"],
        choose: vi.fn(async () => undefined) as PromptService["choose"],
        close: vi.fn(),
        setQuery: vi.fn(),
        refresh: vi.fn(),
    }
}

function navigation(prompt = promptService()) {
    const viewer = {
        getCurrentPage: vi.fn(() => 4),
        getTotalPages: vi.fn(() => 20),
        goToPage: vi.fn(),
        nextPage: vi.fn(),
        previousPage: vi.fn(),
        close: vi.fn(),
        scroll: vi.fn(),
    }
    return {
        commands: createViewerNavigationCommands({
            prompt,
            viewer,
            scope: { onDestroy: vi.fn(() => vi.fn()), isDestroyed: false },
        }),
        viewer,
    }
}

function searchPort(): ViewerSearchPort {
    return {
        query: "",
        matches: [{ pageNumber: 8, start: 1, end: 5 }],
        currentMatchIndex: -1,
        searchHistory: [],
        isActive: false,
        isIndexing: false,
        isSearching: false,
        startIndexing: vi.fn(async () => undefined),
        begin: vi.fn(),
        setQuery: vi.fn(),
        selectMatch: vi.fn(() => ({ pageNumber: 8, start: 1, end: 5 })),
        next: vi.fn(),
        previous: vi.fn(),
        close: vi.fn(),
        clearHistory: vi.fn(),
        onMatchesChanged: vi.fn(() => vi.fn()),
        pageText: vi.fn(() => "reader"),
    }
}

describe("viewer command modules", () => {
    it("navigates directly with a payload", async () => {
        const { commands, viewer } = navigation()
        await commands["viewer.page.go-to"].run({ page: 12, isJump: false })
        expect(viewer.goToPage).toHaveBeenCalledWith(12, { isJump: false })
    })

    it("chooses and clamps a page when no payload is supplied", async () => {
        const prompt = promptService()
        prompt.choose = vi.fn(async (request: PromptRequest<number>) => {
            expect(request.items("12")).toEqual([
                {
                    id: "goto-page-12",
                    label: `${m.keymap_goto_page()} 12`,
                    category: "navigation",
                    value: 12,
                },
            ])
            expect(request.items("anything")).toEqual([])
            expect(request.parseQuery?.("99")).toBe(20)
            return 20
        }) as PromptService["choose"]
        const { commands, viewer } = navigation(prompt)

        await commands["viewer.page.go-to"].run(undefined)
        expect(viewer.goToPage).toHaveBeenCalledWith(20, { isJump: true })
    })

    it("maps step and half-page scroll keys to distinct repeat-aware commands", () => {
        const { commands, viewer } = navigation()
        const step = commands["viewer.scroll.step"]
        const halfPage = commands["viewer.scroll.half-page"]

        step.run(
            step.keyboardPayload?.({
                code: "KeyK",
                key: "л",
                repeat: false,
                ctrlKey: false,
                metaKey: false,
                altKey: false,
                shiftKey: false,
            } as KeyboardEvent),
        )
        halfPage.run(
            halfPage.keyboardPayload?.({
                code: "KeyU",
                key: "г",
                repeat: true,
                ctrlKey: false,
                metaKey: false,
                altKey: false,
                shiftKey: false,
            } as KeyboardEvent),
        )

        expect(step.keymap).toEqual(["j", "arrowdown", "k", "arrowup"])
        expect(halfPage.keymap).toEqual(["d", "pagedown", "u", "pageup"])
        expect(viewer.scroll).toHaveBeenNthCalledWith(
            1,
            { direction: "up", repeated: false },
            "step",
        )
        expect(viewer.scroll).toHaveBeenNthCalledWith(
            2,
            { direction: "up", repeated: true },
            "half-page",
        )
    })

    it("selects a search match, navigates, and closes Prompt", async () => {
        const prompt = promptService()
        const search = searchPort()
        const viewer = { getCurrentPage: vi.fn(() => 2), goToPage: vi.fn() }
        const commands = createViewerSearchCommands({
            prompt,
            search,
            viewer,
            scope: { onDestroy: vi.fn(() => vi.fn()) },
        })

        await commands["viewer.search"].run({ query: "reader", matchIndex: 0 })
        expect(search.selectMatch).toHaveBeenCalledWith("reader", 0)
        expect(viewer.goToPage).toHaveBeenCalledWith(8, { isJump: true })
        expect(prompt.close).toHaveBeenCalledOnce()
    })

    it("clears only search history and refreshes an open empty-query search", () => {
        const prompt = promptService()
        prompt.snapshot = {
            request: { id: "viewer-search", items: () => [] },
            query: "",
            items: [],
            selectedIndex: -1,
            isLoading: false,
        }
        const search = searchPort()
        Object.defineProperty(search, "searchHistory", { value: ["reader"] })
        const command = createViewerSearchCommands({
            prompt,
            search,
            viewer: { getCurrentPage: () => 1, goToPage: vi.fn() },
            scope: { onDestroy: vi.fn(() => vi.fn()) },
        })["viewer.search.history.clear"]

        expect("keymap" in command).toBe(false)
        command.run()
        expect(search.clearHistory).toHaveBeenCalledOnce()
        expect(prompt.refresh).toHaveBeenCalledOnce()
    })

    it("keeps display commands behind their focused port", () => {
        const display = {
            toggleOutline: vi.fn(),
            toggleSettings: vi.fn(),
            toggleNotes: vi.fn(),
            toggleBookmarks: vi.fn(),
            toggleToolbar: vi.fn(),
            toggleFullscreen: vi.fn(),
        }
        createViewerDisplayCommands(display)["viewer.toolbar.toggle"].run()
        expect(display.toggleToolbar).toHaveBeenCalledOnce()
    })

    it("uses matching add/remove bookmark labels", () => {
        let bookmarked = false
        const commands = createViewerBookmarkCommands({
            prompt: promptService(),
            scope: { onDestroy: vi.fn(() => vi.fn()) },
            bookmarks: {
                list: () => [],
                resolveBookName: () => "Book",
                open: vi.fn(),
                isToggleBlocked: () => false,
                isCurrentPageBookmarked: () => bookmarked,
                toggleCurrentPage: vi.fn(),
            },
        })
        const command = commands["viewer.bookmark.toggle-page"]
        expect(command.label()).toBe(m.add_bookmark())
        bookmarked = true
        expect(command.label()).toBe(m.remove_bookmark())
    })
})
