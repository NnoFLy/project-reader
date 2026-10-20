import { beforeEach, describe, expect, it, vi } from "vitest"
import { ReadingWorkspace } from "../readingWorkspace"
import type { Book } from "../stores/viewerStore.types"
import type { ViewerFileCapability } from "../viewerHost"
import { createViewerOpenCommand } from "./viewerOpenCommand"

const { goto } = vi.hoisted(() => ({ goto: vi.fn() }))
vi.mock("$app/navigation", () => ({ goto }))
vi.mock("$app/paths", () => ({ resolve: (path: string) => path }))
vi.mock("$lib/core/settings", () => ({ localizedPath: (path: string) => path }))

function reader() {
    let book: Book | null = null
    const files: ViewerFileCapability = {
        nodes: { book: { id: "book", name: "Book", type: "file", updatedAt: 1, metadata: {} } },
        isLockedMap: {},
        getFileUrl: async () => "blob:book",
        restoreFileAccess: async () => undefined,
        requestRelink: () => undefined,
        waitForRelink: async () => undefined,
        releaseFileUrl: () => true,
        getContentGeneration: () => 0,
        isCurrentContent: () => true,
        isCurrentFileUrl: () => true,
        clearForwardHistory: () => undefined,
    }
    const workspace = new ReadingWorkspace({
        files,
        getCurrentBook: () => book,
        publish: (value) => {
            book = value
        },
    })
    const clearForwardHistory = vi.fn()
    const onFileAccessFailure = vi.fn()
    const executeCommand = vi.fn(async () => undefined)
    const command = createViewerOpenCommand({
        workspace,
        clearForwardHistory,
        onFileAccessFailure,
        executeCommand,
    })
    return {
        command,
        workspace,
        files,
        clearForwardHistory,
        onFileAccessFailure,
        executeCommand,
        current: () => book,
    }
}

beforeEach(() => vi.clearAllMocks())

describe("viewer.open command adapter", () => {
    it("navigates and clears forward history only after workspace publication", async () => {
        const readerState = reader()
        await readerState.command.run({ bookId: "book" })
        expect(readerState.current()).toMatchObject({ id: "book", url: "blob:book" })
        expect(readerState.clearForwardHistory).toHaveBeenCalledOnce()
        expect(goto).toHaveBeenCalledWith("/viewer")
        await readerState.workspace.dispose()
    })

    it("preserves the Library chooser command when no document is specified", async () => {
        const readerState = reader()
        await readerState.command.run(undefined as never)
        expect(readerState.executeCommand).toHaveBeenCalledWith("library.book.open")
        expect(goto).not.toHaveBeenCalled()
        await readerState.workspace.dispose()
    })

    it("does not navigate after the workspace lifetime ends", async () => {
        const readerState = reader()
        await readerState.workspace.dispose()
        await readerState.command.run({ bookId: "book" })
        expect(readerState.clearForwardHistory).not.toHaveBeenCalled()
        expect(goto).not.toHaveBeenCalled()
    })

    it("keeps access-failure feedback and relink requests without leaking diagnostics", async () => {
        const readerState = reader()
        const requestRelink = vi.fn()
        readerState.files.requestRelink = requestRelink
        readerState.files.getFileUrl = async () => {
            throw new Error("secret source URL")
        }
        const log = vi.spyOn(console, "error").mockImplementation(() => undefined)
        try {
            await readerState.command.run({ bookId: "book" })
            expect(requestRelink).toHaveBeenCalledWith("book")
            expect(readerState.onFileAccessFailure).toHaveBeenCalledWith(
                expect.objectContaining({ bookId: "book" }),
            )
            expect(JSON.stringify(log.mock.calls)).not.toContain("secret source URL")
            expect(goto).not.toHaveBeenCalled()
        } finally {
            log.mockRestore()
            await readerState.workspace.dispose()
        }
    })
})
