import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { DOCUMENT_SOURCE_LIMITS, DocumentSourceLimitError } from "$lib/core/files"

const {
    documentConstructed,
    documentLoad,
    documentPageCount,
    documentAuthor,
    documentTitle,
    documentPage,
    documentCanvas,
    documentDimensions,
    documentRenderBounds,
    documentClose,
    createDocument,
    documentService,
} = vi.hoisted(() => {
    const documentConstructed = vi.fn()
    const documentLoad = vi.fn()
    const documentPageCount = vi.fn()
    const documentAuthor = vi.fn()
    const documentTitle = vi.fn()
    const documentPage = vi.fn()
    const documentCanvas = vi.fn()
    const documentDimensions = vi.fn()
    const documentRenderBounds = vi.fn()
    const documentClose = vi.fn()
    const createDocument = () => {
        documentConstructed()
        return {
            load: (...args: unknown[]) => documentLoad(...args),
            getPageNumber: () => documentPageCount(),
            getAuthor: () => documentAuthor(),
            getTitle: () => documentTitle(),
            getPage: (pageNumber: number) => documentPage(pageNumber),
            getCanvasPage: (page: unknown) => documentCanvas(page),
            getAllPageDimensions: () => documentDimensions(),
            validateRenderBounds: () => documentRenderBounds(),
            close: async () => documentClose(),
        }
    }
    const documentService = {
        open: vi.fn(async () => {
            const legacy = createDocument() as any
            await legacy.load()
            const pageCount = await legacy.getPageNumber()
            const author = await legacy.getAuthor()
            const title = await legacy.getTitle()
            return {
                kind: "paged" as const,
                capabilities: new Set(),
                metadata: { title, author, pageCount },
                pageCount,
                getPage: (pageNumber: number) => legacy.getPage(pageNumber),
                renderPage: async (pageNumber: number) => ({
                    pageNumber,
                    url: await legacy.getCanvasPage(await legacy.getPage(pageNumber)),
                    width: 600,
                    height: 800,
                    mimeType: "image/fake",
                }),
                validateRenderBounds: () => legacy.validateRenderBounds(),
                close: () => legacy.close(),
            }
        }),
        close: vi.fn(async (document: { close: () => Promise<void> }) => document.close()),
    }
    return {
        documentConstructed,
        documentLoad,
        documentPageCount,
        documentAuthor,
        documentTitle,
        documentPage,
        documentCanvas,
        documentDimensions,
        documentRenderBounds,
        documentClose,
        createDocument,
        documentService,
    }
})

documentConstructed.mockName("documentConstructed")

vi.mock("$app/environment", () => ({ browser: true }))

import { VFSStore } from "./vfsStore.svelte"
import type { ImportInput, VFSNodes } from "./vfsStore.types"

function handle(name: string): FileSystemFileHandle {
    return {
        kind: "file",
        name,
        getFile: vi.fn(async () => new Blob(["pdf"], { type: "application/pdf" })),
    } as unknown as FileSystemFileHandle
}

beforeEach(() => {
    documentConstructed.mockClear()
    documentLoad.mockReset().mockResolvedValue(undefined)
    documentPageCount.mockReset().mockResolvedValue(2)
    documentAuthor.mockReset().mockResolvedValue(null)
    documentTitle.mockReset().mockResolvedValue(null)
    documentPage.mockReset().mockResolvedValue({})
    documentCanvas.mockReset().mockResolvedValue("")
    documentDimensions.mockReset().mockResolvedValue([{ width: 600, height: 800 }])
    documentRenderBounds.mockReset().mockResolvedValue(undefined)
    documentClose.mockReset().mockResolvedValue(undefined)
    documentService.open.mockClear()
    documentService.close.mockClear()
    vi.stubGlobal("__documentService", documentService)
})

afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
})

describe("VFS initialization", () => {
    it("restores legacy metadata without parsing PDFs", async () => {
        const store = new VFSStore()
        store.db = {
            folders: { getAll: vi.fn(async () => []) },
            files: {
                getAll: vi.fn(async () => [
                    {
                        id: "legacy",
                        name: "legacy.pdf",
                        type: "file",
                        parentId: null,
                        size: 1,
                        createdAt: 1,
                        updatedAt: 1,
                        isPinned: false,
                        metadata: { pageNumber: 1, author: undefined },
                    },
                ]),
            },
        } as never

        await store.init()

        expect(store.nodes.legacy).toBeDefined()
        expect(documentConstructed).not.toHaveBeenCalled()
    })

    it("cleans a durable resource-limit marker before publishing startup nodes", async () => {
        const pendingFile = {
            id: "pending",
            name: "pending.pdf",
            type: "file" as const,
            parentId: null,
            size: 1,
            createdAt: 1,
            updatedAt: 1,
            isPinned: false,
            metadata: { pageNumber: 1 },
            cleanupPending: "resource-limit" as const,
        }
        const deleted = vi.fn(async () => undefined)
        const transaction = vi.fn(
            async (_mode: unknown, _tables: unknown, callback: () => unknown) => callback(),
        )
        const store = new VFSStore()
        store.db = {
            folders: { getAll: vi.fn(async () => []), get: vi.fn(), put: vi.fn() },
            files: {
                getAll: vi.fn(async () => [pendingFile]),
                get: vi.fn(async () => pendingFile),
                delete: deleted,
            },
            previews: { delete: vi.fn() },
            fileContents: { delete: vi.fn() },
            indexedTexts: { deleteByBookId: vi.fn() },
            userNotes: { deleteByBookId: vi.fn() },
            bookmarks: { deleteByBookId: vi.fn() },
            transaction,
        } as never

        await store.init()

        expect(deleted).toHaveBeenCalledWith("pending")
        expect(store.nodes.pending).toBeUndefined()
        expect(transaction).toHaveBeenCalledOnce()
    })

    it("keeps failed marker cleanup retryable and removes cleaned parent membership", async () => {
        const pendingFile = {
            id: "pending",
            name: "pending.pdf",
            type: "file" as const,
            parentId: "parent",
            size: 1,
            createdAt: 1,
            updatedAt: 1,
            isPinned: false,
            metadata: { pageNumber: 1 },
            cleanupPending: "resource-limit" as const,
        }
        const parent = {
            id: "parent",
            name: "Parent",
            type: "folder" as const,
            parentId: null,
            childrenIds: ["pending"],
            createdAt: 1,
            updatedAt: 1,
            isPinned: false,
        }
        let deleted = false
        let transactionCalls = 0
        const transaction = vi.fn(
            async (_mode: unknown, _tables: unknown, callback: () => unknown) => {
                transactionCalls += 1
                if (transactionCalls === 1) throw new Error("temporary failure")
                return callback()
            },
        )
        const store = new VFSStore()
        store.db = {
            folders: {
                getAll: vi.fn(async () => [parent]),
                get: vi.fn(async () => parent),
                put: vi.fn(async () => undefined),
            },
            files: {
                getAll: vi.fn(async () => (deleted ? [] : [pendingFile])),
                get: vi.fn(async () => pendingFile),
                delete: vi.fn(async () => {
                    deleted = true
                }),
            },
            previews: { delete: vi.fn() },
            fileContents: { delete: vi.fn() },
            indexedTexts: { deleteByBookId: vi.fn() },
            userNotes: { deleteByBookId: vi.fn() },
            bookmarks: { deleteByBookId: vi.fn() },
            transaction,
        } as never

        await expect(store.init()).rejects.toThrow(
            "Failed to clean up resource-limited file pending",
        )
        expect(store.initialized).toBe(false)
        expect(store.nodes.pending).toBeUndefined()

        await store.init()

        expect(store.nodes.pending).toBeUndefined()
        expect(store.nodes.parent).toMatchObject({ childrenIds: [] })
        expect(transaction).toHaveBeenCalledTimes(2)
    })
})

describe("VFS initialization and import ordering", () => {
    it("does not publish the startup snapshot after disposal", async () => {
        let resolveFiles!: (files: never[]) => void
        const close = vi.fn()
        const initialNodes = {
            existing: {
                id: "existing",
                name: "existing.pdf",
                type: "file" as const,
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        }
        const store = new VFSStore(initialNodes)
        store.db = {
            folders: { getAll: vi.fn(async () => []) },
            files: {
                getAll: () => new Promise<never[]>((resolve) => (resolveFiles = resolve)),
            },
            close,
        } as never

        const initializing = store.init()
        const disposing = store.dispose()
        resolveFiles([])
        await Promise.all([initializing, disposing])

        expect(store.nodes).toEqual(initialNodes)
        expect(store.initialized).toBe(false)
        expect(close).toHaveBeenCalledOnce()
    })

    it("does not overwrite an import that overlaps the startup read", async () => {
        let resolveFolders!: (folders: never[]) => void
        let resolveFiles!: (files: never[]) => void
        const put = vi.fn(async () => undefined)
        const transaction = vi.fn(
            async (_mode: unknown, _tables: unknown, callback: () => unknown) => callback(),
        )
        const store = new VFSStore()
        store.db = {
            folders: {
                getAll: () => new Promise<never[]>((resolve) => (resolveFolders = resolve)),
            },
            files: {
                getAll: () => new Promise<never[]>((resolve) => (resolveFiles = resolve)),
                put,
            },
            fileContents: { put },
            transaction,
        } as never

        const initializing = store.init()
        const importing = store.importFiles(
            [{ name: "overlap.pdf", source: handle("overlap.pdf") }],
            null,
        )
        resolveFolders([])
        resolveFiles([])

        const [results] = await Promise.all([importing, initializing])

        expect(results[0]).toMatchObject({ status: "imported" })
        expect(store.nodes[results[0].id]).toMatchObject({ name: "overlap.pdf" })
    })

    it("preserves cleanup markers through later writes and clears them on relink", async () => {
        let persisted: any = {
            id: "book",
            name: "book.pdf",
            type: "file",
            parentId: null,
            size: 1,
            createdAt: 1,
            updatedAt: 1,
            isPinned: false,
            metadata: { pageNumber: 1 },
        }
        const filesPut = vi.fn(async (value: any) => {
            persisted = structuredClone(value)
            return value.id
        })
        const store = new VFSStore({ book: persisted })
        store.db = {
            files: {
                get: vi.fn(async () => persisted),
                put: filesPut,
            },
            fileContents: {
                get: vi.fn(async () => undefined),
                put: vi.fn(async (value: any) => value.id),
            },
            previews: {
                get: vi.fn(async () => undefined),
                put: vi.fn(async (value: any) => value.id),
                delete: vi.fn(async () => undefined),
            },
            indexedTexts: { getByBookId: vi.fn(async () => []), deleteByBookId: vi.fn() },
            transaction: vi.fn(async (_mode: unknown, _tables: unknown, callback: () => unknown) =>
                callback(),
            ),
        } as never

        const generations = {
            content: 0,
            preview: 0,
            request: 0,
            relinkEpoch: 0,
            relinkOwner: 0,
            document: null,
            tempUrl: "",
        }
        await expect(
            (store as any).persistResourceCleanupMarker("book", generations),
        ).resolves.toBe("marked")
        expect(store.nodes.book).toMatchObject({ cleanupPending: "resource-limit" })

        await store.updateFile("book", { metadata: { totalPages: 2 } })
        expect(persisted).toMatchObject({
            cleanupPending: "resource-limit",
            metadata: { totalPages: 2 },
        })

        vi.stubGlobal(
            "fetch",
            vi.fn(async () => ({ blob: async () => new Blob(["preview"]) })),
        )
        await store.savePreview("book", "blob:preview")
        expect(persisted.cleanupPending).toBe("resource-limit")

        const fallbacks = new Map([["vfs:resource-cleanup:book", "resource-limit"]])
        vi.stubGlobal("localStorage", {
            getItem: (key: string) => fallbacks.get(key) ?? null,
            removeItem: (key: string) => fallbacks.delete(key),
        })
        await store.relinkFile("book", handle("replacement.pdf"))
        expect(
            (store.nodes.book as Extract<VFSNodes[string], { type: "file" }>).cleanupPending,
        ).toBeUndefined()
        expect(persisted.cleanupPending).toBeUndefined()
        expect(fallbacks.size).toBe(0)
        expect((store as any).resourceCleanupMarkers.has("book")).toBe(false)
    })

    it("does not roll back a newer relink when stale import enrichment hits a resource limit", async () => {
        let rejectCanvas!: (error: unknown) => void
        documentCanvas.mockImplementationOnce(
            () =>
                new Promise<string>((_, reject) => {
                    rejectCanvas = reject
                }),
        )
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        const put = vi.fn(async () => undefined)
        store.db = { files: { put } } as never
        const deleteNode = vi.spyOn(store, "deleteNode")
        const enriching = (store as any).enrichImport(
            { id: "book", name: "book.pdf", parentId: null },
            {},
            {
                content: 0,
                preview: 0,
                request: 0,
                relinkEpoch: 0,
                relinkOwner: 0,
                document: {
                    getPageNumber: vi.fn(async () => 2),
                    getAuthor: vi.fn(async () => null),
                    getTitle: vi.fn(async () => null),
                    getPage: vi.fn(async () => ({})),
                    getCanvasPage: (...args: unknown[]) => documentCanvas(...args),
                    close: vi.fn(async () => undefined),
                },
                tempUrl: "blob:import",
            },
        )

        await vi.waitFor(() => expect(documentCanvas).toHaveBeenCalledOnce())
        ;(store as any).invalidateContent("book")
        ;(store.nodes as any).book = {
            ...store.nodes.book,
            type: "file",
            metadata: { pageNumber: 1, totalPages: 9 },
        }
        rejectCanvas(new DocumentSourceLimitError("pixel canvas limit"))

        await expect(enriching).resolves.toMatchObject({ id: "book", status: "failed" })
        expect(deleteNode).not.toHaveBeenCalled()
        expect(store.nodes.book).toMatchObject({ metadata: { totalPages: 9 } })
    })

    it("does not roll back after a superseding relink succeeds", async () => {
        let rejectCanvas!: (error: unknown) => void
        documentCanvas.mockImplementationOnce(
            () =>
                new Promise<string>((_, reject) => {
                    rejectCanvas = reject
                }),
        )
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        store.db = { files: { put: vi.fn(async () => undefined) } } as never
        const generations = {
            content: 0,
            preview: 0,
            request: 0,
            relinkEpoch: 0,
            relinkOwner: 0,
            document: {
                getPageNumber: vi.fn(async () => 2),
                getAuthor: vi.fn(async () => null),
                getTitle: vi.fn(async () => null),
                getPage: vi.fn(async () => ({})),
                getCanvasPage: (...args: unknown[]) => documentCanvas(...args),
                close: vi.fn(async () => undefined),
            },
            tempUrl: "blob:import",
        }
        const deleteNodeUnlocked = vi
            .spyOn(store as any, "deleteNodeUnlocked")
            .mockResolvedValue(undefined)
        ;(store as any).relinkingCounts.set("book", 1)
        const enriching = (store as any).enrichImport(
            { id: "book", name: "book.pdf", parentId: null },
            {},
            generations,
        )

        await vi.waitFor(() => expect(documentCanvas).toHaveBeenCalledOnce())
        rejectCanvas(new DocumentSourceLimitError("pixel canvas limit"))
        await vi.waitFor(() => expect((store as any).relinkWaiters.has("book")).toBe(true))

        ;(store as any).invalidateContent("book")
        ;(store as any).relinkEpochs.set("book", 1)
        ;(store as any).relinkStateOwners.set("book", 1)
        ;(store as any).relinkingCounts.delete("book")
        for (const resolve of (store as any).relinkWaiters.get("book") ?? []) resolve()

        await expect(enriching).resolves.toMatchObject({ id: "book", status: "failed" })
        expect(deleteNodeUnlocked).not.toHaveBeenCalled()
    })

    it("rolls back after a superseding relink fails", async () => {
        let rejectCanvas!: (error: unknown) => void
        documentCanvas.mockImplementationOnce(
            () =>
                new Promise<string>((_, reject) => {
                    rejectCanvas = reject
                }),
        )
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        store.db = { files: { put: vi.fn(async () => undefined) } } as never
        const deleteNodeUnlocked = vi
            .spyOn(store as any, "deleteNodeUnlocked")
            .mockResolvedValue(undefined)
        ;(store as any).relinkingCounts.set("book", 1)
        const enriching = (store as any).enrichImport(
            { id: "book", name: "book.pdf", parentId: null },
            {},
            {
                content: 0,
                preview: 0,
                request: 0,
                relinkEpoch: 0,
                relinkOwner: 0,
                document: {
                    getPageNumber: vi.fn(async () => 2),
                    getAuthor: vi.fn(async () => null),
                    getTitle: vi.fn(async () => null),
                    getPage: vi.fn(async () => ({})),
                    getCanvasPage: (...args: unknown[]) => documentCanvas(...args),
                    close: vi.fn(async () => undefined),
                },
                tempUrl: "blob:import",
            },
        )

        await vi.waitFor(() => expect(documentCanvas).toHaveBeenCalledOnce())
        rejectCanvas(new DocumentSourceLimitError("pixel canvas limit"))
        await vi.waitFor(() => expect((store as any).relinkWaiters.has("book")).toBe(true))

        ;(store as any).relinkingCounts.delete("book")
        for (const resolve of (store as any).relinkWaiters.get("book") ?? []) resolve()

        await expect(enriching).resolves.toMatchObject({ id: "book", status: "failed" })
        expect(deleteNodeUnlocked).toHaveBeenCalledWith("book", 0)
    })

    it("does not let enrichment metadata commit after a relink supersedes the import", async () => {
        documentLoad.mockResolvedValue(undefined)
        documentPageCount.mockResolvedValue(4)
        documentAuthor.mockResolvedValue("Author")
        documentTitle.mockResolvedValue("Title")
        documentCanvas.mockResolvedValue("blob:import-preview")

        let releaseUpdate!: () => void
        let updateStarted!: () => void
        const updateReady = new Promise<void>((resolve) => (updateStarted = resolve))
        const updateGate = new Promise<void>((resolve) => (releaseUpdate = resolve))
        const store = new VFSStore()
        const put = vi.fn(async () => undefined)
        const transaction = vi.fn(
            async (_mode: unknown, _tables: unknown, callback: () => unknown) => callback(),
        )
        store.db = {
            folders: { getAll: vi.fn(async () => []) },
            files: { getAll: vi.fn(async () => []), put },
            fileContents: { put },
            previews: { put: vi.fn(async () => "preview"), delete: vi.fn(async () => undefined) },
            indexedTexts: { deleteByBookId: vi.fn(async () => undefined) },
            transaction,
        } as never
        const originalUpdateFile = store.updateFile.bind(store)
        const updateFile = vi
            .spyOn(store, "updateFile")
            .mockImplementation(async (id, updates, preserveUpdatedAt, expectedGeneration) => {
                if (expectedGeneration !== undefined) {
                    updateStarted()
                    await updateGate
                }
                return originalUpdateFile(id, updates, preserveUpdatedAt, expectedGeneration)
            })
        const savePreview = vi.spyOn(store, "savePreview").mockImplementation(async () => undefined)

        const importing = store.importFiles(
            [{ name: "overlap.pdf", source: handle("overlap.pdf") }],
            null,
        )
        await updateReady
        const id = store.importJobs[0].id
        const relinking = store.relinkFile(id, handle("replacement.pdf"))
        await Promise.resolve()
        releaseUpdate()

        await expect(relinking).resolves.toBeUndefined()
        await expect(importing).resolves.toMatchObject([{ id, status: "imported" }])
        expect(updateFile).toHaveBeenCalledWith(
            id,
            expect.objectContaining({ metadata: expect.objectContaining({ totalPages: 4 }) }),
            true,
            0,
        )
        expect(savePreview).toHaveBeenCalledWith(id, "blob:import-preview", true, 0, 0, 0)
        expect(store.nodes[id]).toMatchObject({ metadata: { pageNumber: 1 } })
        expect((store.nodes[id] as any).metadata.totalPages).toBeUndefined()
    })
})

describe("VFS pinning", () => {
    const nodes: VFSNodes = {
        "unpinned-file-new": {
            id: "unpinned-file-new",
            name: "Unpinned new.pdf",
            type: "file",
            parentId: null,
            size: 1,
            createdAt: 1,
            updatedAt: 8,
            isPinned: false,
            metadata: { pageNumber: 1 },
        },
        "pinned-folder-old": {
            id: "pinned-folder-old",
            name: "Pinned old folder",
            type: "folder",
            parentId: null,
            childrenIds: [],
            createdAt: 1,
            updatedAt: 2,
            isPinned: true,
        },
        "unpinned-folder-old": {
            id: "unpinned-folder-old",
            name: "Unpinned old folder",
            type: "folder",
            parentId: null,
            childrenIds: [],
            createdAt: 1,
            updatedAt: 3,
            isPinned: false,
        },
        "pinned-file-new": {
            id: "pinned-file-new",
            name: "Pinned new.pdf",
            type: "file",
            parentId: null,
            size: 1,
            createdAt: 1,
            updatedAt: 7,
            metadata: { pageNumber: 1 },
            isPinned: true,
        },
        "pinned-folder-new": {
            id: "pinned-folder-new",
            name: "Pinned new folder",
            type: "folder",
            parentId: null,
            childrenIds: [],
            createdAt: 1,
            updatedAt: 6,
            isPinned: true,
        },
        "unpinned-folder-new": {
            id: "unpinned-folder-new",
            name: "Unpinned new folder",
            type: "folder",
            parentId: null,
            childrenIds: [],
            createdAt: 1,
            updatedAt: 5,
            isPinned: false,
        },
        "pinned-file-old": {
            id: "pinned-file-old",
            name: "Pinned old.pdf",
            type: "file",
            parentId: null,
            size: 1,
            createdAt: 1,
            updatedAt: 1,
            metadata: { pageNumber: 1 },
            isPinned: true,
        },
        "unpinned-file-old": {
            id: "unpinned-file-old",
            name: "Unpinned old.pdf",
            type: "file",
            parentId: null,
            size: 1,
            createdAt: 1,
            updatedAt: 4,
            metadata: { pageNumber: 1 },
            isPinned: false,
        },
    }

    it("sorts by pin and node type before descending recency", () => {
        const store = new VFSStore(structuredClone(nodes))
        expect(store.sortedCurrentNodes.map(({ id }) => id)).toEqual([
            "pinned-folder-new",
            "pinned-folder-old",
            "pinned-file-new",
            "pinned-file-old",
            "unpinned-folder-new",
            "unpinned-folder-old",
            "unpinned-file-new",
            "unpinned-file-old",
        ])
    })

    it.each([
        ["pinned-file-new", "files"],
        ["pinned-folder-new", "folders"],
    ] as const)("persists %s in the correct table before publishing", async (id, table) => {
        const store = new VFSStore(structuredClone(nodes))
        let resolveWrite!: () => void
        const update = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    resolveWrite = resolve
                }),
        )
        const otherUpdate = vi.fn()
        store.db = {
            files: { update: table === "files" ? update : otherUpdate },
            folders: { update: table === "folders" ? update : otherUpdate },
        } as never
        const before = store.nodes[id]
        const pending = store.setNodePinned(id, false)

        expect(store.nodes[id]).toBe(before)
        expect(store.nodes[id].isPinned).toBe(true)
        expect(update).toHaveBeenCalledWith(id, { isPinned: false })
        expect(otherUpdate).not.toHaveBeenCalled()

        resolveWrite()
        await pending
        expect(store.nodes[id]).toBe(before)
        expect(store.nodes[id]).toMatchObject({ isPinned: false, updatedAt: before.updatedAt })
    })

    it("serializes a delayed pin write with a concurrent metadata update", async () => {
        const store = new VFSStore(structuredClone(nodes))
        let resolveFirstWrite!: () => void
        const update = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    resolveFirstWrite = resolve
                }),
        )
        const put = vi.fn().mockResolvedValue(undefined)
        store.db = { files: { update, put }, folders: { update: vi.fn(), put: vi.fn() } } as never

        const pin = store.setNodePinned("unpinned-file-new", true)
        const updateMetadata = store.updateFile("unpinned-file-new", {
            metadata: { author: "Concurrent author" },
        })

        expect(update).toHaveBeenCalledTimes(1)
        expect(put).not.toHaveBeenCalled()
        resolveFirstWrite()
        await Promise.all([pin, updateMetadata])

        expect(store.nodes["unpinned-file-new"]).toMatchObject({
            isPinned: true,
            metadata: { pageNumber: 1, author: "Concurrent author" },
        })
        expect(put).toHaveBeenLastCalledWith(
            expect.objectContaining({
                isPinned: true,
                metadata: { pageNumber: 1, author: "Concurrent author" },
            }),
        )
    })

    it("skips unchanged state and leaves memory and ordering unchanged on failure", async () => {
        const store = new VFSStore(structuredClone(nodes))
        const update = vi.fn(async () => {
            throw new Error("disk full")
        })
        store.db = { files: { update }, folders: { update } } as never
        const originalOrder = store.sortedCurrentNodes.map(({ id }) => id)
        const originalNode = store.nodes["pinned-file-new"]

        await store.setNodePinned("pinned-file-new", true)
        expect(update).not.toHaveBeenCalled()

        await expect(store.setNodePinned("pinned-file-new", false)).rejects.toThrow("disk full")
        expect(store.nodes["pinned-file-new"]).toBe(originalNode)
        expect(store.sortedCurrentNodes.map(({ id }) => id)).toEqual(originalOrder)
    })
})

