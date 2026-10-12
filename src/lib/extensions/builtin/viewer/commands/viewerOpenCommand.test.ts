import { beforeEach, describe, expect, it, vi } from "vitest"

const {
    goto,
    restoreFileAccess,
    waitForRelink,
    setCurrentBook,
    getCurrentBook,
    onLibraryBookOpen,
    nodes,
    viewerFileCapability,
} = vi.hoisted(() => {
    const restoreFileAccess = vi.fn()
    const waitForRelink = vi.fn(async () => undefined)
    const nodes: Record<string, any> = {}
    return {
        goto: vi.fn(),
        restoreFileAccess,
        waitForRelink,
        setCurrentBook: vi.fn(),
        getCurrentBook: vi.fn(),
        onLibraryBookOpen: vi.fn(),
        nodes,
        viewerFileCapability: {
            nodes,
            restoreFileAccess,
            waitForRelink,
            getFileUrl: vi.fn(),
            getContentGeneration: vi.fn(() => 0),
            isCurrentContent: vi.fn(() => true),
            isCurrentFileUrl: vi.fn(() => true),
            releaseFileUrl: vi.fn(() => false),
            clearForwardHistory: vi.fn(),
        },
    }
})

vi.mock("$app/navigation", () => ({ goto }))
vi.mock("$app/paths", () => ({ resolve: (path: string) => path }))
vi.mock("../viewerHost", () => ({ viewerFileCapability }))
vi.mock("$lib/core/settings", () => ({ localizedPath: (path: string) => path }))
vi.mock("../stores/viewerStore.svelte", () => ({
    viewerStore: { setCurrentBook, getCurrentBook },
}))
vi.mock("../stores/viewerStore.types", () => ({
    fileNodeToBook: (node: any) => ({ id: node.id, name: node.name, url: node.url }),
}))
vi.mock("$lib/core/commands", async (importOriginal) => {
    const actual = await importOriginal<typeof import("$lib/core/commands")>()
    return {
        ...actual,
        commandsStore: { execute: onLibraryBookOpen },
    }
})

import { createViewerOpenCommand } from "./viewerOpenCommand"

