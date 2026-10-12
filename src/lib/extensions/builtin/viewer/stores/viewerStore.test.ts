import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("$app/environment", () => ({ browser: false }))

import { viewerLibraryCapability as vfsStore } from "../viewerHost"
import { viewerStore } from "./viewerStore.svelte"

vi.mock("../viewerHost", async () => {
    const actual = await vi.importActual<typeof import("../viewerHost")>("../viewerHost")
    const { vfsStore } = await import("$lib/modules/documents")
    Object.assign(vfsStore, {
        setActiveFileId: (id: string | null) => {
            vfsStore.activeFileId = id
        },
        releaseFileUrl: (id: string, url?: string) => vfsStore.revokeFileUrl(id, url),
    })
    return {
        ...actual,
        viewerLibraryCapability: vfsStore,
        viewerLibraryMutationCapability: vfsStore,
        isViewerLibraryCapabilityInstalled: () => true,
        getViewerLibraryMutationCapability: () => vfsStore,
    }
})

const bookNode = {
    id: "book",
    name: "book.pdf",
    type: "file" as const,
    parentId: null,
    size: 1,
    createdAt: 1,
    updatedAt: 1,
    isPinned: false,
    metadata: { pageNumber: 1 },
}

beforeEach(() => {
    ;(viewerStore as any).disposed = false
    ;(viewerStore as any).disposalEpoch = 0
    ;(viewerStore as any).bookSwitchGeneration = 0
    ;(viewerStore as any).syncPromise = null
    ;(viewerStore as any).pendingBookSwitches.clear()
    ;(viewerStore as any).deferredStaleUrls.clear()
})

afterEach(() => {
    viewerStore.dispose()
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

describe("ViewerStore URL synchronization", () => {
    it("does not publish a stale URL after a concurrent real book switch", async () => {
        let releaseUrl!: () => void
        const urlReady = new Promise<void>((resolve) => (releaseUrl = resolve))
        const getFileUrl = vi.spyOn(vfsStore, "getFileUrl").mockImplementation(async () => {
            await urlReady
            return "blob:old"
        })
        vi.spyOn(vfsStore, "getContentGeneration").mockReturnValue(0)
        vi.spyOn(vfsStore, "isCurrentContent").mockReturnValue(true)
        vi.spyOn(vfsStore, "isCurrentFileUrl").mockReturnValue(true)
        const releaseFileUrl = vi
            .spyOn(vfsStore as any, "releaseFileUrl")
            .mockImplementation(() => true)
        ;(vfsStore as any).nodes = {
            old: { ...bookNode, id: "old" },
            next: { ...bookNode, id: "next", name: "next.pdf" },
        }
        ;(vfsStore as any).isLockedMap = {}
        ;(viewerStore as any).book = {
            id: "old",
            name: "old.pdf",
            url: "",
            pageNumber: 1,
            scrollPosition: 0,
            totalPages: 0,
            previewDataUrl: "",
        }

        const syncing = viewerStore.syncWithBooks()
        await vi.waitFor(() => expect(getFileUrl).toHaveBeenCalledOnce())
        await viewerStore.setCurrentBook({
            id: "next",
            name: "next.pdf",
            url: "blob:next",
            pageNumber: 1,
            scrollPosition: 0,
            totalPages: 0,
            previewDataUrl: "",
            updatedAt: 1,
        })
        releaseUrl()
        await syncing

        expect(viewerStore.getCurrentBook()).toMatchObject({ id: "next", url: "blob:next" })
        expect(releaseFileUrl).toHaveBeenCalledWith("old", "blob:old")
    })

    it("does not update metadata after disposal when defaults are omitted", async () => {
        const updateFile = vi.spyOn(vfsStore as any, "updateFile")
        const getContentGeneration = vi.spyOn(vfsStore, "getContentGeneration")
        viewerStore.dispose()

        await viewerStore.updateBook({
            id: "book",
            name: "book.pdf",
            url: "",
            pageNumber: 1,
            scrollPosition: 0,
            totalPages: 0,
            previewDataUrl: "",
            updatedAt: 1,
        })

        expect(getContentGeneration).not.toHaveBeenCalled()
        expect(updateFile).not.toHaveBeenCalled()
    })

    it("arbitrates concurrent syncs through the real ViewerStore", async () => {
        let releaseUrl!: () => void
        const urlReady = new Promise<void>((resolve) => (releaseUrl = resolve))
        const getFileUrl = vi.spyOn(vfsStore, "getFileUrl").mockImplementation(async () => {
            await urlReady
            return "blob:book"
        })
        vi.spyOn(vfsStore, "getContentGeneration").mockReturnValue(0)
        vi.spyOn(vfsStore, "isCurrentContent").mockReturnValue(true)
        vi.spyOn(vfsStore, "isCurrentFileUrl").mockReturnValue(true)
        ;(vfsStore as any).nodes = { book: bookNode }
        ;(vfsStore as any).isLockedMap = {}
        ;(viewerStore as any).book = {
            id: "book",
            name: "book.pdf",
            url: "",
            pageNumber: 1,
            scrollPosition: 0,
            totalPages: 0,
            previewDataUrl: "",
        }

        const firstSync = viewerStore.syncWithBooks()
        const secondSync = viewerStore.syncWithBooks()
        releaseUrl()

        await Promise.all([firstSync, secondSync])

        expect(getFileUrl).toHaveBeenCalledOnce()
        expect(viewerStore.getCurrentBook()).toMatchObject({ id: "book", url: "blob:book" })
    })
})