describe("VFS metadata enrichment ownership", () => {
    it("does not parse a legacy file solely because its optional author is unchecked", async () => {
        const idleCallbacks: IdleRequestCallback[] = []
        vi.stubGlobal(
            "requestIdleCallback",
            vi.fn((callback: IdleRequestCallback) => {
                idleCallbacks.push(callback)
                return 1
            }),
        )
        vi.stubGlobal("cancelIdleCallback", vi.fn())
        vi.stubGlobal("document", {
            visibilityState: "visible",
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        })

        const store = new VFSStore({
            legacy: {
                id: "legacy",
                name: "legacy.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1, totalPages: 10, author: undefined },
            },
        })
        store.initialized = true

        const release = store.acquireMetadataEnrichment()
        idleCallbacks[0]({ didTimeout: false, timeRemaining: () => 50 })
        await Promise.resolve()
        await Promise.resolve()

        expect(documentConstructed).not.toHaveBeenCalled()
        release()
    })

    it("cancels queued enrichment when the library releases ownership", () => {
        const cancelIdleCallback = vi.fn()
        vi.stubGlobal(
            "requestIdleCallback",
            vi.fn(() => 7),
        )
        vi.stubGlobal("cancelIdleCallback", cancelIdleCallback)
        vi.stubGlobal("document", {
            visibilityState: "visible",
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        })

        const store = new VFSStore()
        const release = store.acquireMetadataEnrichment()
        release()

        expect(cancelIdleCallback).toHaveBeenCalledWith(7)
    })
})

