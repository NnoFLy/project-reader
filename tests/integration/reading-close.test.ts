import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createBuiltinHost } from "$lib/extensions/builtin"
import { createExtensionStorage, MemoryStorageBackend } from "$lib/core/storage"
import type {
    ViewerFileCapability,
    ViewerLibraryCapability,
    ViewerLibraryMutationCapability,
} from "$lib/extensions/builtin/viewer/viewerHost"
import { ViewerStore } from "$lib/extensions/builtin/viewer/stores/viewerStore.svelte"
import { ViewerCloseController } from "$lib/extensions/builtin/viewer/viewerClose.svelte"
import { createViewerOpenCommand } from "$lib/extensions/builtin/viewer/commands/viewerOpenCommand"

const { navigate } = vi.hoisted(() => ({
    navigate: vi.fn<(...args: unknown[]) => Promise<void>>(async () => undefined),
}))
vi.mock("$app/navigation", () => ({ goto: navigate, pushState() {} }))
vi.mock("$app/paths", () => ({ resolve: (path: string) => path }))

function reader() {
    const nodes = {
        book: { id: "book", name: "Book", type: "file" as const, updatedAt: 1, metadata: {} },
        next: { id: "next", name: "Next", type: "file" as const, updatedAt: 1, metadata: {} },
    }
    const files: ViewerFileCapability = {
        nodes,
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
    }
    const library: ViewerLibraryCapability = {
        ...files,
        isLockedMap: {},
        allFiles: Object.values(nodes),
        initialized: true,
        isDisposed: false,
        onNodesDeleted: () => () => undefined,
        onNodesDeleting: () => () => undefined,
        onNodeRelinked: () => () => undefined,
        onContentRestored: () => () => undefined,
        onNodeInvalidated: () => () => undefined,
        isNodeDeleting: () => false,
        getIndexedTexts: async () => [],
        getPreviewUrl: async () => "",
        getFolderPath: () => "",
    }
    const mutations: ViewerLibraryMutationCapability = {
        releaseFileUrl: (id, url) => files.releaseFileUrl(id, url ?? ""),
        setActiveFileId() {},
        serializeBookMutation: async (_id, mutation) => mutation(),
        serializeMetadataMutation: async (mutation) => mutation(),
        saveIndexedTexts: async () => true,
        revokePreviewUrl() {},
        invalidatePreview: async () => undefined,
        updateFile: async () => undefined,
        pushForwardHistory() {},
        clearForwardHistory() {},
    }
    const store = new ViewerStore({ files, library, mutations })
    const backend = new MemoryStorageBackend()
    const storage = createExtensionStorage(backend, "builtin.viewer").namespace("viewer")
    return { store, storage, backend, files }
}

const passageDraft = {
    pageNumber: 1,
    start: 0,
    end: 7,
    text: "Passage",
    noteContent: "Unfinished",
    color: "blue" as const,
    association: { contentHash: null, verification: "unverified" as const },
}