describe("viewer.open integration", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        getCurrentBook.mockReset()
        viewerFileCapability.getFileUrl.mockReset()
        viewerFileCapability.getContentGeneration.mockReturnValue(0)
        viewerFileCapability.isCurrentContent.mockReturnValue(true)
        viewerFileCapability.isCurrentFileUrl.mockReturnValue(true)
        for (const id of Object.keys(nodes)) delete nodes[id]
    })

    it("opens an accessible file and navigates only after the viewer accepts it", async () => {
        nodes.book = { id: "book", type: "file", name: "Book", url: "blob:book", isLocked: false }
        const onFileAccessFailure = vi.fn()

        await createViewerOpenCommand({ onFileAccessFailure }).run({ bookId: "book" })

        expect(setCurrentBook).toHaveBeenCalledWith({ id: "book", name: "Book", url: "blob:book" })
        expect(viewerFileCapability.clearForwardHistory).toHaveBeenCalledOnce()
        expect(goto).toHaveBeenCalledWith("/viewer")
        expect(onFileAccessFailure).not.toHaveBeenCalled()
    })

    it("reuses the active URL when reopening the same book", async () => {
        nodes.book = { id: "book", type: "file", name: "Book", isLocked: false }
        getCurrentBook.mockReturnValue({ id: "book", url: "blob:active" })

        await createViewerOpenCommand({ onFileAccessFailure: vi.fn() }).run({ bookId: "book" })

        expect(viewerFileCapability.getFileUrl).not.toHaveBeenCalled()
        expect(setCurrentBook).toHaveBeenCalledWith({
            id: "book",
            name: "Book",
            url: "blob:active",
        })
    })

    it("rejects a supplied URL that is no longer current", async () => {
        nodes.book = { id: "book", type: "file", name: "Book", url: "blob:old", isLocked: false }
        viewerFileCapability.isCurrentFileUrl.mockReturnValue(false)

        await createViewerOpenCommand({ onFileAccessFailure: vi.fn() }).run({ bookId: "book" })

        expect(setCurrentBook).not.toHaveBeenCalled()
        expect(goto).not.toHaveBeenCalled()
    })

    it("does not navigate when the viewer rejects a book after URL acquisition", async () => {
        nodes.book = { id: "book", type: "file", name: "Book", isLocked: false }
        viewerFileCapability.getFileUrl.mockResolvedValue("blob:book")
        setCurrentBook.mockResolvedValueOnce(false)

        await createViewerOpenCommand({ onFileAccessFailure: vi.fn() }).run({ bookId: "book" })

        expect(setCurrentBook).toHaveBeenCalledWith({ id: "book", name: "Book", url: "blob:book" })
        expect(viewerFileCapability.clearForwardHistory).not.toHaveBeenCalled()
        expect(goto).not.toHaveBeenCalled()
    })

    it("restores a locked file before opening the refreshed node", async () => {
        nodes.book = { id: "book", type: "file", name: "Book", url: "old", isLocked: true }
        restoreFileAccess.mockImplementation(async () => {
            nodes.book = { ...nodes.book, url: "restored", isLocked: false }
            return "restored"
        })

        await createViewerOpenCommand({ onFileAccessFailure: vi.fn() }).run({ bookId: "book" })

        expect(restoreFileAccess).toHaveBeenCalledWith("book")
        expect(viewerFileCapability.getFileUrl).not.toHaveBeenCalled()
        expect(setCurrentBook).toHaveBeenCalledWith(expect.objectContaining({ url: "restored" }))
        expect(goto).toHaveBeenCalledWith("/viewer")
    })

    it("releases a restored lease when the refreshed URL is stale", async () => {
        nodes.book = { id: "book", type: "file", name: "Book", isLocked: true }
        restoreFileAccess.mockImplementationOnce(async () => {
            nodes.book = { ...nodes.book, url: "blob:restored", isLocked: false }
            return "blob:restored"
        })
        viewerFileCapability.isCurrentFileUrl.mockReturnValue(false)
        viewerFileCapability.releaseFileUrl.mockReturnValue(true)

        await createViewerOpenCommand({ onFileAccessFailure: vi.fn() }).run({ bookId: "book" })

        expect(viewerFileCapability.releaseFileUrl).toHaveBeenCalledWith("book", "blob:restored")
        expect(setCurrentBook).not.toHaveBeenCalled()
    })

    it("releases extra leases when restoration has to run more than once", async () => {
        nodes.book = { id: "book", type: "file", name: "Book", isLocked: true }
        restoreFileAccess
            .mockImplementationOnce(async () => {
                nodes.book = { ...nodes.book, url: "blob:first", isLocked: true }
                return "blob:first"
            })
            .mockImplementationOnce(async () => {
                nodes.book = { ...nodes.book, url: "blob:second", isLocked: false }
                return "blob:second"
            })
        viewerFileCapability.releaseFileUrl.mockReturnValue(true)

        await createViewerOpenCommand({ onFileAccessFailure: vi.fn() }).run({ bookId: "book" })

        expect(restoreFileAccess).toHaveBeenCalledTimes(2)
        expect(viewerFileCapability.releaseFileUrl).toHaveBeenCalledWith("book", "blob:first")
        expect(setCurrentBook).toHaveBeenCalledWith(
            expect.objectContaining({ id: "book", url: "blob:second" }),
        )
    })

    it("ignores an older overlapping open after its file access resolves", async () => {
        let resolveFirst: ((url: string) => void) | undefined
        viewerFileCapability.getFileUrl.mockImplementation((id: string) =>
            id === "first"
                ? new Promise<string>((resolve) => {
                      resolveFirst = resolve
                  })
                : Promise.resolve("blob:second"),
        )
        nodes.first = { id: "first", type: "file", name: "First", isLocked: false }
        nodes.second = { id: "second", type: "file", name: "Second", isLocked: false }
        const command = createViewerOpenCommand({ onFileAccessFailure: vi.fn() })

        const firstOpen = command.run({ bookId: "first" })
        await Promise.resolve()
        const secondOpen = command.run({ bookId: "second" })
        await secondOpen
        resolveFirst?.("blob:first")
        await firstOpen

        expect(setCurrentBook).toHaveBeenCalledTimes(1)
        expect(setCurrentBook).toHaveBeenCalledWith({
            id: "second",
            name: "Second",
            url: "blob:second",
        })
        expect(goto).toHaveBeenCalledTimes(1)
    })

    it("releases an overlapping URL through the VFS owner when it is cached", async () => {
        let resolveFirst: ((url: string) => void) | undefined
        viewerFileCapability.getFileUrl.mockImplementationOnce(
            () =>
                new Promise<string>((resolve) => {
                    resolveFirst = resolve
                }),
        )
        viewerFileCapability.releaseFileUrl.mockReturnValue(true)
        nodes.first = { id: "first", type: "file", name: "First", isLocked: false }
        nodes.second = {
            id: "second",
            type: "file",
            name: "Second",
            url: "blob:second",
            isLocked: false,
        }
        const command = createViewerOpenCommand({ onFileAccessFailure: vi.fn() })

        const firstOpen = command.run({ bookId: "first" })
        await Promise.resolve()
        await command.run({ bookId: "second" })
        resolveFirst?.("blob:first")
        await firstOpen

        expect(viewerFileCapability.releaseFileUrl).toHaveBeenCalledWith("first", "blob:first")
    })

    it("keeps the transferred shared URL lease when an older same-book open becomes stale", async () => {
        let resolveFirst: (() => void) | undefined
        setCurrentBook.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    resolveFirst = resolve
                }),
        )
        viewerFileCapability.getFileUrl.mockResolvedValue("blob:shared")
        nodes.book = { id: "book", type: "file", name: "Book", isLocked: false }
        const command = createViewerOpenCommand({ onFileAccessFailure: vi.fn() })

        const firstOpen = command.run({ bookId: "book" })
        await Promise.resolve()
        const secondOpen = command.run({ bookId: "book" })
        getCurrentBook.mockReturnValue({ id: "book", url: "blob:shared" })
        await secondOpen
        resolveFirst?.()
        await firstOpen

        // Acceptance transferred the older operation's lease to the active viewer. A newer
        // same-book reuse must not let the stale older command release that lease.
        expect(viewerFileCapability.releaseFileUrl).not.toHaveBeenCalledWith("book", "blob:shared")
    })

    it("does not revoke the active URL when an older accepted open loses to reuse failure", async () => {
        let resolveFirstUrl!: (url: string) => void
        let resolveFirstAcceptance!: () => void
        let fileUrlChecks = 0
        const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)
        viewerFileCapability.getFileUrl.mockImplementation(
            () => new Promise<string>((resolve) => (resolveFirstUrl = resolve)),
        )
        viewerFileCapability.isCurrentFileUrl.mockImplementation(() => ++fileUrlChecks > 1)
        nodes.book = { id: "book", type: "file", name: "Book", isLocked: false }
        getCurrentBook.mockReturnValue({ id: "book", url: "blob:active" })
        const error = new Error("newer same-book open failed")
        setCurrentBook
            .mockImplementationOnce(
                () => new Promise<void>((resolve) => (resolveFirstAcceptance = resolve)),
            )
            .mockRejectedValueOnce(error)
        const command = createViewerOpenCommand({ onFileAccessFailure: vi.fn() })

        const olderOpen = command.run({ bookId: "book" })
        await Promise.resolve()
        resolveFirstUrl("blob:active")
        await vi.waitFor(() => expect(setCurrentBook).toHaveBeenCalledOnce())
        await expect(command.run({ bookId: "book" })).rejects.toBe(error)
        resolveFirstAcceptance()
        await olderOpen

        expect(revokeObjectURL).not.toHaveBeenCalledWith("blob:active")
        expect(setCurrentBook).not.toHaveBeenLastCalledWith(null)
    })

    it("retries a locked open after a relink supersedes restoration", async () => {
        nodes.book = { id: "book", type: "file", name: "Book", url: "old", isLocked: true }
        restoreFileAccess
            .mockRejectedValueOnce(
                Object.assign(new Error("superseded"), {
                    name: "ContentSupersededError",
                }),
            )
            .mockImplementationOnce(async () => {
                nodes.book = { ...nodes.book, url: "restored", isLocked: false }
                return "restored"
            })

        await createViewerOpenCommand({ onFileAccessFailure: vi.fn() }).run({ bookId: "book" })

        expect(waitForRelink).toHaveBeenCalledWith("book")
        expect(restoreFileAccess).toHaveBeenCalledTimes(2)
        expect(setCurrentBook).toHaveBeenCalledWith(expect.objectContaining({ url: "restored" }))
        expect(goto).toHaveBeenCalledWith("/viewer")
    })

    it("requests relink recovery and does not navigate when file access fails", async () => {
        const error = new Error("permission lost")
        nodes.book = { id: "book", type: "file", name: "Book", url: "old", isLocked: true }
        restoreFileAccess.mockRejectedValue(error)
        const onFileAccessFailure = vi.fn()

        await expect(
            createViewerOpenCommand({ onFileAccessFailure }).run({ bookId: "book" }),
        ).resolves.toBeUndefined()

        expect(onFileAccessFailure).toHaveBeenCalledWith({ bookId: "book", error })
        expect(setCurrentBook).not.toHaveBeenCalled()
        expect(viewerFileCapability.clearForwardHistory).not.toHaveBeenCalled()
        expect(goto).not.toHaveBeenCalled()
    })

    it("propagates unexpected viewer failures without offering relink recovery", async () => {
        const error = new Error("viewer invariant failed")
        nodes.book = { id: "book", type: "file", name: "Book", url: "blob:book", isLocked: false }
        setCurrentBook.mockRejectedValueOnce(error)
        const onFileAccessFailure = vi.fn()

        await expect(
            createViewerOpenCommand({ onFileAccessFailure }).run({ bookId: "book" }),
        ).rejects.toBe(error)

        expect(onFileAccessFailure).not.toHaveBeenCalled()
        expect(setCurrentBook).toHaveBeenLastCalledWith(null)
        expect(viewerFileCapability.clearForwardHistory).not.toHaveBeenCalled()
        expect(goto).not.toHaveBeenCalled()
    })

    it("preserves the published matching book when a newer open fails", async () => {
        const error = new Error("newer open failed")
        nodes.book = { id: "book", type: "file", name: "Book", url: "blob:book", isLocked: false }
        const command = createViewerOpenCommand({ onFileAccessFailure: vi.fn() })
        await command.run({ bookId: "book" })
        getCurrentBook.mockReturnValue({ id: "book", url: "blob:book" })
        setCurrentBook.mockRejectedValueOnce(error)

        await expect(command.run({ bookId: "book" })).rejects.toBe(error)

        expect(setCurrentBook).not.toHaveBeenLastCalledWith(null)
        expect(getCurrentBook).toHaveBeenCalled()
    })

    it("delegates missing book selection to the Library command", async () => {
        await createViewerOpenCommand({ onFileAccessFailure: vi.fn() }).run(undefined)

        expect(onLibraryBookOpen).toHaveBeenCalledWith("library.book.open")
        expect(goto).not.toHaveBeenCalled()
    })
})