describe("VFS file access persistence", () => {
    it("retries restored access when relinking starts during persistence", async () => {
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                isLocked: true,
                metadata: { pageNumber: 1 },
            },
        })
        let relinkPromise: Promise<void> | undefined
        let relinkStarted = false
        const put = vi.fn(async () => {
            if (!relinkStarted) {
                relinkStarted = true
                relinkPromise = store.relinkFile("book", handle("new-book.pdf"))
                await Promise.resolve()
            }
        })
        store.db = {
            files: { put },
            fileContents: { put: vi.fn(async () => undefined) },
            previews: { delete: vi.fn(async () => undefined) },
            indexedTexts: { deleteByBookId: vi.fn(async () => undefined) },
            transaction: vi.fn(async (_mode, _tables, callback) => callback()),
        } as never
        vi.spyOn(store, "getFileUrl").mockResolvedValue("blob:old")
        store.fileUrls.book = "blob:old"
        const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)

        await expect(store.restoreFileAccess("book")).resolves.toBe("blob:old")
        await relinkPromise

        expect(revokeObjectURL).toHaveBeenCalledWith("blob:old")
    })

    it("creates an access URL without parsing a handle's file contents", async () => {
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                isLocked: false,
                metadata: { pageNumber: 1 },
            },
        })
        const getFile = vi.fn(async () => new Blob(["oversized-pdf"], { type: "application/pdf" }))
        const changingHandle = Object.assign(handle("book.pdf"), {
            queryPermission: vi.fn(async () => "granted"),
            getFile,
        })
        const put = vi.fn(async () => undefined)
        store.db = {
            files: { put },
            fileContents: { get: vi.fn(async () => ({ handle: changingHandle })) },
        } as never
        const createObjectURL = vi.spyOn(URL, "createObjectURL")

        await expect(store.getFileUrl("book")).resolves.toMatch(/^blob:/)
        expect(getFile).toHaveBeenCalledOnce()
        expect(createObjectURL).toHaveBeenCalledOnce()
        expect(put).not.toHaveBeenCalled()
    })

    it("rolls back the content generation when relinking cannot read the replacement", async () => {
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                isLocked: true,
                metadata: { pageNumber: 1 },
            },
        })
        const put = vi.fn(async () => undefined)
        store.db = { files: { put } } as never
        const invalidations: string[] = []
        const relinks: string[] = []
        store.onNodeInvalidated((id) => invalidations.push(id))
        store.onNodeRelinked((id) => relinks.push(id))
        const failedHandle = Object.assign(handle("missing.pdf"), {
            getFile: vi.fn(async () => {
                throw new Error("file unavailable")
            }),
        })

        await expect(store.relinkFile("book", failedHandle)).rejects.toThrow(
            "Failed to retrieve file object during VFS relinking",
        )

        expect(store.getContentGeneration("book")).toBe(0)
        expect(invalidations).toEqual([])
        expect(relinks).toEqual([])
        await store.updateFile("book", { metadata: { author: "Original" } }, false, 0)
        expect(put).toHaveBeenCalledWith(expect.objectContaining({ id: "book" }))
    })

    it("does not notify a committed relink or reacquire its URL after rollback", async () => {
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 10,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                isLocked: false,
                metadata: { pageNumber: 1 },
            },
        })
        const transaction = vi.fn(async () => {
            throw new Error("replacement transaction failed")
        })
        store.db = {
            files: { put: vi.fn(async () => undefined) },
            fileContents: { put: vi.fn(async () => undefined) },
            previews: { delete: vi.fn(async () => undefined) },
            indexedTexts: { deleteByBookId: vi.fn(async () => undefined) },
            transaction,
        } as never
        store.fileUrls.book = "blob:old"
        ;(store as any).fileUrlOwnership.set("book", {
            url: "blob:old",
            viewer: 1,
            temporary: 0,
        })
        vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:candidate")
        vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)
        const relinked = vi.fn()
        const restored = vi.fn()
        const getFileUrl = vi.spyOn(store, "getFileUrl")
        store.onNodeRelinked((id) => {
            relinked(id)
            void getFileUrl(id)
        })
        store.onContentRestored(restored)

        await expect(store.relinkFile("book", handle("replacement.pdf"))).rejects.toThrow(
            "replacement transaction failed",
        )

        expect(store.getContentGeneration("book")).toBe(0)
        expect(store.fileUrls.book).toBe("blob:old")
        expect(relinked).not.toHaveBeenCalled()
        expect(getFileUrl).not.toHaveBeenCalled()
        expect(restored).toHaveBeenCalledWith("book")
    })

    it("closes a relink candidate directly when disposal interrupts validation", async () => {
        let resolveLoad!: () => void
        documentLoad.mockImplementationOnce(
            () =>
                new Promise<void>((resolve) => {
                    resolveLoad = resolve
                }),
        )
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        store.db = { close: vi.fn() } as never

        const relinking = store.relinkFile("book", handle("replacement.pdf"))
        await vi.waitFor(() => expect(documentLoad).toHaveBeenCalledOnce())
        const disposing = store.dispose()
        resolveLoad()
        await disposing

        await expect(relinking).rejects.toMatchObject({ name: "VFSDisposedError" })
        expect(documentClose).toHaveBeenCalledOnce()
    })

    it("rejects oversized relink candidates before opening a document", async () => {
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 10,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                isLocked: true,
                metadata: { pageNumber: 1 },
            },
        })
        const oversizedHandle = Object.assign(handle("large.pdf"), {
            getFile: vi.fn(async () => ({
                size: DOCUMENT_SOURCE_LIMITS.maxFileBytes + 1,
                type: "application/pdf",
            })),
        })

        await expect(store.relinkFile("book", oversizedHandle)).rejects.toThrow("limit")
        expect(documentService.open).not.toHaveBeenCalled()
    })

    it("rejects relink candidates that exceed render pixel limits before persistence", async () => {
        documentRenderBounds.mockRejectedValueOnce(
            new DocumentSourceLimitError("pixel canvas limit"),
        )
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 10,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                isLocked: true,
                metadata: { pageNumber: 1 },
            },
        })
        const put = vi.fn(async () => undefined)
        store.db = { files: { put } } as never

        await expect(store.relinkFile("book", handle("large-page.pdf"))).rejects.toThrow(
            "pixel canvas limit",
        )
        expect(put).not.toHaveBeenCalled()
    })

    it("does not replace persisted content when a relink candidate is not a readable PDF", async () => {
        documentLoad.mockRejectedValue(new Error("corrupt replacement"))
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 10,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                isLocked: true,
                metadata: { pageNumber: 3 },
            },
        })
        const deletePreview = vi.fn(async () => undefined)
        const deleteIndexedText = vi.fn(async () => undefined)
        const put = vi.fn(async () => undefined)
        store.db = {
            files: { put },
            fileContents: { put: vi.fn(async () => undefined) },
            previews: { delete: deletePreview },
            indexedTexts: { deleteByBookId: deleteIndexedText },
            transaction: vi.fn(async (_mode, _tables, callback) => callback()),
        } as never
        const invalidations: string[] = []
        store.onNodeInvalidated((id) => invalidations.push(id))

        await expect(store.relinkFile("book", handle("replacement.pdf"))).rejects.toThrow(
            "corrupt replacement",
        )

        expect(store.nodes.book).toMatchObject({ size: 10, metadata: { pageNumber: 3 } })
        expect(store.getContentGeneration("book")).toBe(0)
        expect(invalidations).toEqual([])
        expect(put).not.toHaveBeenCalled()
        expect(deletePreview).not.toHaveBeenCalled()
        expect(deleteIndexedText).not.toHaveBeenCalled()
    })

    it("detects a relink handle without reading an undefined global File", async () => {
        vi.stubGlobal("File", undefined)
        const fileHandle = Object.assign(handle("replacement.pdf"), {
            queryPermission: vi.fn(async () => "granted"),
        })
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        store.db = {
            files: { put: vi.fn(async () => undefined) },
            fileContents: { put: vi.fn(async () => undefined) },
            previews: { delete: vi.fn(async () => undefined) },
            indexedTexts: { deleteByBookId: vi.fn(async () => undefined) },
            transaction: vi.fn(async (_mode, _tables, callback) => callback()),
        } as never

        await expect(store.relinkFile("book", fileHandle)).resolves.toBeUndefined()
        expect(fileHandle.getFile).toHaveBeenCalledOnce()
    })

    it("persists a relinked handle as locked until permission is restored", async () => {
        const fileHandle = Object.assign(handle("replacement.pdf"), {
            queryPermission: vi.fn(async () => "prompt"),
            requestPermission: vi.fn(async () => "granted"),
        })
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        const put = vi.fn(async () => undefined)
        store.db = {
            files: { put },
            fileContents: { put: vi.fn(async () => undefined) },
            previews: { delete: vi.fn(async () => undefined) },
            indexedTexts: { deleteByBookId: vi.fn(async () => undefined) },
            transaction: vi.fn(async (_mode, _tables, callback) => callback()),
        } as never

        await store.relinkFile("book", fileHandle)

        expect(put).toHaveBeenCalledWith(expect.objectContaining({ id: "book", isLocked: true }))
        expect(store.nodes.book).toMatchObject({ isLocked: true })
        expect(store.isLockedMap.book).toBe(true)
    })

    it("revalidates permission instead of trusting a temporary cached URL", async () => {
        const fileHandle = Object.assign(handle("book.pdf"), {
            queryPermission: vi.fn(async () => "denied"),
            requestPermission: vi.fn(async () => "denied"),
        })
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                isLocked: true,
                metadata: { pageNumber: 1 },
            },
        })
        ;(store as any).nativeHandles.set("book", fileHandle)
        const put = vi.fn(async () => undefined)
        store.db = { files: { put }, fileContents: { get: vi.fn() } } as never
        store.fileUrls.book = "blob:temporary"
        ;(store as any).fileUrlOwnership.set("book", {
            url: "blob:temporary",
            viewer: 0,
            temporary: 1,
        })
        const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)

        await expect(store.restoreFileAccess("book")).rejects.toThrow(
            "Failed to restore file access",
        )

        expect(fileHandle.queryPermission).toHaveBeenCalledWith({ mode: "read" })
        expect(fileHandle.requestPermission).toHaveBeenCalledWith({ mode: "read" })
        expect(put).not.toHaveBeenCalledWith(expect.objectContaining({ isLocked: false }))
        expect(revokeObjectURL).not.toHaveBeenCalled()
        expect(store.fileUrls.book).toBe("blob:temporary")
    })

    it("revokes the restore URL when final unlocked persistence fails", async () => {
        const fileHandle = Object.assign(handle("book.pdf"), {
            queryPermission: vi.fn(async () => "granted"),
        })
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                isLocked: true,
                metadata: { pageNumber: 1 },
            },
        })
        ;(store as any).nativeHandles.set("book", fileHandle)
        const put = vi
            .fn()
            .mockResolvedValueOnce("book")
            .mockRejectedValueOnce(new Error("final persistence failed"))
        store.db = { files: { put } } as never
        vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:restore")
        const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)

        await expect(store.restoreFileAccess("book")).rejects.toThrow("final persistence failed")
        expect(revokeObjectURL).toHaveBeenCalledWith("blob:restore")
        expect(store.fileUrls.book).toBeUndefined()
    })

    it("releases only restore ownership when persistence fails for a shared URL", async () => {
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                isLocked: true,
                metadata: { pageNumber: 1 },
            },
        })
        vi.spyOn(store, "getFileUrl").mockResolvedValue("blob:shared")
        store.fileUrls.book = "blob:shared"
        ;(store as any).fileUrlOwnership.set("book", {
            url: "blob:shared",
            viewer: 1,
            temporary: 1,
        })
        store.db = {
            files: { put: vi.fn().mockRejectedValue(new Error("final persistence failed")) },
        } as never
        const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)

        await expect(store.restoreFileAccess("book")).rejects.toThrow("final persistence failed")

        expect(revokeObjectURL).not.toHaveBeenCalled()
        expect(store.fileUrls.book).toBe("blob:shared")
        expect((store as any).fileUrlOwnership.get("book")).toMatchObject({
            viewer: 0,
            temporary: 1,
        })
    })

    it("keeps a concurrent restore lease after its sibling fails", async () => {
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                isLocked: true,
                metadata: { pageNumber: 1 },
            },
        })
        vi.spyOn(store, "getFileUrl").mockResolvedValue("blob:shared")
        store.fileUrls.book = "blob:shared"
        ;(store as any).fileUrlOwnership.set("book", {
            url: "blob:shared",
            viewer: 2,
            temporary: 0,
        })
        const put = vi
            .fn()
            .mockRejectedValueOnce(new Error("one restore failed"))
            .mockResolvedValueOnce("book")
        store.db = { files: { put } } as never
        const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)

        const first = store.restoreFileAccess("book")
        const second = store.restoreFileAccess("book")
        await expect(first).rejects.toThrow("one restore failed")
        await expect(second).resolves.toBe("blob:shared")

        expect(revokeObjectURL).not.toHaveBeenCalled()
        expect((store as any).fileUrlOwnership.get("book")).toMatchObject({ viewer: 1 })
    })

    it("persists a restored handle as unlocked", async () => {
        const fileHandle = Object.assign(handle("book.pdf"), {
            queryPermission: vi.fn(async () => "prompt"),
            requestPermission: vi.fn(async () => "granted"),
        })
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                isLocked: true,
                metadata: { pageNumber: 1 },
            },
        })
        const put = vi.fn(async () => undefined)
        store.db = {
            files: { put },
            fileContents: {
                get: vi.fn(async () => ({ id: "book", handle: fileHandle })),
            },
        } as never
        vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:book")

        await store.restoreFileAccess("book")

        expect(put).toHaveBeenCalledWith(expect.objectContaining({ id: "book", isLocked: false }))
        expect(store.nodes.book).toMatchObject({ isLocked: false })
        expect(store.isLockedMap.book).toBe(false)
    })

    it("persists successful lazy handle access as unlocked", async () => {
        const fileHandle = Object.assign(handle("book.pdf"), {
            queryPermission: vi.fn(async () => "granted"),
        })
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                isLocked: true,
                metadata: { pageNumber: 1 },
            },
        })
        const put = vi.fn(async () => undefined)
        store.db = {
            files: { put },
            fileContents: {
                get: vi.fn(async () => ({ id: "book", handle: fileHandle })),
            },
        } as never
        vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:book")

        await expect(store.getFileUrl("book")).resolves.toBe("blob:book")

        expect(put).toHaveBeenCalledWith(expect.objectContaining({ id: "book", isLocked: false }))
        expect(store.nodes.book).toMatchObject({ isLocked: false })
        expect(store.isLockedMap.book).toBe(false)
    })

    it("deduplicates concurrent file URL creation for one content generation", async () => {
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                isLocked: false,
                metadata: { pageNumber: 1 },
            },
        })
        let resolveContent!: (content: { id: string; file: Blob }) => void
        const getContent = vi.fn(
            () =>
                new Promise<{ id: string; file: Blob }>((resolve) => {
                    resolveContent = resolve
                }),
        )
        store.db = {
            fileContents: { get: getContent },
            files: { put: vi.fn(async () => undefined) },
        } as never
        const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:file")

        const first = store.getFileUrl("book")
        const second = store.getFileUrl("book")
        resolveContent({ id: "book", file: new Blob(["pdf"]) })

        await expect(Promise.all([first, second])).resolves.toEqual(["blob:file", "blob:file"])
        expect(getContent).toHaveBeenCalledOnce()
        expect(createObjectURL).toHaveBeenCalledOnce()
    })

    it("keeps unlocked persistence valid for concurrent deduplicated access", async () => {
        const fileHandle = Object.assign(handle("book.pdf"), {
            queryPermission: vi.fn(async () => "granted"),
            getFile: vi.fn(async () => new Blob(["pdf"], { type: "application/pdf" })),
        })
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                isLocked: true,
                metadata: { pageNumber: 1 },
            },
        })
        ;(store as any).nativeHandles.set("book", fileHandle)
        const put = vi.fn(async () => undefined)
        store.db = { files: { put } } as never
        vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:book")

        const first = store.getFileUrl("book")
        const second = store.getFileUrl("book")

        await expect(Promise.all([first, second])).resolves.toEqual(["blob:book", "blob:book"])
        expect(put).toHaveBeenCalledWith(expect.objectContaining({ id: "book", isLocked: false }))
        expect(store.nodes.book).toMatchObject({ isLocked: false })
    })

    it("retries an access read that is superseded by a successful relink", async () => {
        let resolveOldFile!: (file: Blob) => void
        const oldHandle = Object.assign(handle("old.pdf"), {
            queryPermission: vi.fn(async () => "granted"),
            getFile: vi.fn(
                () =>
                    new Promise<Blob>((resolve) => {
                        resolveOldFile = resolve
                    }),
            ),
        })
        const replacementHandle = Object.assign(handle("replacement.pdf"), {
            queryPermission: vi.fn(async () => "granted"),
        })
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        ;(store as any).nativeHandles.set("book", oldHandle)
        store.db = {
            files: { put: vi.fn(async () => undefined) },
            fileContents: { put: vi.fn(async () => undefined) },
            previews: { delete: vi.fn(async () => undefined) },
            indexedTexts: { deleteByBookId: vi.fn(async () => undefined) },
            transaction: vi.fn(async (_mode, _tables, callback) => callback()),
        } as never
        const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:new")

        const access = store.getFileUrl("book")
        await vi.waitFor(() => expect(oldHandle.getFile).toHaveBeenCalledOnce())

        await store.relinkFile("book", replacementHandle)
        resolveOldFile(new Blob(["old"], { type: "application/pdf" }))

        await expect(access).resolves.toBe("blob:new")
        expect(createObjectURL).toHaveBeenCalledOnce()
        expect(replacementHandle.queryPermission).toHaveBeenCalledOnce()
    })

    it("retries an old-handle read after validation-only relink failure", async () => {
        let resolveOldFile!: (file: Blob) => void
        const oldHandle = Object.assign(handle("old.pdf"), {
            queryPermission: vi.fn(async () => "granted"),
            getFile: vi
                .fn()
                .mockImplementationOnce(
                    () => new Promise<Blob>((resolve) => (resolveOldFile = resolve)),
                )
                .mockResolvedValue(new Blob(["old"], { type: "application/pdf" })),
        })
        const failedHandle = Object.assign(handle("replacement.pdf"), {
            getFile: vi.fn(async () => {
                throw new Error("replacement unavailable")
            }),
        })
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        ;(store as any).nativeHandles.set("book", oldHandle)
        store.db = { files: { put: vi.fn(async () => undefined) } } as never
        vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:old")

        const access = store.getFileUrl("book")
        await vi.waitFor(() => expect(oldHandle.getFile).toHaveBeenCalledOnce())
        await expect(store.relinkFile("book", failedHandle)).rejects.toThrow(
            "Failed to retrieve file object",
        )
        resolveOldFile(new Blob(["old"], { type: "application/pdf" }))

        await expect(access).resolves.toBe("blob:old")
        expect(oldHandle.getFile).toHaveBeenCalledTimes(2)
    })

    it("reuses the current URL when permission escalation duplicates a read", async () => {
        let resolveFirstQuery!: (status: PermissionState) => void
        const fileHandle = Object.assign(handle("book.pdf"), {
            queryPermission: vi
                .fn()
                .mockImplementationOnce(
                    () =>
                        new Promise<PermissionState>((resolve) => {
                            resolveFirstQuery = resolve
                        }),
                )
                .mockResolvedValue("granted"),
            getFile: vi.fn(async () => new Blob(["pdf"])),
        })
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        ;(store as any).nativeHandles.set("book", fileHandle)
        store.db = { files: { put: vi.fn(async () => undefined) } } as never
        const createObjectURL = vi
            .spyOn(URL, "createObjectURL")
            .mockReturnValueOnce("blob:first")
            .mockReturnValueOnce("blob:extra")
        const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)

        const normal = store.getFileUrl("book")
        await Promise.resolve()
        const escalated = store.getFileUrl("book", true)
        resolveFirstQuery("granted")

        await expect(Promise.all([normal, escalated])).resolves.toEqual([
            "blob:first",
            "blob:first",
        ])
        expect(createObjectURL).toHaveBeenCalledTimes(2)
        expect(revokeObjectURL).toHaveBeenCalledWith("blob:extra")
        expect(store.fileUrls.book).toBe("blob:first")
    })

    it("emits one relink notification after overlapping relinks settle", async () => {
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        let resolveFirst!: (file: Blob) => void
        let calls = 0
        const firstHandle = handle("first.pdf")
        firstHandle.getFile = vi.fn(
            () =>
                new Promise<File>((resolve) => {
                    resolveFirst = (file) => resolve(file as File)
                }),
        )
        const transaction = vi.fn(async (_mode, _tables, callback) => callback())
        store.db = {
            files: { put: vi.fn(async () => undefined) },
            fileContents: { put: vi.fn(async () => undefined) },
            previews: { delete: vi.fn(async () => undefined) },
            indexedTexts: { deleteByBookId: vi.fn(async () => undefined) },
            transaction,
        } as never
        store.onNodeRelinked(() => calls++)

        const firstRelink = store.relinkFile("book", firstHandle)
        await Promise.resolve()
        await store.relinkFile("book", handle("second.pdf"))
        expect(calls).toBe(0)

        resolveFirst(new Blob(["first"]))
        await expect(firstRelink).rejects.toMatchObject({ name: "ContentSupersededError" })
        expect(calls).toBe(1)
        expect(transaction).toHaveBeenCalledOnce()
    })

    it("blocks an older relink after a newer relink fails", async () => {
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        let resolveFirst!: (file: File) => void
        const firstHandle = handle("first.pdf")
        firstHandle.getFile = vi.fn(
            () =>
                new Promise<File>((resolve) => {
                    resolveFirst = resolve
                }),
        )
        const failedHandle = handle("failed.pdf")
        failedHandle.getFile = vi.fn(async () => {
            throw new Error("replacement unavailable")
        })
        const transaction = vi.fn(async (_mode, _tables, callback) => callback())
        store.db = {
            files: { put: vi.fn(async () => undefined) },
            fileContents: { put: vi.fn(async () => undefined) },
            previews: { delete: vi.fn(async () => undefined) },
            indexedTexts: { deleteByBookId: vi.fn(async () => undefined) },
            transaction,
        } as never

        const firstRelink = store.relinkFile("book", firstHandle)
        await Promise.resolve()
        await expect(store.relinkFile("book", failedHandle)).rejects.toThrow(
            "Failed to retrieve file object",
        )
        resolveFirst(new Blob(["first"]) as File)

        await expect(firstRelink).rejects.toMatchObject({ name: "ContentSupersededError" })
        expect(transaction).not.toHaveBeenCalled()
        expect(store.nodes.book).toMatchObject({ name: "book.pdf", metadata: { pageNumber: 1 } })
        expect(store.getContentGeneration("book")).toBe(0)
    })

    it("does not let preview invalidation cancel file restoration", async () => {
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                isLocked: true,
                metadata: { pageNumber: 1 },
            },
        })
        store.db = {
            previews: { delete: vi.fn(async () => undefined) },
            files: { put: vi.fn(async () => undefined) },
        } as never
        vi.spyOn(store, "getFileUrl").mockResolvedValue("blob:restored")
        vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:unused")

        const restoring = store.restoreFileAccess("book")
        await store.invalidatePreview("book")

        await expect(restoring).resolves.toBe("blob:restored")
        expect(store.nodes.book).toMatchObject({ isLocked: false })
    })

    it("restores generation state when a deletion transaction fails", async () => {
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        const transaction = vi.fn(
            async (_mode: unknown, _tables: unknown, callback: () => unknown) => callback(),
        )
        const deletionFailure = new Error("bulk delete failed")
        const settled = vi.fn()
        store.db = {
            transaction,
            files: { bulkDelete: vi.fn().mockRejectedValue(deletionFailure) },
            previews: { bulkDelete: vi.fn(async () => undefined) },
            fileContents: { bulkDelete: vi.fn(async () => undefined) },
            indexedTexts: { deleteByBookId: vi.fn(async () => undefined) },
            userNotes: { deleteByBookId: vi.fn(async () => undefined) },
            bookmarks: { deleteByBookId: vi.fn(async () => undefined) },
            folders: { bulkDelete: vi.fn(async () => undefined) },
        } as never
        const invalidations: string[] = []
        const deletionStarts: string[][] = []
        store.onNodeInvalidated((id) => invalidations.push(id))
        store.onNodesDeleting((ids) => deletionStarts.push(ids))
        ;(store as any).deletionWaiters.set("book", new Set([settled]))
        const generation = store.getContentGeneration("book")

        await expect(store.deleteNode("book")).rejects.toThrow("bulk delete failed")

        expect(store.nodes.book).toBeDefined()
        expect(store.getContentGeneration("book")).toBe(generation)
        expect((store as any).deletingFileIds.has("book")).toBe(false)
        expect(settled).toHaveBeenCalledOnce()
        expect(invalidations).toEqual(["book", "book"])
        expect(deletionStarts).toEqual([])
    })

    it("does not notify content restoration after disposal interrupts deletion rollback", async () => {
        let releaseTransaction!: () => void
        const transaction = vi.fn(
            () =>
                new Promise<never>((_, reject) => {
                    releaseTransaction = () => reject(new Error("transaction failed"))
                }),
        )
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        const restored = vi.fn()
        store.onContentRestored(restored)
        store.db = { transaction, close: vi.fn() } as never

        const deletion = store.deleteNode("book")
        await vi.waitFor(() => expect(transaction).toHaveBeenCalledOnce())
        const disposal = store.dispose()
        releaseTransaction()

        await expect(deletion).rejects.toThrow("transaction failed")
        await disposal
        expect(restored).not.toHaveBeenCalled()
    })

    it("keeps a committed deletion after disposal wins the settlement race", async () => {
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        store.db = {
            transaction: vi.fn(() => {
                queueMicrotask(() => void store.dispose())
                return Promise.resolve()
            }),
            close: vi.fn(),
        } as never

        await expect(store.deleteNode("book")).resolves.toBeUndefined()
        expect(store.nodes.book).toBeUndefined()
        expect(store.isNodeDeleting("book")).toBe(false)
    })

    it("finishes in-memory deletion when disposal follows a committed transaction", async () => {
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        store.db = { transaction: vi.fn(async () => undefined), close: vi.fn() } as never
        store.onNodesDeleting(() => void store.dispose())

        await expect(store.deleteNode("book")).resolves.toBeUndefined()
        expect(store.nodes.book).toBeUndefined()
        expect(store.isNodeDeleting("book")).toBe(false)
    })

    it("retries a pending access request after a failed deletion restores the node", async () => {
        let resolveFile!: (file: Blob) => void
        let firstRead = true
        const fileHandle = Object.assign(handle("book.pdf"), {
            queryPermission: vi.fn(async () => "granted"),
            getFile: vi.fn(() => {
                if (!firstRead) return Promise.resolve(new Blob(["pdf"]))
                return new Promise<Blob>((resolve) => (resolveFile = resolve))
            }),
        })
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        ;(store as any).nativeHandles.set("book", fileHandle)
        store.db = {
            transaction: vi.fn(async () => {
                throw new Error("delete failed")
            }),
        } as never
        vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:restored")

        const access = store.getFileUrl("book")
        await vi.waitFor(() => expect(fileHandle.getFile).toHaveBeenCalledOnce())
        await expect(store.deleteNode("book")).rejects.toThrow("delete failed")
        firstRead = false
        resolveFile(new Blob(["pdf"], { type: "application/pdf" }))

        await expect(access).resolves.toBe("blob:restored")
        expect(store.nodes.book).toBeDefined()
        expect(store.getContentGeneration("book")).toBe(0)
    })

    it("waits for deletion settlement and stops when deletion commits", async () => {
        let releaseDeletion!: () => void
        const transaction = vi.fn(() => new Promise<void>((resolve) => (releaseDeletion = resolve)))
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        store.db = { transaction } as never

        const deletion = store.deleteNode("book")
        await vi.waitFor(() => expect(transaction).toHaveBeenCalledOnce())
        const restoring = store.restoreFileAccess("book")
        await Promise.resolve()
        expect(await Promise.race([restoring, Promise.resolve("pending")])).toBe("pending")

        releaseDeletion()
        await expect(deletion).resolves.toBeUndefined()
        await expect(restoring).resolves.toBe("")
        expect(store.nodes.book).toBeUndefined()
        expect(store.isNodeDeleting("book")).toBe(false)
    })

    it("retries restoration after deletion rollback", async () => {
        let rejectDeletion!: (error: Error) => void
        const transaction = vi.fn(
            () => new Promise<void>((_resolve, reject) => (rejectDeletion = reject)),
        )
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        store.db = { transaction, files: { put: vi.fn(async () => undefined) } } as never
        vi.spyOn(store, "getFileUrl").mockResolvedValue("blob:restored")
        const restoring = store.restoreFileAccess("book")
        const deletion = store.deleteNode("book")
        await vi.waitFor(() => expect(transaction).toHaveBeenCalledOnce())
        rejectDeletion(new Error("delete failed"))

        await expect(deletion).rejects.toThrow("delete failed")
        await expect(restoring).resolves.toBe("blob:restored")
        expect(store.nodes.book).toBeDefined()
        expect(store.isNodeDeleting("book")).toBe(false)
    })

    it("isolates deletion listener failures and still completes cleanup", async () => {
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        store.db = { transaction: vi.fn(async () => undefined) } as never
        const started = vi.fn(() => {
            throw new Error("starting listener failed")
        })
        const completed = vi.fn(() => {
            throw new Error("completed listener failed")
        })
        const completedSecond = vi.fn()
        store.onNodesDeleting(started)
        store.onNodesDeleted(completed)
        store.onNodesDeleted(completedSecond)
        vi.spyOn(console, "error").mockImplementation(() => undefined)

        await expect(store.deleteNode("book")).resolves.toBeUndefined()

        expect(store.nodes.book).toBeUndefined()
        expect(store.isNodeDeleting("book")).toBe(false)
        expect(completedSecond).toHaveBeenCalledWith(["book"])
    })

    it("isolates a throwing relink listener from later listeners", async () => {
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        store.db = {
            files: { put: vi.fn(async () => undefined) },
            fileContents: { put: vi.fn(async () => undefined) },
            previews: { delete: vi.fn(async () => undefined) },
            indexedTexts: { deleteByBookId: vi.fn(async () => undefined) },
            transaction: vi.fn(async (_mode, _tables, callback) => callback()),
        } as never
        const error = new Error("listener failed")
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
        let laterCalls = 0
        store.onNodeRelinked(() => {
            throw error
        })
        store.onNodeRelinked(() => {
            laterCalls++
        })

        await store.relinkFile("book", handle("replacement.pdf"))

        expect(laterCalls).toBe(1)
        expect(consoleError).toHaveBeenCalledWith("VFS node relinked listener failed:", error)
    })

    it("notifies relink listeners after the relinking guard is cleared", async () => {
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        const fileHandle = Object.assign(handle("book.pdf"), {
            queryPermission: vi.fn(async () => "granted"),
        })
        store.db = {
            files: { put: vi.fn(async () => undefined) },
            fileContents: { put: vi.fn(async () => undefined) },
            previews: { delete: vi.fn(async () => undefined) },
            indexedTexts: { deleteByBookId: vi.fn(async () => undefined) },
            transaction: vi.fn(async (_mode, _tables, callback) => callback()),
        } as never
        vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:relinked")
        let listenerUrlPromise: Promise<string> | undefined
        store.onNodeRelinked((id) => {
            listenerUrlPromise = store.getFileUrl(id)
        })

        await store.relinkFile("book", fileHandle)

        await expect(listenerUrlPromise).resolves.toBe("blob:relinked")
        expect(store.fileUrls.book).toBe("blob:relinked")
    })

    it("does not republish a pending handle read after deletion", async () => {
        let resolveFile!: (file: Blob) => void
        const fileHandle = Object.assign(handle("book.pdf"), {
            queryPermission: vi.fn(async () => "granted"),
            getFile: vi.fn(
                () =>
                    new Promise<Blob>((resolve) => {
                        resolveFile = resolve
                    }),
            ),
        })
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        ;(store as any).nativeHandles.set("book", fileHandle)
        store.db = {
            transaction: vi.fn(async (_mode, _tables, callback) => callback()),
            files: { bulkDelete: vi.fn(async () => undefined) },
            folders: { bulkDelete: vi.fn(async () => undefined) },
            previews: { bulkDelete: vi.fn(async () => undefined) },
            fileContents: { bulkDelete: vi.fn(async () => undefined) },
            indexedTexts: { deleteByBookId: vi.fn(async () => undefined) },
            userNotes: { deleteByBookId: vi.fn(async () => undefined) },
            bookmarks: { deleteByBookId: vi.fn(async () => undefined) },
        } as never
        const createObjectURL = vi.spyOn(URL, "createObjectURL")
        const pending = store.getFileUrl("book")
        await Promise.resolve()
        await store.deleteNode("book")
        resolveFile(new Blob(["pdf"], { type: "application/pdf" }))

        await expect(pending).resolves.toBe("")
        expect(createObjectURL).not.toHaveBeenCalled()
        await expect(store.getFileUrl("book")).resolves.toBe("")
        expect(store.getContentGeneration("book")).toBe(1)
    })

    it("retries a pending old read after replacement validation fails before invalidation", async () => {
        let resolveOldFile!: (file: Blob) => void
        let rejectReplacement!: (error: Error) => void
        let firstRead = true
        const oldHandle = Object.assign(handle("old.pdf"), {
            queryPermission: vi.fn(async () => "granted"),
            getFile: vi.fn(() => {
                if (!firstRead) return Promise.resolve(new Blob(["old"]))
                firstRead = false
                return new Promise<Blob>((resolve) => {
                    resolveOldFile = resolve
                })
            }),
        })
        const failedHandle = Object.assign(handle("missing.pdf"), {
            getFile: vi.fn(
                () =>
                    new Promise<Blob>((_resolve, reject) => {
                        rejectReplacement = reject
                    }),
            ),
        })
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        ;(store as any).nativeHandles.set("book", oldHandle)
        store.db = { files: { put: vi.fn(async () => undefined) } } as never
        vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:old")

        const access = store.getFileUrl("book")
        await vi.waitFor(() => expect(oldHandle.getFile).toHaveBeenCalledOnce())
        const relinking = store.relinkFile("book", failedHandle)
        await vi.waitFor(() => expect(failedHandle.getFile).toHaveBeenCalledOnce())
        rejectReplacement(new Error("replacement unavailable"))
        resolveOldFile(new Blob(["old"], { type: "application/pdf" }))

        await expect(relinking).rejects.toThrow("Failed to retrieve file object")
        await expect(access).resolves.toBe("blob:old")
        expect(store.getContentGeneration("book")).toBe(0)
    })

    it("retries restoration after a failed relink rolls its generation back", async () => {
        const oldHandle = Object.assign(handle("old.pdf"), {
            queryPermission: vi.fn(async () => "granted"),
        })
        let rejectReplacement!: (error: Error) => void
        const failedHandle = Object.assign(handle("missing.pdf"), {
            getFile: vi.fn(
                () =>
                    new Promise<Blob>((_resolve, reject) => {
                        rejectReplacement = reject
                    }),
            ),
        })
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                isLocked: true,
                metadata: { pageNumber: 1 },
            },
        })
        ;(store as any).nativeHandles.set("book", oldHandle)
        store.db = { files: { put: vi.fn(async () => undefined) } } as never
        vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:restored")

        const relinking = store.relinkFile("book", failedHandle)
        await Promise.resolve()
        const restoring = store.restoreFileAccess("book")
        rejectReplacement(new Error("replacement unavailable"))

        await expect(relinking).rejects.toThrow("Failed to retrieve file object")
        await expect(restoring).resolves.toBe("blob:restored")
        expect(store.getContentGeneration("book")).toBe(0)
    })

    it("retries a pre-existing access request after a relink fails after invalidation", async () => {
        let resolveOldFile!: (file: Blob) => void
        let firstRead = true
        const oldHandle = Object.assign(handle("book.pdf"), {
            queryPermission: vi.fn(async () => "granted"),
            getFile: vi.fn(() => {
                if (!firstRead)
                    return Promise.resolve(new Blob(["old"], { type: "application/pdf" }))
                return new Promise<Blob>((resolve) => {
                    resolveOldFile = resolve
                })
            }),
        })
        const replacementHandle = handle("replacement.pdf")
        const put = vi.fn(async () => undefined)
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                isLocked: true,
                metadata: { pageNumber: 1 },
            },
        })
        ;(store as any).nativeHandles.set("book", oldHandle)
        store.db = {
            files: { put },
            fileContents: { put: vi.fn(async () => undefined) },
            previews: { delete: vi.fn(async () => undefined) },
            indexedTexts: { deleteByBookId: vi.fn(async () => undefined) },
            transaction: vi.fn(
                async (_mode: unknown, _tables: unknown, callback: () => unknown) => {
                    await callback()
                    throw new Error("replacement persistence failed")
                },
            ),
        } as never
        vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:restored")

        const access = store.getFileUrl("book")
        await vi.waitFor(() => expect(oldHandle.getFile).toHaveBeenCalledOnce())
        const relinking = store.relinkFile("book", replacementHandle)
        const relinkingFailure = relinking.catch((error: unknown) => error)
        await vi.waitFor(() => expect(put).toHaveBeenCalled())
        await expect(relinkingFailure).resolves.toMatchObject({
            message: "replacement persistence failed",
        })
        firstRead = false
        resolveOldFile(new Blob(["old"], { type: "application/pdf" }))

        await expect(access).resolves.toBe("blob:restored")
        expect(store.getContentGeneration("book")).toBe(0)
    })

    it("restores the original state when an older invalidated relink is superseded by failed validation", async () => {
        let releasePut!: () => void
        let putStarted!: () => void
        const putReady = new Promise<void>((resolve) => (putStarted = resolve))
        const putGate = new Promise<void>((resolve) => (releasePut = resolve))
        const put = vi.fn(async () => {
            putStarted()
            await putGate
        })
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        store.db = {
            files: { put },
            fileContents: { put: vi.fn(async () => undefined) },
            previews: { delete: vi.fn(async () => undefined) },
            indexedTexts: { deleteByBookId: vi.fn(async () => undefined) },
            transaction: vi.fn(async (_mode: unknown, _tables: unknown, callback: () => unknown) =>
                callback(),
            ),
        } as never

        const older = store.relinkFile("book", handle("older.pdf"))
        await putReady
        const newer = store.relinkFile(
            "book",
            Object.assign(handle("missing.pdf"), {
                getFile: vi.fn(async () => {
                    throw new Error("replacement unavailable")
                }),
            }),
        )
        await expect(newer).rejects.toThrow("Failed to retrieve file object")
        releasePut()
        await expect(older).rejects.toThrow("Relink was superseded")
        expect(store.getContentGeneration("book")).toBe(0)
    })

    it("does not retain a failed lock state after a relink invalidates access", async () => {
        const fileHandle = Object.assign(handle("book.pdf"), {
            queryPermission: vi.fn(async () => "denied"),
        })
        let resolvePut!: () => void
        const put = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    resolvePut = resolve
                }),
        )
        const failedHandle = Object.assign(handle("missing.pdf"), {
            getFile: vi.fn(async () => {
                throw new Error("replacement unavailable")
            }),
        })
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        ;(store as any).nativeHandles.set("book", fileHandle)
        store.db = { files: { put } } as never

        const access = store.getFileUrl("book")
        await Promise.resolve()
        const relinking = store.relinkFile("book", failedHandle)
        await expect(relinking).rejects.toThrow("Failed to retrieve file object")
        resolvePut()

        await expect(access).resolves.toBe("")
        expect(store.isLockedMap.book).not.toBe(true)
        expect((store.nodes.book as any).isLocked).toBeUndefined()
    })

    it("reports denied permission as an access failure, not superseded content", async () => {
        const fileHandle = Object.assign(handle("book.pdf"), {
            queryPermission: vi.fn(async () => "denied"),
            requestPermission: vi.fn(async () => "denied"),
        })
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                isLocked: true,
                metadata: { pageNumber: 1 },
            },
        })
        ;(store as any).nativeHandles.set("book", fileHandle)
        store.db = { files: { put: vi.fn(async () => undefined) } } as never

        await expect(store.restoreFileAccess("book")).rejects.toMatchObject({
            name: "Error",
            message: "Failed to restore file access",
        })
        expect(fileHandle.requestPermission).toHaveBeenCalledOnce()
    })

    it("persists a lock after a successful access URL is revoked and permission is later denied", async () => {
        const fileHandle = Object.assign(handle("book.pdf"), {
            queryPermission: vi
                .fn()
                .mockResolvedValueOnce("granted")
                .mockResolvedValueOnce("denied"),
            requestPermission: vi.fn(async () => "denied"),
        })
        const put = vi.fn(async () => undefined)
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                isLocked: true,
                metadata: { pageNumber: 1 },
            },
        })
        ;(store as any).nativeHandles.set("book", fileHandle)
        store.db = { files: { put } } as never
        vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:book")

        await expect(store.getFileUrl("book", true)).resolves.toBe("blob:book")
        expect(store.nodes.book).toMatchObject({ isLocked: false })
        expect(store.revokeFileUrl("book")).toBe(true)

        await expect(store.getFileUrl("book", true)).resolves.toBe("")
        expect(put).toHaveBeenLastCalledWith(expect.objectContaining({ isLocked: true }))
        expect(store.nodes.book).toMatchObject({ isLocked: true })
        expect(store.isLockedMap.book).toBe(true)
    })

    it("does not publish an unlocked node when access persistence fails", async () => {
        const fileHandle = Object.assign(handle("book.pdf"), {
            queryPermission: vi.fn(async () => "granted"),
        })
        const put = vi.fn(async () => {
            throw new Error("disk full")
        })
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                isLocked: true,
                metadata: { pageNumber: 1 },
            },
        })
        ;(store as any).nativeHandles.set("book", fileHandle)
        store.db = { files: { put } } as never
        vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:book")
        vi.spyOn(console, "error").mockImplementation(() => undefined)

        await expect(store.getFileUrl("book", true)).resolves.toBe("blob:book")
        expect(store.nodes.book).toMatchObject({ isLocked: true })
        expect(store.isLockedMap.book).not.toBe(false)
    })

    it("allows an escalated request to proceed past a pending non-escalated request", async () => {
        let resolveFirstQuery!: (status: PermissionState) => void
        const fileHandle = Object.assign(handle("book.pdf"), {
            queryPermission: vi
                .fn()
                .mockImplementationOnce(
                    () =>
                        new Promise<PermissionState>((resolve) => {
                            resolveFirstQuery = resolve
                        }),
                )
                .mockResolvedValue("prompt"),
            requestPermission: vi.fn(async () => "granted"),
        })
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        ;(store as any).nativeHandles.set("book", fileHandle)
        store.db = { files: { put: vi.fn(async () => undefined) } } as never
        vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:escalated")

        const normal = store.getFileUrl("book")
        await Promise.resolve()
        const escalated = store.getFileUrl("book", true)
        resolveFirstQuery("prompt")

        await expect(escalated).resolves.toBe("blob:escalated")
        await expect(normal).resolves.toBe("")
        expect(store.fileUrls.book).toBe("blob:escalated")
        expect(store.nodes.book).toMatchObject({ isLocked: false })
        expect(fileHandle.requestPermission).toHaveBeenCalledOnce()
    })

    it("does not hang disposal on an uncancellable permission prompt", async () => {
        let queryStarted!: () => void
        const queryReady = new Promise<void>((resolve) => (queryStarted = resolve))
        const fileHandle = Object.assign(handle("book.pdf"), {
            queryPermission: vi.fn(() => {
                queryStarted()
                return new Promise<PermissionState>(() => undefined)
            }),
        })
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        ;(store as any).nativeHandles.set("book", fileHandle)
        const close = vi.fn()
        store.db = { close } as never

        const access = store.getFileUrl("book")
        await queryReady
        await expect(store.dispose()).resolves.toBeUndefined()
        await expect(access).resolves.toBe("")
        expect(close).toHaveBeenCalledOnce()
    })

    it("does not publish URLs after disposal", async () => {
        let resolveFile!: (file: Blob) => void
        const fileHandle = Object.assign(handle("book.pdf"), {
            queryPermission: vi.fn(async () => "granted"),
            getFile: vi.fn(
                () =>
                    new Promise<Blob>((resolve) => {
                        resolveFile = resolve
                    }),
            ),
        })
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        ;(store as any).nativeHandles.set("book", fileHandle)
        ;(store as any).importSources.set("book", fileHandle)
        store.onNodeRelinked(() => undefined)
        store.db = { close: vi.fn(), files: { put: vi.fn(async () => undefined) } } as never
        const createObjectURL = vi.spyOn(URL, "createObjectURL")
        const pending = store.getFileUrl("book")
        await Promise.resolve()
        const disposing = store.dispose()
        resolveFile(new Blob(["pdf"]))
        await disposing

        await expect(pending).resolves.toBe("")
        expect(createObjectURL).not.toHaveBeenCalled()
        expect(store.fileUrls).toEqual({})
        expect((store as any).nativeHandles.size).toBe(0)
        expect((store as any).importSources.size).toBe(0)
        expect((store as any).nodeRelinkedListeners.size).toBe(0)
    })
})