describe("Viewer explicit close adapter", () => {
    let settingsHost: ReturnType<typeof createBuiltinHost>
    beforeAll(async () => {
        settingsHost = createBuiltinHost({ storage: new MemoryStorageBackend() })
        await settingsHost.activate("builtin.settings")
    })
    afterAll(async () => {
        await settingsHost.dispose()
    })

    it.each(["cancel", "save", "discard"] as const)(
        "requires an explicit %s decision and navigates only after closing",
        async (choice) => {
            navigate.mockClear()
            const { store, storage } = reader()
            await store.configureStorage(storage)
            await store.workspace.open("book")
            await store.workspace.createDraft("book", passageDraft)
            const closing = new ViewerCloseController(store)
            await closing.close()
            expect(closing.token?.documentId).toBe("book")
            expect(navigate).not.toHaveBeenCalled()
            await closing.choose(choice)
            expect(store.reading.documentId).toBe(choice === "cancel" ? "book" : null)
            expect(store.workspace.annotations("book").drafts).toHaveLength(
                choice === "cancel" ? 1 : 0,
            )
            expect(store.workspace.annotations("book").notes).toHaveLength(
                choice === "save" ? 1 : 0,
            )
            expect(navigate.mock.calls).toEqual(choice === "cancel" ? [] : [["/"]])
            await store.dispose()
        },
    )

    it("keeps failed close-save work open with a fresh discard decision", async () => {
        navigate.mockClear()
        const { store, storage, backend } = reader()
        await store.configureStorage(storage)
        await store.workspace.open("book")
        await store.workspace.createDraft("book", passageDraft)
        const closing = new ViewerCloseController(store)
        await closing.close()
        const firstToken = closing.token
        const set = backend.set.bind(backend)
        backend.set = async (key, value) => {
            if (key.includes("reading-v1-annotations-")) throw new Error("private")
            await set(key, value)
        }
        await closing.choose("save")
        expect(closing.failed).toBe(true)
        expect(closing.token).not.toBe(firstToken)
        expect(store.reading.documentId).toBe("book")
        expect(store.workspace.annotations("book").drafts).toHaveLength(1)
        expect(navigate).not.toHaveBeenCalled()
        backend.set = set
        await closing.choose("discard")
        expect(store.reading.documentId).toBeNull()
        expect(store.workspace.annotations("book").notes).toEqual([])
        await store.dispose()
    })

    it("refreshes a consumed token when a draft changes during the decision", async () => {
        const { store, storage } = reader()
        await store.configureStorage(storage)
        await store.workspace.open("book")
        const draft = await store.workspace.createDraft("book", passageDraft)
        const closing = new ViewerCloseController(store)
        await closing.close()
        const first = closing.token
        await store.workspace.updateDraft("book", draft.value!.id, {
            noteContent: "New input",
            color: "pink",
        })
        await closing.choose("save")
        expect(closing.token).not.toBe(first)
        expect(closing.token?.documentId).toBe("book")
        expect(store.workspace.annotations("book").notes).toEqual([])
        await closing.choose("cancel")
        expect(store.reading.documentId).toBe("book")
        await store.dispose()
    })

    it("never routes a delayed old-document close over a newer selection", async () => {
        navigate.mockClear()
        const { store, storage, backend } = reader()
        await store.configureStorage(storage)
        await store.workspace.open("book")
        await store.workspace.createDraft("book", passageDraft)
        const closing = new ViewerCloseController(store)
        await closing.close()
        const set = backend.set.bind(backend)
        let release!: () => void
        const blocked = new Promise<void>((resolve) => (release = resolve))
        backend.set = async (key, value) => {
            if (key.includes("reading-v1-annotations-")) await blocked
            await set(key, value)
        }
        const saving = closing.choose("save")
        closing.selectionStarted()
        await store.workspace.open("next")
        release()
        await saving
        expect(store.reading.documentId).toBe("next")
        expect(navigate).not.toHaveBeenCalled()
        await store.dispose()
    })

    it("orders an already pending Library route before the initiating open command's final reader route", async () => {
        const { store, storage, files } = reader()
        await store.configureStorage(storage)
        await store.workspace.open("book")
        const closing = new ViewerCloseController(store)
        let finishRoute!: () => void
        const routes: string[] = []
        navigate.mockImplementationOnce(
            (path) =>
                new Promise<void>((resolve) => {
                    finishRoute = () => {
                        routes.push(String(path))
                        resolve()
                    }
                }),
        )
        const close = closing.close()
        await vi.waitFor(() => expect(finishRoute).toBeTypeOf("function"))
        let finishSource!: (url: string) => void
        files.getFileUrl = () =>
            new Promise((resolve) => {
                finishSource = resolve
            })
        const open = createViewerOpenCommand({
            workspace: store.workspace,
            onFileAccessFailure() {},
            selectionStarted: () => closing.selectionStarted(),
            settleCloseNavigation: () => closing.settleNavigation(),
        })
        navigate.mockImplementation(async (path) => {
            routes.push(String(path))
        })
        const opening = open.run({ bookId: "next" })
        await vi.waitFor(() => expect(finishSource).toBeTypeOf("function"))
        finishRoute()
        await close
        finishSource("blob:next")
        await opening
        expect(routes.at(-1)).toBe("/viewer")
        expect(store.reading.documentId).toBe("next")
        await store.dispose()
    })
})
