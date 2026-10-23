import { describe, expect, it } from "vitest"
import { promptStore as pagePrompt } from "$lib/extensions/builtin/prompt/stores/promptStore.svelte"
import { createViewerNavigationCommands } from "$lib/extensions/builtin/viewer/commands/viewerNavigationCommands"
import { ReadingWorkspace } from "$lib/extensions/builtin/viewer/readingWorkspace"
import type { Book } from "$lib/extensions/builtin/viewer/stores/viewerStore.types"

describe("Viewer page navigation", () => {
    it("does not apply a delayed page chooser to a newer document selection", async () => {
        const prompt = pagePrompt
        prompt.close()
        let book: Book | null = null
        const workspace = new ReadingWorkspace({
            files: {
                nodes: {
                    first: {
                        id: "first",
                        name: "First",
                        type: "file",
                        updatedAt: 1,
                        metadata: { totalPages: 20 },
                    },
                    second: {
                        id: "second",
                        name: "Second",
                        type: "file",
                        updatedAt: 1,
                        metadata: { totalPages: 20 },
                    },
                },
                isLockedMap: {},
                getFileUrl: async (id) => `blob:${id}`,
                restoreFileAccess: async () => undefined,
                requestRelink() {},
                waitForRelink: async () => undefined,
                releaseFileUrl: () => true,
                getContentGeneration: () => 0,
                isCurrentContent: () => true,
                isCurrentFileUrl: () => true,
                clearForwardHistory() {},
            },
            getCurrentBook: () => book,
            publish: (value) => {
                book = value
            },
        })
        const commands = createViewerNavigationCommands({
            prompt,
            viewer: {
                getSelectionRevision: () => workspace.selectionRevision,
                getCurrentPage: () => workspace.snapshot.state.pageNumber,
                getTotalPages: () => book?.totalPages ?? 0,
                goToPage: (page) => workspace.setPosition(page),
                nextPage: () => workspace.setPosition(workspace.snapshot.state.pageNumber + 1),
                previousPage: () => workspace.setPosition(workspace.snapshot.state.pageNumber - 1),
                close: () => {
                    void workspace.close()
                },
                scroll() {},
            },
            scope: { onDestroy: () => () => undefined, isDestroyed: false },
        })
        try {
            await workspace.open("first")
            await commands["viewer.page.go-to"].run({ page: 4 })
            const choosing = commands["viewer.page.go-to"].run(undefined)
            prompt.setQuery("9")
            await workspace.open("second")
            workspace.setPosition(6)
            await prompt.selectCurrent()
            await choosing
            expect(workspace.snapshot).toMatchObject({
                documentId: "second",
                state: { pageNumber: 6 },
            })
            await workspace.open("first")
            expect(workspace.snapshot).toMatchObject({
                documentId: "first",
                state: { pageNumber: 4 },
            })
            // A chooser still applies normally when its document remains selected.
            const currentChoice = commands["viewer.page.go-to"].run(undefined)
            prompt.setQuery("9")
            await prompt.selectCurrent()
            await currentChoice
            expect(workspace.snapshot).toMatchObject({
                documentId: "first",
                state: { pageNumber: 9 },
            })
        } finally {
            prompt.close()
            await workspace.dispose()
        }
    })
})