describe("VFS preview ownership", () => {
    it("waits for relinking before reading a preview", async () => {
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        const getPreview = vi.fn(async () => ({ id: "book", data: new Blob(["preview"]) }))
        store.db = {
            files: { put: vi.fn(async () => undefined) },
            fileContents: { put: vi.fn(async () => undefined) },
            previews: {
                get: getPreview,
                delete: vi.fn(async () => undefined),
            },
            indexedTexts: { deleteByBookId: vi.fn(async () => undefined) },
            transaction: vi.fn(async (_mode, _tables, callback) => callback()),
        } as never
        vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview")

        const relinking = store.relinkFile("book", handle("new-book.pdf"))
        const preview = store.getPreviewUrl("book")

        await relinking
        await expect(preview).resolves.toBe("blob:preview")
        expect(getPreview).toHaveBeenCalledTimes(2)
    })

    it("deduplicates concurrent cache reads and retains the URL until the last release", async () => {
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        let resolvePreview!: (value: { id: string; data: Blob }) => void
        const get = vi.fn(
            () =>
                new Promise<{ id: string; data: Blob }>((resolve) => {
                    resolvePreview = resolve
                }),
        )
        store.db = { previews: { get } } as never
        const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview")
        const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)

        const first = store.getPreviewUrl("book")
        const second = store.getPreviewUrl("book")
        resolvePreview({ id: "book", data: new Blob(["preview"]) })

        await expect(Promise.all([first, second])).resolves.toEqual([
            "blob:preview",
            "blob:preview",
        ])
        expect(get).toHaveBeenCalledOnce()
        expect(createObjectURL).toHaveBeenCalledOnce()

        store.revokePreviewUrl("book")
        expect(revokeObjectURL).not.toHaveBeenCalled()
        store.revokePreviewUrl("book")
        expect(revokeObjectURL).toHaveBeenCalledWith("blob:preview")
    })

    it("waits for active preview invalidation before reusing a cached URL", async () => {
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        let releaseDelete!: () => void
        const deletePreview = vi.fn(() => new Promise<void>((resolve) => (releaseDelete = resolve)))
        const getPreview = vi.fn(async () => ({ id: "book", data: new Blob(["fresh"]) }))
        store.previewUrls.book = "blob:stale"
        store.db = { previews: { delete: deletePreview, get: getPreview } } as never
        const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)
        vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:fresh")

        const invalidation = store.invalidatePreview("book")
        await vi.waitFor(() => expect(deletePreview).toHaveBeenCalledOnce())
        const fresh = store.getPreviewUrl("book")
        await Promise.resolve()
        expect(getPreview).not.toHaveBeenCalled()

        releaseDelete()
        await invalidation
        await expect(fresh).resolves.toBe("blob:fresh")
        expect(revokeObjectURL).toHaveBeenCalledWith("blob:stale")
        expect(getPreview).toHaveBeenCalledOnce()
    })

    it("starts a fresh preview request after successful invalidation", async () => {
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        let resolveFirst!: (value: { id: string; data: Blob }) => void
        let resolveSecond!: (value: { id: string; data: Blob }) => void
        const get = vi
            .fn()
            .mockImplementationOnce(
                () =>
                    new Promise<{ id: string; data: Blob }>((resolve) => {
                        resolveFirst = resolve
                    }),
            )
            .mockImplementationOnce(
                () =>
                    new Promise<{ id: string; data: Blob }>((resolve) => {
                        resolveSecond = resolve
                    }),
            )
        store.db = {
            previews: {
                get,
                delete: vi.fn(async () => undefined),
            },
        } as never
        const createObjectURL = vi
            .spyOn(URL, "createObjectURL")
            .mockReturnValueOnce("blob:first")
            .mockReturnValueOnce("blob:second")

        const first = store.getPreviewUrl("book")
        await vi.waitFor(() => expect(get).toHaveBeenCalledOnce())
        await store.invalidatePreview("book")
        const second = store.getPreviewUrl("book")
        await vi.waitFor(() => expect(get).toHaveBeenCalledTimes(2))

        resolveFirst({ id: "book", data: new Blob(["first"]) })
        resolveSecond({ id: "book", data: new Blob(["second"]) })

        await expect(first).resolves.toBe("")
        await expect(second).resolves.toBe("blob:second")
        expect(createObjectURL).toHaveBeenCalledTimes(2)
    })

    it("does not publish preview state when disposal interrupts invalidation persistence", async () => {
        let releaseDelete!: () => void
        const deletePreview = vi.fn(() => new Promise<void>((resolve) => (releaseDelete = resolve)))
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        store.previewUrls.book = "blob:cached"
        store.db = { previews: { delete: deletePreview }, close: vi.fn() } as never
        const invalidated = vi.fn()
        store.onNodeInvalidated(invalidated)

        const invalidation = store.invalidatePreview("book")
        await vi.waitFor(() => expect(deletePreview).toHaveBeenCalledOnce())
        const disposing = store.dispose()
        releaseDelete()

        await expect(invalidation).rejects.toMatchObject({ name: "VFSDisposedError" })
        await disposing
        expect(store.previewUrls).toEqual({})
        expect(invalidated).not.toHaveBeenCalled()
    })

    it("rolls back preview invalidation when persistence fails", async () => {
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        store.previewUrls.book = "blob:cached"
        const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)
        store.db = {
            previews: {
                delete: vi.fn(async () => {
                    throw new Error("delete failed")
                }),
            },
        } as never

        await expect(store.invalidatePreview("book")).rejects.toThrow("delete failed")
        await expect(store.getPreviewUrl("book")).resolves.toBe("blob:cached")
        expect(store.previewUrls.book).toBe("blob:cached")
        expect(revokeObjectURL).not.toHaveBeenCalled()
    })

    it("reuses an in-flight preview request when invalidation rolls back", async () => {
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        let resolvePreview!: (value: { id: string; data: Blob }) => void
        const get = vi.fn(
            () =>
                new Promise<{ id: string; data: Blob }>((resolve) => {
                    resolvePreview = resolve
                }),
        )
        store.db = {
            previews: {
                get,
                delete: vi.fn(async () => {
                    throw new Error("delete failed")
                }),
            },
        } as never
        const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview")

        const first = store.getPreviewUrl("book")
        await vi.waitFor(() => expect(get).toHaveBeenCalledOnce())
        await expect(store.invalidatePreview("book")).rejects.toThrow("delete failed")
        resolvePreview({ id: "book", data: new Blob(["preview"]) })

        await expect(first).resolves.toBe("blob:preview")
        await expect(store.getPreviewUrl("book")).resolves.toBe("blob:preview")
        expect(get).toHaveBeenCalledOnce()
        expect(createObjectURL).toHaveBeenCalledOnce()
    })

    it("restores the exact preview state when concurrent invalidations both fail", async () => {
        let resolvePreview!: (value: { id: string; data: Blob }) => void
        const get = vi.fn(
            () =>
                new Promise<{ id: string; data: Blob }>((resolve) => {
                    resolvePreview = resolve
                }),
        )
        const deletePreview = vi.fn(async () => {
            throw new Error("delete failed")
        })
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        store.db = { previews: { get, delete: deletePreview } } as never
        vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:preview")

        const request = store.getPreviewUrl("book")
        await vi.waitFor(() => expect(get).toHaveBeenCalledOnce())
        const first = store.invalidatePreview("book")
        const second = store.invalidatePreview("book")
        await expect(first).rejects.toThrow("delete failed")
        await expect(second).rejects.toThrow("delete failed")
        resolvePreview({ id: "book", data: new Blob(["preview"]) })

        await expect(request).resolves.toBe("blob:preview")
        expect(deletePreview).toHaveBeenCalledTimes(2)
        expect((store as any).previewGenerations.get("book")).toBe(0)
        expect((store as any).previewRequestVersions.get("book")).toBe(0)
    })

    it("does not republish a preview request invalidated by a failed delete", async () => {
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        let resolveFirst!: (value: { id: string; data: Blob }) => void
        let resolveSecond!: (value: { id: string; data: Blob }) => void
        const get = vi
            .fn()
            .mockImplementationOnce(
                () =>
                    new Promise<{ id: string; data: Blob }>((resolve) => {
                        resolveFirst = resolve
                    }),
            )
            .mockImplementationOnce(
                () =>
                    new Promise<{ id: string; data: Blob }>((resolve) => {
                        resolveSecond = resolve
                    }),
            )
        const transaction = vi.fn(async () => {
            throw new Error("delete failed")
        })
        store.db = { previews: { get }, transaction } as never
        const createObjectURL = vi
            .spyOn(URL, "createObjectURL")
            .mockReturnValueOnce("blob:stale")
            .mockReturnValueOnce("blob:fresh")
        const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)

        const stalePreview = store.getPreviewUrl("book")
        await Promise.resolve()
        await expect(store.deleteNode("book")).rejects.toThrow("delete failed")
        resolveFirst({ id: "book", data: new Blob(["stale"]) })
        await expect(stalePreview).resolves.toBe("")
        store.revokePreviewUrl("book")

        const freshPreview = store.getPreviewUrl("book")
        resolveSecond({ id: "book", data: new Blob(["fresh"]) })
        await expect(freshPreview).resolves.toBe("blob:fresh")
        expect(createObjectURL).toHaveBeenCalledTimes(2)
        expect(revokeObjectURL).toHaveBeenCalledWith("blob:stale")

        store.revokePreviewUrl("book")
        expect(revokeObjectURL).toHaveBeenCalledWith("blob:fresh")
    })

    it("does not consume a temporary lease when releasing a viewer lease", async () => {
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        store.fileUrls.book = "blob:shared"
        ;(store as any).fileUrlOwnership.set("book", {
            url: "blob:shared",
            viewer: 1,
            temporary: 1,
        })
        const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)

        expect(store.revokeFileUrl("book", "blob:shared")).toBe(true)

        expect(revokeObjectURL).not.toHaveBeenCalled()
        expect((store as any).fileUrlOwnership.get("book")).toMatchObject({
            viewer: 0,
            temporary: 1,
        })
    })

    it("releases temporary access without revoking a viewer-owned file URL", async () => {
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        ;(store as any).nativeFiles.set("book", new Blob(["pdf"]))
        store.db = { files: { put: vi.fn(async () => undefined) } } as never
        const createObjectURL = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:file")
        const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)

        await expect(store.getFileUrl("book")).resolves.toBe("blob:file")
        await expect(store.getFileUrl("book", false, "temporary")).resolves.toBe("blob:file")
        store.releaseTemporaryFileUrl("book", "blob:file")

        expect(createObjectURL).toHaveBeenCalledOnce()
        expect(revokeObjectURL).not.toHaveBeenCalled()
        store.revokeFileUrl("book")
        expect(revokeObjectURL).toHaveBeenCalledWith("blob:file")
    })

    it("releases a temporary-only cached URL after its consumer finishes", async () => {
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        store.fileUrls.book = "blob:cached"
        const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)

        await expect(store.getFileUrl("book", false, "temporary")).resolves.toBe("blob:cached")
        store.releaseTemporaryFileUrl("book", "blob:cached")

        expect(revokeObjectURL).toHaveBeenCalledWith("blob:cached")
        expect(store.fileUrls.book).toBeUndefined()
    })

    it("revokes a temporary URL once its task releases the only ownership", async () => {
        const store = new VFSStore({
            book: {
                id: "book",
                name: "book.pdf",
                type: "file",
                parentId: null,
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
            },
        })
        ;(store as any).nativeFiles.set("book", new Blob(["pdf"]))
        store.db = { files: { put: vi.fn(async () => undefined) } } as never
        vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:temporary")
        const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)

        await expect(store.getFileUrl("book", false, "temporary")).resolves.toBe("blob:temporary")
        store.releaseTemporaryFileUrl("book", "blob:temporary")

        expect(revokeObjectURL).toHaveBeenCalledWith("blob:temporary")
        expect(store.fileUrls.book).toBeUndefined()
    })

    it("revokes a URL created after its only consumer releases", async () => {
        const store = new VFSStore()
        let resolvePreview!: (value: { id: string; data: Blob }) => void
        store.db = {
            previews: {
                get: () =>
                    new Promise<{ id: string; data: Blob }>((resolve) => {
                        resolvePreview = resolve
                    }),
            },
        } as never
        vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:late")
        const revokeObjectURL = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined)

        const pending = store.getPreviewUrl("book")
        store.revokePreviewUrl("book")
        resolvePreview({ id: "book", data: new Blob(["preview"]) })

        await expect(pending).resolves.toBe("")
        expect(revokeObjectURL).toHaveBeenCalledWith("blob:late")
        expect(store.previewUrls.book).toBeUndefined()
    })
})

describe("folder names", () => {
    const folders = {
        parent: {
            id: "parent",
            name: "Parent",
            type: "folder" as const,
            parentId: null,
            childrenIds: ["folder", "sibling"],
            createdAt: 1,
            updatedAt: 1,
            isPinned: false,
        },
        folder: {
            id: "folder",
            name: "Old name",
            type: "folder" as const,
            parentId: "parent",
            childrenIds: ["book"],
            createdAt: 2,
            updatedAt: 2,
            isPinned: false,
        },
        sibling: {
            id: "sibling",
            name: "Taken",
            type: "folder" as const,
            parentId: "parent",
            childrenIds: [],
            createdAt: 3,
            updatedAt: 3,
            isPinned: false,
        },
    }

    it("creates folders as explicitly unpinned", async () => {
        const store = new VFSStore()
        const put = vi.fn(async () => "folder")
        store.db = {
            folders: { put },
            transaction: vi.fn(async (_mode, _tables, callback) => callback()),
        } as never

        const id = await store.createFolder("New folder", null)

        expect(put).toHaveBeenCalledWith(expect.objectContaining({ id, isPinned: false }))
        expect(store.nodes[id].isPinned).toBe(false)
    })

    it("merges child additions from stale store snapshots", async () => {
        const records = new Map<string, any>([
            [
                "parent",
                {
                    id: "parent",
                    name: "Parent",
                    type: "folder",
                    parentId: null,
                    childrenIds: [],
                    createdAt: 1,
                    updatedAt: 1,
                    isPinned: false,
                },
            ],
        ])
        const db = {
            folders: {
                get: vi.fn(async (id: string) => structuredClone(records.get(id))),
                put: vi.fn(async (folder: any) => {
                    records.set(folder.id, structuredClone(folder))
                    return folder.id
                }),
            },
            transaction: vi.fn(async (_mode: unknown, _tables: unknown, callback: () => unknown) =>
                callback(),
            ),
        }
        const initial = structuredClone(records.get("parent"))
        const first = new VFSStore({ parent: initial })
        const second = new VFSStore({ parent: structuredClone(initial) })
        first.db = db as never
        second.db = db as never

        const firstId = await first.createFolder("First", "parent")
        const secondId = await second.createFolder("Second", "parent")

        expect(records.get("parent").childrenIds).toEqual([firstId, secondId])
    })

    it("merges stale-parent move and delete operations", async () => {
        const initial = {
            parent: {
                id: "parent",
                name: "Parent",
                type: "folder" as const,
                parentId: null,
                childrenIds: ["moved"],
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
            },
            target: {
                id: "target",
                name: "Target",
                type: "folder" as const,
                parentId: null,
                childrenIds: [],
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
            },
            moved: {
                id: "moved",
                name: "Moved",
                type: "folder" as const,
                parentId: "parent",
                childrenIds: [],
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
            },
        }
        const records = new Map(Object.entries(structuredClone(initial)))
        const db = {
            folders: {
                get: vi.fn(async (id: string) => structuredClone(records.get(id))),
                put: vi.fn(async (folder: any) => {
                    records.set(folder.id, structuredClone(folder))
                    return folder.id
                }),
                bulkDelete: vi.fn(async (ids: string[]) => ids.forEach((id) => records.delete(id))),
            },
            transaction: vi.fn(async (_mode: unknown, _tables: unknown, callback: () => unknown) =>
                callback(),
            ),
        }
        const first = new VFSStore(structuredClone(initial))
        const second = new VFSStore(structuredClone(initial))
        first.db = db as never
        second.db = db as never

        const siblingId = await second.createFolder("Sibling", "parent")
        await first.moveNode("moved", "target")
        expect(records.get("parent")?.childrenIds).toEqual([siblingId])
        expect(records.get("target")?.childrenIds).toEqual(["moved"])

        await first.deleteNode("moved")
        expect(records.get("target")?.childrenIds).toEqual([])
    })

    it("removes a directly deleted file from its current persisted parent", async () => {
        const initial = {
            file: {
                id: "file",
                name: "File.pdf",
                type: "file" as const,
                parentId: "old-parent",
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
                isLocked: false,
            },
            "old-parent": {
                id: "old-parent",
                name: "Old parent",
                type: "folder" as const,
                parentId: null,
                childrenIds: ["file"],
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
            },
            "new-parent": {
                id: "new-parent",
                name: "New parent",
                type: "folder" as const,
                parentId: null,
                childrenIds: [],
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
            },
        }
        const records = new Map<string, any>(Object.entries(structuredClone(initial)))
        const db = {
            files: {
                get: vi.fn(async (id: string) => structuredClone(records.get(id))),
                put: vi.fn(async (file: any) => records.set(file.id, structuredClone(file))),
                bulkDelete: vi.fn(async (ids: string[]) => ids.forEach((id) => records.delete(id))),
            },
            folders: {
                get: vi.fn(async (id: string) => structuredClone(records.get(id))),
                put: vi.fn(async (folder: any) => records.set(folder.id, structuredClone(folder))),
            },
            previews: { bulkDelete: vi.fn(async () => undefined) },
            fileContents: { bulkDelete: vi.fn(async () => undefined) },
            indexedTexts: { deleteByBookId: vi.fn(async () => undefined) },
            userNotes: { deleteByBookId: vi.fn(async () => undefined) },
            bookmarks: { deleteByBookId: vi.fn(async () => undefined) },
            transaction: vi.fn(async (_mode: unknown, _tables: unknown, callback: () => unknown) =>
                callback(),
            ),
        }
        const first = new VFSStore(structuredClone(initial))
        const second = new VFSStore(structuredClone(initial))
        first.db = db as never
        second.db = db as never

        await second.moveNode("file", "new-parent")
        await first.deleteNode("file")

        expect(records.has("file")).toBe(false)
        expect(records.get("old-parent")?.childrenIds).toEqual([])
        expect(records.get("new-parent")?.childrenIds).toEqual([])
        expect(first.nodes["old-parent"]).toMatchObject({ childrenIds: [] })
        expect(first.nodes["new-parent"]).toMatchObject({ childrenIds: [] })
    })

    it("preserves concurrent child additions while renaming a folder", async () => {
        const initial = {
            folder: {
                id: "folder",
                name: "Old name",
                type: "folder" as const,
                parentId: null,
                childrenIds: [],
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
            },
        }
        const records = new Map(Object.entries(structuredClone(initial)))
        const db = {
            folders: {
                get: vi.fn(async (id: string) => structuredClone(records.get(id))),
                put: vi.fn(async (folder: any) => {
                    records.set(folder.id, structuredClone(folder))
                    return folder.id
                }),
            },
            transaction: vi.fn(async (_mode: unknown, _tables: unknown, callback: () => unknown) =>
                callback(),
            ),
        }
        const first = new VFSStore(structuredClone(initial))
        const second = new VFSStore(structuredClone(initial))
        first.db = db as never
        second.db = db as never

        const childId = await second.createFolder("Child", "folder")
        await first.renameFolder("folder", "Renamed")

        expect(records.get("folder")).toMatchObject({ name: "Renamed", childrenIds: [childId] })
    })

    it("preserves persisted children when updateNode omits childrenIds", async () => {
        const folder = {
            id: "folder",
            name: "Old name",
            type: "folder" as const,
            parentId: null,
            childrenIds: ["new-child"],
            createdAt: 1,
            updatedAt: 1,
            isPinned: false,
        }
        const records = new Map([["folder", structuredClone(folder)]])
        const db = {
            folders: {
                get: vi.fn(async (id: string) => structuredClone(records.get(id))),
                put: vi.fn(async (value: any) => {
                    records.set(value.id, structuredClone(value))
                }),
            },
            transaction: vi.fn(async (_mode: unknown, _tables: unknown, callback: () => unknown) =>
                callback(),
            ),
        }
        const store = new VFSStore({
            folder: { ...folder, childrenIds: [] },
        })
        store.db = db as never

        await store.updateNode("folder", { name: "Renamed" })

        expect(records.get("folder")).toMatchObject({
            name: "Renamed",
            childrenIds: ["new-child"],
        })
    })

    it("replaces persisted children when updateNode explicitly supplies childrenIds", async () => {
        const folder = {
            id: "folder",
            name: "Folder",
            type: "folder" as const,
            parentId: null,
            childrenIds: ["first", "second"],
            createdAt: 1,
            updatedAt: 1,
            isPinned: false,
        }
        const records = new Map([["folder", structuredClone(folder)]])
        const db = {
            folders: {
                get: vi.fn(async (id: string) => structuredClone(records.get(id))),
                put: vi.fn(async (value: any) => {
                    records.set(value.id, structuredClone(value))
                }),
            },
            transaction: vi.fn(async (_mode: unknown, _tables: unknown, callback: () => unknown) =>
                callback(),
            ),
        }
        const store = new VFSStore(structuredClone({ folder }))
        store.db = db as never

        await store.updateNode("folder", { childrenIds: ["replacement", "replacement"] })
        expect(records.get("folder")?.childrenIds).toEqual(["replacement"])

        await store.updateNode("folder", { childrenIds: [] })
        expect(records.get("folder")?.childrenIds).toEqual([])
    })

    it("deletes persisted descendants added after a stale folder snapshot", async () => {
        const initial = {
            folder: {
                id: "folder",
                name: "Folder",
                type: "folder" as const,
                parentId: null,
                childrenIds: [],
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
            },
        }
        const records = new Map(Object.entries(structuredClone(initial)))
        const db = {
            folders: {
                get: vi.fn(async (id: string) => structuredClone(records.get(id))),
                put: vi.fn(async (folder: any) => {
                    records.set(folder.id, structuredClone(folder))
                    return folder.id
                }),
                bulkDelete: vi.fn(async (ids: string[]) =>
                    ids.forEach((childId) => records.delete(childId)),
                ),
            },
            transaction: vi.fn(async (_mode: unknown, _tables: unknown, callback: () => unknown) =>
                callback(),
            ),
        }
        const first = new VFSStore(structuredClone(initial))
        const second = new VFSStore(structuredClone(initial))
        first.db = db as never
        second.db = db as never

        const childId = await second.createFolder("Child", "folder")
        await first.deleteNode("folder")

        expect(records.has("folder")).toBe(false)
        expect(records.has(childId)).toBe(false)
    })

    it("does not leave a moved-away file marked as deleting", async () => {
        const initial = {
            folder: {
                id: "folder",
                name: "Folder",
                type: "folder" as const,
                parentId: null,
                childrenIds: ["file"],
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
            },
            target: {
                id: "target",
                name: "Target",
                type: "folder" as const,
                parentId: null,
                childrenIds: [],
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
            },
            file: {
                id: "file",
                name: "File.pdf",
                type: "file" as const,
                parentId: "folder",
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
                isLocked: false,
            },
        }
        const records = new Map(Object.entries(structuredClone(initial)))
        const db = {
            folders: {
                get: vi.fn(async (id: string) => structuredClone(records.get(id))),
                put: vi.fn(async (folder: any) => records.set(folder.id, structuredClone(folder))),
                bulkDelete: vi.fn(async (ids: string[]) => ids.forEach((id) => records.delete(id))),
            },
            files: {
                get: vi.fn(async (id: string) => structuredClone(records.get(id))),
                put: vi.fn(async (file: any) => records.set(file.id, structuredClone(file))),
                bulkDelete: vi.fn(async (ids: string[]) => ids.forEach((id) => records.delete(id))),
            },
            previews: { bulkDelete: vi.fn(async () => undefined) },
            fileContents: { bulkDelete: vi.fn(async () => undefined) },
            indexedTexts: { deleteByBookId: vi.fn(async () => undefined) },
            userNotes: { deleteByBookId: vi.fn(async () => undefined) },
            bookmarks: { deleteByBookId: vi.fn(async () => undefined) },
            transaction: vi.fn(async (_mode: unknown, _tables: unknown, callback: () => unknown) =>
                callback(),
            ),
        }
        const first = new VFSStore(structuredClone(initial))
        const second = new VFSStore(structuredClone(initial))
        first.db = db as never
        second.db = db as never

        await second.moveNode("file", "target")
        await first.deleteNode("folder")

        expect(records.has("file")).toBe(true)
        expect((first as any).deletingFileIds.has("file")).toBe(false)
    })

    it("moves a stale file from its current persisted parent", async () => {
        const initial = {
            file: {
                id: "file",
                name: "File.pdf",
                type: "file" as const,
                parentId: "first-parent",
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
                isLocked: false,
            },
            "first-parent": {
                id: "first-parent",
                name: "First",
                type: "folder" as const,
                parentId: null,
                childrenIds: ["file"],
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
            },
            "second-parent": {
                id: "second-parent",
                name: "Second",
                type: "folder" as const,
                parentId: null,
                childrenIds: [],
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
            },
            target: {
                id: "target",
                name: "Target",
                type: "folder" as const,
                parentId: null,
                childrenIds: [],
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
            },
        }
        const records = new Map<string, any>(Object.entries(structuredClone(initial)))
        const db = {
            files: {
                get: vi.fn(async (id: string) => structuredClone(records.get(id))),
                put: vi.fn(async (file: any) => records.set(file.id, structuredClone(file))),
            },
            folders: {
                get: vi.fn(async (id: string) => structuredClone(records.get(id))),
                put: vi.fn(async (folder: any) => records.set(folder.id, structuredClone(folder))),
            },
            transaction: vi.fn(async (_mode: unknown, _tables: unknown, callback: () => unknown) =>
                callback(),
            ),
        }
        const first = new VFSStore(structuredClone(initial))
        const second = new VFSStore(structuredClone(initial))
        first.db = db as never
        second.db = db as never

        await second.moveNode("file", "second-parent")
        await first.moveNode("file", "target")

        expect(records.get("file")?.parentId).toBe("target")
        expect(records.get("first-parent")?.childrenIds).toEqual([])
        expect(records.get("second-parent")?.childrenIds).toEqual([])
        expect(records.get("target")?.childrenIds).toEqual(["file"])
        expect((first as any).nodes["first-parent"].childrenIds).toEqual([])
        expect((first as any).nodes["target"].childrenIds).toEqual(["file"])
    })

    it("refreshes local membership when a persisted move is already at its destination", async () => {
        const initial = {
            file: {
                id: "file",
                name: "File.pdf",
                type: "file" as const,
                parentId: "first-parent",
                size: 1,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 1 },
                isLocked: false,
            },
            "first-parent": {
                id: "first-parent",
                name: "First",
                type: "folder" as const,
                parentId: null,
                childrenIds: ["file"],
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
            },
            target: {
                id: "target",
                name: "Target",
                type: "folder" as const,
                parentId: null,
                childrenIds: [],
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
            },
        }
        const records = new Map<string, any>(Object.entries(structuredClone(initial)))
        const db = {
            files: {
                get: vi.fn(async (id: string) => structuredClone(records.get(id))),
                put: vi.fn(async (file: any) => records.set(file.id, structuredClone(file))),
            },
            folders: {
                get: vi.fn(async (id: string) => structuredClone(records.get(id))),
                put: vi.fn(async (folder: any) => records.set(folder.id, structuredClone(folder))),
            },
            transaction: vi.fn(async (_mode: unknown, _tables: unknown, callback: () => unknown) =>
                callback(),
            ),
        }
        const first = new VFSStore(structuredClone(initial))
        const second = new VFSStore(structuredClone(initial))
        first.db = db as never
        second.db = db as never

        await second.moveNode("file", "target")
        await first.moveNode("file", "target")

        expect(records.get("target")?.childrenIds).toEqual(["file"])
        expect(records.get("first-parent")?.childrenIds).toEqual([])
        expect(first.nodes["first-parent"]).toMatchObject({ childrenIds: [] })
        expect(first.nodes.target).toMatchObject({ childrenIds: ["file"] })
        expect(first.currentFolderId).toBeNull()
    })

    it("reconciles local parent membership when rename and update publish remote moves", async () => {
        const initial = {
            folder: {
                id: "folder",
                name: "Folder",
                type: "folder" as const,
                parentId: null,
                childrenIds: [],
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
            },
            target: {
                id: "target",
                name: "Target",
                type: "folder" as const,
                parentId: null,
                childrenIds: [],
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
            },
        }
        const records = new Map<string, any>(Object.entries(structuredClone(initial)))
        const db = {
            folders: {
                get: vi.fn(async (id: string) => structuredClone(records.get(id))),
                put: vi.fn(async (folder: any) => records.set(folder.id, structuredClone(folder))),
            },
            transaction: vi.fn(async (_mode: unknown, _tables: unknown, callback: () => unknown) =>
                callback(),
            ),
        }
        const first = new VFSStore(structuredClone(initial))
        const second = new VFSStore(structuredClone(initial))
        first.db = db as never
        second.db = db as never

        await second.moveNode("folder", "target")
        await first.renameFolder("folder", "Renamed")
        expect(first.rootIds).toEqual(["target"])
        expect(first.nodes.target).toMatchObject({ childrenIds: ["folder"] })

        await second.moveNode("folder", null)
        await first.updateNode("folder", { name: "Updated" })
        expect(first.nodes.folder).toMatchObject({ name: "Updated", parentId: null })
        expect(first.rootIds).toContain("folder")
        expect(first.nodes.target).toMatchObject({ childrenIds: [] })
    })

    it("does not resurrect a remotely deleted folder during move or update", async () => {
        const initial = {
            folder: {
                id: "folder",
                name: "Folder",
                type: "folder" as const,
                parentId: null,
                childrenIds: [],
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
            },
            target: {
                id: "target",
                name: "Target",
                type: "folder" as const,
                parentId: null,
                childrenIds: [],
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
            },
        }
        const put = vi.fn()
        const store = new VFSStore(structuredClone(initial))
        store.db = {
            folders: {
                get: vi.fn(async (id: string) => (id === "target" ? initial.target : undefined)),
                put,
            },
            transaction: vi.fn(async (_mode: unknown, _tables: unknown, callback: () => unknown) =>
                callback(),
            ),
        } as never

        await store.moveNode("folder", "target")
        await store.updateNode("folder", { name: "Updated" })

        expect(put).not.toHaveBeenCalled()
        expect(store.nodes.folder).toMatchObject({ name: "Folder", parentId: null })
    })

    it("does not delete a child moved away from a stale folder snapshot", async () => {
        const initial = {
            folder: {
                id: "folder",
                name: "Folder",
                type: "folder" as const,
                parentId: "old-parent",
                childrenIds: ["child"],
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
            },
            "old-parent": {
                id: "old-parent",
                name: "Old parent",
                type: "folder" as const,
                parentId: null,
                childrenIds: ["folder"],
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
            },
            target: {
                id: "target",
                name: "Target",
                type: "folder" as const,
                parentId: null,
                childrenIds: [],
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
            },
            child: {
                id: "child",
                name: "Child",
                type: "folder" as const,
                parentId: "folder",
                childrenIds: [],
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
            },
        }
        const records = new Map(Object.entries(structuredClone(initial)))
        const db = {
            folders: {
                get: vi.fn(async (id: string) => structuredClone(records.get(id))),
                put: vi.fn(async (folder: any) => records.set(folder.id, structuredClone(folder))),
                bulkDelete: vi.fn(async (ids: string[]) => ids.forEach((id) => records.delete(id))),
            },
            transaction: vi.fn(async (_mode: unknown, _tables: unknown, callback: () => unknown) =>
                callback(),
            ),
        }
        const first = new VFSStore(structuredClone(initial))
        const second = new VFSStore(structuredClone(initial))
        first.db = db as never
        second.db = db as never

        await second.moveNode("child", "target")
        await first.deleteNode("folder")

        expect(records.has("folder")).toBe(false)
        expect(records.has("child")).toBe(true)
        expect(records.get("target")?.childrenIds).toEqual(["child"])
        expect(first.nodes.child).toMatchObject({ parentId: "target" })
        expect(first.nodes.target).toMatchObject({ childrenIds: ["child"] })
        first.currentFolderId = "target"
        expect(first.currentNodes.map((node) => node.id)).toEqual(["child"])
    })

    it("removes a deleted folder from its current persisted parent", async () => {
        const initial = {
            folder: {
                id: "folder",
                name: "Folder",
                type: "folder" as const,
                parentId: "old-parent",
                childrenIds: [],
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
            },
            "old-parent": {
                id: "old-parent",
                name: "Old parent",
                type: "folder" as const,
                parentId: null,
                childrenIds: ["folder"],
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
            },
            "new-parent": {
                id: "new-parent",
                name: "New parent",
                type: "folder" as const,
                parentId: null,
                childrenIds: [],
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
            },
        }
        const records = new Map(Object.entries(structuredClone(initial)))
        const db = {
            folders: {
                get: vi.fn(async (id: string) => structuredClone(records.get(id))),
                put: vi.fn(async (folder: any) => records.set(folder.id, structuredClone(folder))),
                bulkDelete: vi.fn(async (ids: string[]) => ids.forEach((id) => records.delete(id))),
            },
            transaction: vi.fn(async (_mode: unknown, _tables: unknown, callback: () => unknown) =>
                callback(),
            ),
        }
        const first = new VFSStore(structuredClone(initial))
        const second = new VFSStore(structuredClone(initial))
        first.db = db as never
        second.db = db as never

        await second.moveNode("folder", "new-parent")
        await first.deleteNode("folder")

        expect(records.get("old-parent")?.childrenIds).toEqual([])
        expect(records.get("new-parent")?.childrenIds).toEqual([])
    })

    it("rejects a rename duplicate in the folder's current persisted parent", async () => {
        const initial = {
            folder: {
                id: "folder",
                name: "Folder",
                type: "folder" as const,
                parentId: "old-parent",
                childrenIds: [],
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
            },
            "old-parent": {
                id: "old-parent",
                name: "Old parent",
                type: "folder" as const,
                parentId: null,
                childrenIds: ["folder"],
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
            },
            target: {
                id: "target",
                name: "Target",
                type: "folder" as const,
                parentId: null,
                childrenIds: ["sibling"],
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
            },
            sibling: {
                id: "sibling",
                name: "Taken",
                type: "folder" as const,
                parentId: "target",
                childrenIds: [],
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
            },
        }
        const records = new Map(Object.entries(structuredClone(initial)))
        const db = {
            folders: {
                get: vi.fn(async (id: string) => structuredClone(records.get(id))),
                getAll: vi.fn(async () => structuredClone([...records.values()])),
                put: vi.fn(async (folder: any) => records.set(folder.id, structuredClone(folder))),
            },
            transaction: vi.fn(async (_mode: unknown, _tables: unknown, callback: () => unknown) =>
                callback(),
            ),
        }
        const first = new VFSStore(structuredClone(initial))
        const second = new VFSStore(structuredClone(initial))
        first.db = db as never
        second.db = db as never

        await second.moveNode("folder", "target")
        await expect(first.renameFolder("folder", "Taken")).rejects.toThrow()
        expect(records.get("folder")?.name).toBe("Folder")
    })

    it("does not resurrect a folder deleted by another store", async () => {
        const store = new VFSStore(structuredClone(folders))
        const get = vi.fn(async () => undefined)
        const put = vi.fn()
        store.db = {
            folders: { get, put },
            transaction: vi.fn(async (_mode: unknown, _tables: unknown, callback: () => unknown) =>
                callback(),
            ),
        } as never

        await store.renameFolder("folder", "New name")

        expect(get).toHaveBeenCalledWith("folder")
        expect(put).not.toHaveBeenCalled()
        expect(store.nodes.folder.name).toBe("Old name")
    })

    it("persists before atomically publishing a normalized rename", async () => {
        const store = new VFSStore(structuredClone(folders))
        const put = vi.fn(async () => "folder")
        store.db = { folders: { put } } as never

        await store.renameFolder("folder", "  New name  ")

        expect(put).toHaveBeenCalledWith(expect.objectContaining({ name: "New name" }))
        expect(store.nodes.folder).toMatchObject({
            id: "folder",
            name: "New name",
            parentId: "parent",
            childrenIds: ["book"],
            createdAt: 2,
        })
    })

    it.each(["   ", "a/b", "taken", "TAKEN"])("rejects invalid name %j", async (name) => {
        const store = new VFSStore(structuredClone(folders))
        store.db = { folders: { put: vi.fn() } } as never
        await expect(store.renameFolder("folder", name)).rejects.toThrow()
        expect(store.nodes.folder.name).toBe("Old name")
    })

    it("does not write an unchanged normalized name", async () => {
        const store = new VFSStore(structuredClone(folders))
        const put = vi.fn()
        store.db = { folders: { put } } as never
        await store.renameFolder("folder", "Old name")
        expect(put).not.toHaveBeenCalled()
        expect(store.nodes.folder.updatedAt).toBe(2)
    })

    it("keeps memory unchanged when persistence fails", async () => {
        const store = new VFSStore(structuredClone(folders))
        store.db = {
            folders: {
                put: vi.fn(async () => {
                    throw new Error("disk full")
                }),
            },
        } as never
        await expect(store.renameFolder("folder", "New name")).rejects.toThrow("disk full")
        expect(store.nodes.folder.name).toBe("Old name")
    })

    it("serializes a delayed parent pin with a concurrent child move", async () => {
        const store = new VFSStore(structuredClone(folders))
        let resolvePin!: () => void
        const update = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    resolvePin = resolve
                }),
        )
        const put = vi.fn(async () => "folder")
        const transaction = vi.fn(async (_mode, _tables, callback) => callback())
        store.db = { folders: { update, put }, transaction } as never

        const pin = store.setNodePinned("parent", true)
        const move = store.moveNode("folder", null)

        expect(update).toHaveBeenCalledWith("parent", { isPinned: true })
        expect(transaction).not.toHaveBeenCalled()
        resolvePin()
        await Promise.all([pin, move])

        expect(store.nodes.parent).toMatchObject({ isPinned: true, childrenIds: ["sibling"] })
        expect(put).toHaveBeenCalledWith(
            expect.objectContaining({ id: "parent", isPinned: true, childrenIds: ["sibling"] }),
        )
    })
})

describe("VFS import registration", () => {
    it("joins concurrent dispose calls to one completion promise", async () => {
        const store = new VFSStore()
        const close = vi.fn()
        store.db = { close } as never

        const first = store.dispose()
        const second = store.dispose()

        expect(second).toBe(first)
        await first
        expect(close).toHaveBeenCalledOnce()
    })

    it("does not wait for queued initialization or imports during disposal", async () => {
        const store = new VFSStore()
        let releaseBlocker!: () => void
        const blocker = (store as any).serializeNodeMutation(
            () => new Promise<void>((resolve) => (releaseBlocker = resolve)),
        )
        store.db = {
            folders: { getAll: vi.fn(async () => []) },
            files: { getAll: vi.fn(async () => []) },
            close: vi.fn(),
        } as never

        const initializing = store.init()
        const importing = store.importFiles(
            [{ name: "queued.pdf", source: handle("queued.pdf") }],
            null,
        )
        const disposing = store.dispose()
        await Promise.all([initializing, importing, disposing])

        await expect(importing).resolves.toMatchObject([{ status: "failed" }])
        expect(store.initialized).toBe(false)
        releaseBlocker()
        await blocker
    })

    it("does not deadlock when onImported awaits disposal", async () => {
        const close = vi.fn()
        const store = new VFSStore()
        store.db = {
            files: { put: vi.fn(async () => undefined) },
            fileContents: { put: vi.fn(async () => undefined) },
            transaction: vi.fn(async (_mode: unknown, _tables: unknown, callback: () => unknown) =>
                callback(),
            ),
            close,
        } as never
        let callbackStarted = false

        const completion = store.importFiles(
            [{ name: "callback.pdf", source: handle("callback.pdf") }],
            null,
            {
                onImported: async () => {
                    callbackStarted = true
                    await store.dispose()
                },
            },
        )

        await vi.waitFor(() => expect(callbackStarted).toBe(true))
        await expect(completion).resolves.toMatchObject([{ status: "failed" }])
        expect(close).toHaveBeenCalledOnce()
    })

    it("short-circuits a queued import after disposal", async () => {
        let sourceStarted!: () => void
        let resolveFile!: (file: File) => void
        const sourceReady = new Promise<void>((resolve) => (sourceStarted = resolve))
        const fileReady = new Promise<File>((resolve) => (resolveFile = resolve))
        const source = handle("overlap.pdf")
        source.getFile = vi.fn(async () => {
            sourceStarted()
            return fileReady
        })
        const transaction = vi.fn(
            async (_mode: unknown, _tables: unknown, callback: () => unknown) => callback(),
        )
        const close = vi.fn()
        const store = new VFSStore()
        store.db = { transaction, close } as never

        const completion = store.importFiles([{ name: "overlap.pdf", source }], null)
        await sourceReady
        const disposing = store.dispose()
        resolveFile(new Blob(["pdf"], { type: "application/pdf" }) as File)
        const [results] = await Promise.all([completion, disposing])

        expect(results).toMatchObject([{ name: "overlap.pdf", status: "failed" }])
        expect(transaction).not.toHaveBeenCalled()
        expect(store.nodes).toEqual({})
        expect(store.importJobs[0]).toMatchObject({ stage: "saving" })
        expect(close).toHaveBeenCalledOnce()
    })

    it("does not publish an import after disposal during persistence", async () => {
        let releaseFilesPut!: () => void
        const filesPutReady = new Promise<void>((resolve) => (releaseFilesPut = resolve))
        const filesPut = vi.fn(async () => {
            await filesPutReady
        })
        const fileContentsPut = vi.fn(async () => undefined)
        const transaction = vi.fn(
            async (_mode: unknown, _tables: unknown, callback: () => unknown) => callback(),
        )
        const close = vi.fn()
        const store = new VFSStore()
        store.db = {
            files: { put: filesPut },
            fileContents: { put: fileContentsPut },
            transaction,
            close,
        } as never

        const completion = store.importFiles(
            [{ name: "overlap.pdf", source: handle("overlap.pdf") }],
            null,
        )
        await vi.waitFor(() => expect(filesPut).toHaveBeenCalledOnce())
        const disposing = store.dispose()
        releaseFilesPut()
        const [results] = await Promise.all([completion, disposing])

        expect(results).toMatchObject([{ status: "failed" }])
        expect(fileContentsPut).not.toHaveBeenCalled()
        expect(store.nodes).toEqual({})
        expect(close).toHaveBeenCalledOnce()
    })

    it("cleans a committed import on disposal and retains completed imports on reopen", async () => {
        const records = new Map<string, any>()
        const contents = new Map<string, any>()
        const store = new VFSStore()
        const job = {
            id: "committed",
            name: "committed.pdf",
            parentId: null,
            stage: "queued" as const,
        }
        ;(store as any).importSources.set(job.id, handle(job.name))
        store.importJobs = [job]
        store.db = {
            files: {
                put: vi.fn(async (value: any) => {
                    records.set(value.id, structuredClone(value))
                    return value.id
                }),
                get: vi.fn(async (id: string) => records.get(id)),
                getAll: vi.fn(async () => [...records.values()]),
                delete: vi.fn(async (id: string) => records.delete(id)),
            },
            fileContents: {
                put: vi.fn(async (value: any) => {
                    contents.set(value.id, value)
                    return value.id
                }),
                delete: vi.fn(async (id: string) => contents.delete(id)),
            },
            folders: { getAll: vi.fn(async () => []), get: vi.fn(), put: vi.fn() },
            previews: { delete: vi.fn() },
            indexedTexts: { deleteByBookId: vi.fn() },
            userNotes: { deleteByBookId: vi.fn() },
            bookmarks: { deleteByBookId: vi.fn() },
            transaction: vi.fn(async (_mode: unknown, _tables: unknown, callback: () => unknown) =>
                callback(),
            ),
            close: vi.fn(),
        } as never

        const [completed] = await store.importFiles(
            [{ name: "completed.pdf", source: handle("completed.pdf") }],
            null,
        )
        expect(completed.status).toBe("imported")
        const persisted = await (store as any).persistImport(job, {})
        expect(persisted).toEqual(expect.objectContaining({ content: 0 }))
        expect(records.has(job.id)).toBe(true)
        await store.dispose()
        expect(records.has(job.id)).toBe(false)
        expect(records.has(completed.id)).toBe(true)

        const reopened = new VFSStore()
        reopened.db = {
            folders: { getAll: vi.fn(async () => []) },
            files: { getAll: vi.fn(async () => [...records.values()]) },
        } as never
        await reopened.init()
        expect(reopened.nodes[job.id]).toBeUndefined()
        expect(reopened.nodes[completed.id]).toMatchObject({ metadata: { totalPages: 2 } })
    })

    it("stops after bounded marker failure without claiming durable cleanup", async () => {
        vi.useFakeTimers()
        const markerFailure = new Error("IndexedDB unavailable")
        const store = new VFSStore()
        const mark = vi
            .spyOn(store as any, "markResourceCleanupPending")
            .mockRejectedValue(markerFailure)
        vi.stubGlobal("localStorage", {
            setItem: vi.fn(() => {
                throw new Error("localStorage unavailable")
            }),
        })
        try {
            ;(store as any).pendingResourceRollbacks.set("book", {
                generations: {
                    content: 0,
                    preview: 0,
                    request: 0,
                    relinkEpoch: 0,
                    relinkOwner: 0,
                    document: null,
                    tempUrl: "",
                },
                parentId: null,
            })
            ;(store as any).resourceRollbackRetryAttempts.set("book", 5)
            ;(store as any).schedulePendingResourceRollback("book")
            await vi.runAllTimersAsync()
            expect(mark).toHaveBeenCalledTimes(5)
            expect((store as any).pendingResourceRollbacks.has("book")).toBe(true)
            expect((store as any).resourceCleanupMarkers.has("book")).toBe(false)
            expect((store as any).resourceCleanupFailures.has("book")).toBe(true)
            expect((store as any).resourceRollbackRetryTasks.size).toBe(0)
            ;(store as any).schedulePendingResourceRollback("book")
            await vi.runAllTimersAsync()
            expect(mark).toHaveBeenCalledTimes(5)
            expect(vi.getTimerCount()).toBe(0)
        } finally {
            vi.useRealTimers()
        }
    })

    it("cleans up a late resource error after disposal and reopening", async () => {
        const records = new Map<string, any>()
        const contents = new Map<string, any>()
        let rejectCanvas!: (error: unknown) => void
        documentCanvas.mockImplementationOnce(
            () =>
                new Promise((_resolve, reject) => {
                    rejectCanvas = reject
                }),
        )
        const store = new VFSStore()
        store.db = {
            files: {
                put: vi.fn(async (value: any) => {
                    records.set(value.id, structuredClone(value))
                    return value.id
                }),
                get: vi.fn(async (id: string) => records.get(id)),
                getAll: vi.fn(async () => [...records.values()]),
                delete: vi.fn(async (id: string) => records.delete(id)),
            },
            fileContents: {
                put: vi.fn(async (value: any) => {
                    contents.set(value.id, value)
                    return value.id
                }),
                delete: vi.fn(async (id: string) => contents.delete(id)),
            },
            folders: { getAll: vi.fn(async () => []), get: vi.fn(), put: vi.fn() },
            previews: { delete: vi.fn() },
            indexedTexts: { deleteByBookId: vi.fn() },
            userNotes: { deleteByBookId: vi.fn() },
            bookmarks: { deleteByBookId: vi.fn() },
            transaction: vi.fn(async (_mode: unknown, _tables: unknown, callback: () => unknown) =>
                callback(),
            ),
            close: vi.fn(),
        } as never

        const importing = store.importFiles(
            [{ name: "late.pdf", source: handle("late.pdf") }],
            null,
        )
        await vi.waitFor(() => expect(rejectCanvas).toEqual(expect.any(Function)))
        vi.spyOn(store as any, "cleanupPersistedResourceLimitedFile").mockResolvedValue(false)
        vi.useFakeTimers()
        try {
            const disposing = store.dispose()
            await vi.runAllTimersAsync()
            await disposing
            expect([...records.values()]).toEqual([
                expect.objectContaining({ cleanupPending: "resource-limit" }),
            ])
            rejectCanvas(new DocumentSourceLimitError("late pixel limit"))
            await expect(importing).resolves.toMatchObject([{ status: "failed" }])
            await Promise.resolve()
            expect((store as any).pendingResourceRollbacks.size).toBe(0)
        } finally {
            vi.useRealTimers()
        }

        const reopened = new VFSStore()
        reopened.db = store.db
        await reopened.init()
        expect(reopened.nodes).toEqual({})
        expect(records.size).toBe(0)
        expect(contents.size).toBe(0)
    })

    it("rolls back a resource-limited import that fails during disposal", async () => {
        const records = new Map<string, any>()
        const filesPut = vi.fn(async (file: any) => {
            records.set(file.id, structuredClone(file))
            return file.id
        })
        const filesDelete = vi.fn(async (id: string) => records.delete(id))
        const fileContents = new Map<string, any>()
        let rejectCanvas!: (error: unknown) => void
        documentCanvas.mockImplementationOnce(
            () =>
                new Promise((_resolve, reject) => {
                    rejectCanvas = reject
                }),
        )
        const store = new VFSStore()
        store.db = {
            files: {
                put: filesPut,
                get: vi.fn(async (id: string) => records.get(id)),
                getAll: vi.fn(async () => [...records.values()]),
                delete: filesDelete,
                bulkDelete: vi.fn(async (ids: string[]) => ids.forEach((id) => records.delete(id))),
            },
            fileContents: {
                put: vi.fn(async (content: any) => {
                    fileContents.set(content.id, content)
                    return content.id
                }),
                delete: vi.fn(async (id: string) => fileContents.delete(id)),
                bulkDelete: vi.fn(async (ids: string[]) =>
                    ids.forEach((id) => fileContents.delete(id)),
                ),
            },
            previews: { delete: vi.fn(async () => undefined), bulkDelete: vi.fn() },
            indexedTexts: { deleteByBookId: vi.fn(async () => undefined) },
            userNotes: { deleteByBookId: vi.fn(async () => undefined) },
            bookmarks: { deleteByBookId: vi.fn(async () => undefined) },
            folders: {
                get: vi.fn(async () => undefined),
                getAll: vi.fn(async () => []),
                put: vi.fn(async () => undefined),
                bulkDelete: vi.fn(),
            },
            transaction: vi.fn(async (_mode: unknown, _tables: unknown, callback: () => unknown) =>
                callback(),
            ),
            close: vi.fn(),
        } as never

        const completion = store.importFiles(
            [{ name: "limited.pdf", source: handle("limited.pdf") }],
            null,
        )
        await vi.waitFor(() => expect(rejectCanvas).toEqual(expect.any(Function)))
        const disposing = store.dispose()
        await Promise.resolve()
        rejectCanvas(new DocumentSourceLimitError("pixel limit"))
        const [results] = await Promise.all([completion, disposing])

        expect(results).toMatchObject([{ status: "failed" }])
        const reopened = new VFSStore()
        reopened.db = store.db
        await reopened.init()
        expect(reopened.nodes).toEqual({})
        expect(filesDelete).toHaveBeenCalled()
    })

    it("revalidates a handle after persistence when its second read changes", async () => {
        const source = handle("changing.pdf")
        const first = new Blob(["pdf"], { type: "application/pdf" })
        const second = { size: 200 * 1024 * 1024, type: "application/pdf" }
        source.getFile = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second)
        const store = new VFSStore()
        const records = new Map<string, any>()
        store.db = {
            files: {
                put: vi.fn(async (file: any) => {
                    records.set(file.id, file)
                    return file.id
                }),
                get: vi.fn(async (id: string) => records.get(id)),
                delete: vi.fn(async (id: string) => records.delete(id)),
                bulkDelete: vi.fn(async (ids: string[]) => ids.forEach((id) => records.delete(id))),
            },
            fileContents: {
                put: vi.fn(async (content: any) => content.id),
                delete: vi.fn(),
                bulkDelete: vi.fn(),
            },
            previews: { delete: vi.fn(), bulkDelete: vi.fn() },
            indexedTexts: { deleteByBookId: vi.fn() },
            userNotes: { deleteByBookId: vi.fn() },
            bookmarks: { deleteByBookId: vi.fn() },
            folders: { get: vi.fn(), put: vi.fn() },
            transaction: vi.fn(async (_mode: unknown, _tables: unknown, callback: () => unknown) =>
                callback(),
            ),
            close: vi.fn(),
        } as never

        const [result] = await store.importFiles([{ name: "changing.pdf", source }], null)

        expect(result.status).toBe("failed")
        expect(source.getFile).toHaveBeenCalledTimes(2)
        expect(records).toEqual(new Map())
    })

    it("persists a cleanup marker after live rollback retries are exhausted", async () => {
        const store = new VFSStore()
        const markCleanup = vi.fn(async () => undefined)
        ;(store as any).markResourceCleanupPending = markCleanup
        ;(store as any).pendingResourceRollbacks.set("pending", {
            generations: {
                content: 0,
                preview: 0,
                request: 0,
                relinkEpoch: 0,
                relinkOwner: 0,
                document: null,
                tempUrl: "",
            },
            parentId: null,
        })
        ;(store as any).resourceRollbackRetryAttempts.set("pending", 5)

        ;(store as any).schedulePendingResourceRollback("pending")
        await vi.waitFor(() =>
            expect(markCleanup).toHaveBeenCalledWith("pending", expect.any(Object)),
        )
    })

    it("cleans the source after a terminal persistence failure", async () => {
        const store = new VFSStore()
        const source = handle("failed.pdf")
        store.db = {
            transaction: vi.fn(async () => {
                throw new Error("disk full")
            }),
        } as never

        const [result] = await store.importFiles([{ name: "failed.pdf", source }], null)

        expect(result.status).toBe("failed")
        expect((store as any).importSources.size).toBe(0)
    })

    it("does not register imports or notify after disposal", async () => {
        const store = new VFSStore()
        const onFailure = vi.fn()
        store.db = { close: vi.fn() } as never
        await store.dispose()

        await expect(
            store.importFiles([{ name: "book.pdf", source: handle("book.pdf") }], null, {
                onFailure,
            }),
        ).resolves.toMatchObject([{ status: "failed" }])
        expect(store.importJobs).toEqual([])
        expect(onFailure).not.toHaveBeenCalled()
    })

    it("exposes a complete batch synchronously and captures its parent", async () => {
        const store = new VFSStore()
        store.db = {
            transaction: vi.fn(async () => {
                throw new Error("disk full")
            }),
        } as never
        const failures: string[] = []
        const inputs: ImportInput[] = [
            { name: "one.pdf", source: handle("one.pdf") },
            { name: "two.pdf", source: handle("two.pdf") },
            { name: "three.pdf", source: handle("three.pdf") },
        ]

        const completion = store.importFiles(inputs, "folder-a", {
            onFailure: ({ name }, phase) => failures.push(`${phase}:${name}`),
        })

        expect(store.importJobs).toHaveLength(3)
        expect(store.importJobs.map(({ name }) => name)).toEqual([
            "one.pdf",
            "two.pdf",
            "three.pdf",
        ])
        expect(store.importJobs.every(({ parentId }) => parentId === "folder-a")).toBe(true)
        expect(store.activeImportCount).toBe(3)

        await completion
        expect(store.importJobs.every(({ stage }) => stage === "failed")).toBe(true)
        expect(failures).toEqual([
            "persistence:one.pdf",
            "persistence:two.pdf",
            "persistence:three.pdf",
        ])
    })

    it("rejects a non-PDF without blocking a valid sibling", async () => {
        const store = new VFSStore()
        store.db = {
            transaction: vi.fn(async () => {
                throw new Error("expected persistence failure")
            }),
        } as never

        const completion = store.importFiles(
            [
                { name: "notes.txt", source: handle("notes.txt") },
                { name: "book.pdf", source: handle("book.pdf") },
            ],
            null,
        )

        expect(store.importJobs.map(({ name }) => name)).toEqual(["book.pdf"])
        await expect(completion).resolves.toEqual(
            expect.arrayContaining([
                expect.objectContaining({ name: "notes.txt", status: "rejected" }),
                expect.objectContaining({ name: "book.pdf", status: "failed" }),
            ]),
        )
    })

    it("rejects oversized handle imports before persistence", async () => {
        const transaction = vi.fn(async () => undefined)
        const store = new VFSStore()
        store.db = { transaction } as never
        const source = {
            kind: "file",
            name: "large.pdf",
            getFile: vi.fn(async () => ({ size: 101 * 1024 * 1024, type: "application/pdf" })),
        } as unknown as FileSystemFileHandle

        const [result] = await store.importFiles([{ name: "large.pdf", source }], null)

        expect(result.status).toBe("rejected")
        expect(transaction).not.toHaveBeenCalled()
    })

    it("rejects imports before persistence when render bounds fail", async () => {
        documentRenderBounds.mockRejectedValueOnce(
            new DocumentSourceLimitError("pixel canvas limit"),
        )
        const transaction = vi.fn(async () => undefined)
        const store = new VFSStore()
        store.db = { transaction } as never

        const [result] = await store.importFiles(
            [{ name: "large-page.pdf", source: handle("large-page.pdf") }],
            null,
        )

        expect(result.status).toBe("rejected")
        expect(transaction).not.toHaveBeenCalled()
        expect(store.nodes[result.id]).toBeUndefined()
    })

    it("closes preflight documents while enrichment is blocked", async () => {
        let releaseCanvas!: (value: string) => void
        documentCanvas.mockImplementationOnce(
            () =>
                new Promise<string>((resolve) => {
                    releaseCanvas = resolve
                }),
        )
        const store = new VFSStore()
        store.db = {
            files: { put: vi.fn(async () => undefined) },
            fileContents: { put: vi.fn(async () => undefined) },
            transaction: vi.fn(async (_mode, _tables, callback) => callback()),
        } as never

        const first = store.importFiles([{ name: "first.pdf", source: handle("first.pdf") }], null)
        await vi.waitFor(() => expect(documentCanvas).toHaveBeenCalledOnce())
        const second = store.importFiles(
            [{ name: "second.pdf", source: handle("second.pdf") }],
            null,
        )

        await vi.waitFor(() => expect(documentClose).toHaveBeenCalledTimes(2))
        expect(documentConstructed).toHaveBeenCalledTimes(3)

        releaseCanvas("")
        await expect(first).resolves.toMatchObject([{ status: "imported" }])
        await expect(second).resolves.toMatchObject([{ status: "imported" }])
    })

    it("retains a persisted node when metadata enrichment fails", async () => {
        documentLoad.mockRejectedValue(new Error("corrupt PDF"))
        const store = new VFSStore()
        store.db = {
            files: { put: vi.fn(async () => "book") },
            fileContents: { put: vi.fn(async () => "book") },
            folders: { put: vi.fn(async () => "folder") },
            previews: { put: vi.fn(async () => "preview") },
            transaction: vi.fn(async (_mode, _tables, callback) => callback()),
        } as never
        const phases: string[] = []

        const [result] = await store.importFiles(
            [{ name: "corrupt.pdf", source: handle("corrupt.pdf") }],
            null,
            { onFailure: (_result, phase) => phases.push(phase) },
        )

        expect(result.status).toBe("imported")
        expect(store.nodes[result.id]).toMatchObject({
            id: result.id,
            name: "corrupt.pdf",
            metadata: { pageNumber: 1 },
            isPinned: false,
        })
        expect(store.importJobs).toHaveLength(0)
        expect(phases).toEqual(["metadata"])
    })

    it("clears only transient failed cards", () => {
        const store = new VFSStore()
        store.importJobs = [
            { id: "queued", name: "queued.pdf", parentId: null, stage: "queued" },
            { id: "failed", name: "failed.pdf", parentId: null, stage: "failed" },
        ]
        store.clearFailedImports()
        expect(store.importJobs.map(({ id }) => id)).toEqual(["queued"])
    })
})
