import { describe, expect, it } from "vitest"
import type { Book } from "./stores/viewerStore.types"
import type { ViewerFileCapability, ViewerFileNode } from "./viewerHost"
import { ReadingWorkspace } from "./readingWorkspace"
import type { OpenedDocument } from "$lib/document-model"
import { DocumentService } from "$lib/core/documents"
import { createBlobDocumentSource } from "$lib/core/files"
import type { ViewerDocumentLoader } from "./viewerDocument"

function fileAccess() {
    const nodes: Record<string, ViewerFileNode> = {
        first: { id: "first", name: "First", type: "file", updatedAt: 1, metadata: {} },
        second: { id: "second", name: "Second", type: "file", updatedAt: 1, metadata: {} },
    }
    const acquired: string[] = []
    const released: string[] = []
    const files = {
        nodes,
        isLockedMap: {},
        getFileUrl: async (id: string) => {
            acquired.push(id)
            return `blob:${id}`
        },
        restoreFileAccess: async (): Promise<string | undefined> => undefined,
        requestRelink: () => undefined,
        waitForRelink: async () => undefined,
        releaseFileUrl: (_id: string, url: string) => {
            released.push(url)
            return true
        },
        getContentGeneration: () => 0,
        isCurrentContent: (_id: string, _generation: number): boolean => true,
        isCurrentFileUrl: () => true,
        clearForwardHistory: () => undefined,
    } satisfies ViewerFileCapability
    return { files, acquired, released }
}

function deferred<T>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => {
        resolve = done
    })
    return { promise, resolve }
}

function reader(files = fileAccess().files, loader?: ViewerDocumentLoader) {
    let book: Book | null = null
    const workspace = new ReadingWorkspace({
        files,
        loader,
        getCurrentBook: () => book,
        publish: (value) => {
            book = value
        },
    })
    return { workspace, current: () => book }
}

function documentLoader() {
    const closed: string[] = []
    const sources: string[] = []
    const service = new DocumentService()
    service.adapters.register({
        id: "viewer.test.reflow",
        extensions: [],
        mimeTypes: [],
        probe: async () => ({ supported: true }),
        open: async (source) => ({
            kind: "reflowable",
            metadata: { title: source.name, author: null },
            capabilities: new Set(),
            getSections: async () => [{ id: "intro", title: "Intro", content: "Hello" }],
            close: async () => {
                closed.push(source.id)
                await source.close?.()
            },
        }),
    })
    const loader: ViewerDocumentLoader = {
        open: async (input, signal) => {
            const source = createBlobDocumentSource({ ...input, blob: new Blob(["Hello"]) })
            const close = source.close
            source.close = async () => {
                sources.push(input.id)
                await close?.()
            }
            const document = await service.open(source, signal)
            return {
                ...document,
                close: () => service.close(document),
            } as OpenedDocument
        },
    }
    return { loader, closed, sources }
}

describe("Reading workspace", () => {
    it("owns adapter and source cleanup even if a view closes the document twice", async () => {
        const { loader, closed, sources } = documentLoader()
        const { workspace } = reader(undefined, loader)
        await workspace.open("first")
        const document = await workspace.loadDocument()
        expect(document?.kind).toBe("reflowable")
        if (document?.kind !== "reflowable") throw new Error("Expected a reflowable document")
        expect(await document.getSections()).toEqual([
            { id: "intro", title: "Intro", content: "Hello" },
        ])

        await Promise.all([document.close(), document.close(), workspace.dispose()])
        expect(closed).toEqual(["first"])
        expect(sources).toEqual(["first"])
    })

    it("keeps the existing adapter when reopening the same document", async () => {
        const { loader, closed } = documentLoader()
        const { workspace } = reader(undefined, loader)
        await workspace.open("first")
        const first = await workspace.loadDocument()
        await workspace.open("first")
        expect(await workspace.loadDocument()).toBe(first)
        expect(closed).toEqual([])
        await workspace.dispose()
        expect(closed).toEqual(["first"])
    })

    it("restores locked access and publishes the refreshed Library node", async () => {
        const { files, acquired, released } = fileAccess()
        files.nodes.first.isLocked = true
        files.restoreFileAccess = async () => {
            files.nodes.first = { ...files.nodes.first, name: "Restored", isLocked: false }
            return "blob:restored"
        }
        const { workspace, current } = reader(files)
        await expect(workspace.open("first")).resolves.toBe(true)
        expect(current()).toMatchObject({ name: "Restored", url: "blob:restored" })
        expect(acquired).toEqual([])
        await workspace.dispose()
        expect(released).toEqual(["blob:restored"])
    })

    it("suppresses a stale source acquisition without releasing the newer reader", async () => {
        const { files, released } = fileAccess()
        const pending = deferred<string>()
        files.getFileUrl = (id) =>
            id === "first" ? pending.promise : Promise.resolve("blob:second")
        const { workspace, current } = reader(files)
        const first = workspace.open("first")
        await workspace.open("second")
        pending.resolve("blob:first")
        await expect(first).resolves.toBe(false)
        expect(current()).toMatchObject({ id: "second" })
        expect(released).toEqual(["blob:first"])
        await workspace.dispose()
        expect(released).toEqual(["blob:first", "blob:second"])
    })

    it("rejects failed publication without disturbing the previous source or adapter", async () => {
        const { files, released } = fileAccess()
        const { loader, closed } = documentLoader()
        let book: Book | null = null
        const workspace = new ReadingWorkspace({
            files,
            loader,
            getCurrentBook: () => book,
            publish: (value) => {
                if (value?.id === "second") throw new Error("Publication rejected")
                book = value
            },
        })
        await workspace.open("first")
        const document = await workspace.loadDocument()
        await expect(workspace.open("second")).rejects.toThrow("Publication rejected")
        expect(book).toMatchObject({ id: "first" })
        expect(released).toEqual(["blob:second"])
        expect(closed).toEqual([])
        await document?.close()
        await workspace.dispose()
        expect(closed).toEqual(["first"])
        expect(released).toEqual(["blob:second", "blob:first"])
    })

    it("cleans up an adapter that completes after its workspace is disposed", async () => {
        const { files, released } = fileAccess()
        const real = documentLoader()
        const pending = deferred<void>()
        const loader: ViewerDocumentLoader = {
            open: async (input) => {
                await pending.promise
                return real.loader.open(input)
            },
        }
        const { workspace } = reader(files, loader)
        await workspace.open("first")
        const loading = workspace.loadDocument()
        await workspace.dispose()
        pending.resolve()
        await expect(loading).resolves.toBeUndefined()
        expect(real.closed).toEqual(["first"])
        expect(real.sources).toEqual(["first"])
        expect(released).toEqual(["blob:first"])
        await expect(workspace.open("second")).resolves.toBe(false)
    })

    it("cleans up a stale adapter after a different document is published", async () => {
        const real = documentLoader()
        const pending = deferred<void>()
        const loader: ViewerDocumentLoader = {
            open: async (input) => {
                if (input.id === "first") await pending.promise
                return real.loader.open(input)
            },
        }
        const { workspace, current } = reader(undefined, loader)
        await workspace.open("first")
        const loading = workspace.loadDocument()
        await workspace.open("second")
        const document = await workspace.loadDocument()
        pending.resolve()
        await expect(loading).resolves.toBeUndefined()
        expect(current()).toMatchObject({ id: "second" })
        expect(real.closed).toEqual(["first"])
        await workspace.dispose()
        await document?.close()
        expect(real.closed).toEqual(["first", "second"])
    })

    it("releases an acquisition completing after close without republishing it", async () => {
        const { files, released } = fileAccess()
        const pending = deferred<string>()
        files.getFileUrl = () => pending.promise
        const { workspace, current } = reader(files)
        const opening = workspace.open("first")
        await workspace.close()
        pending.resolve("blob:late")
        await expect(opening).resolves.toBe(false)
        expect(current()).toBeNull()
        expect(released).toEqual(["blob:late"])
    })

    it("waits for a superseding relink rather than reporting failed restoration", async () => {
        const { files, released } = fileAccess()
        files.nodes.first.isLocked = true
        files.restoreFileAccess = async () => {
            const error = new Error("Relink in progress")
            error.name = "ContentSupersededError"
            throw error
        }
        files.waitForRelink = async () => {
            files.nodes.first = { ...files.nodes.first, isLocked: false, name: "Relinked" }
        }
        const { workspace, current } = reader(files)
        await expect(workspace.open("first")).resolves.toBe(true)
        expect(current()).toMatchObject({ name: "Relinked" })
        expect(released).toEqual([])
        await workspace.dispose()
    })

    it("suppresses an acquisition superseded by a newer request for a missing document", async () => {
        const { files, released } = fileAccess()
        const pending = deferred<string>()
        files.getFileUrl = () => pending.promise
        const { workspace, current } = reader(files)
        const opening = workspace.open("first")
        await expect(workspace.open("missing")).resolves.toBe(false)
        pending.resolve("blob:first")
        await expect(opening).resolves.toBe(false)
        expect(current()).toBeNull()
        expect(released).toEqual(["blob:first"])
    })

    it("releases every unused restoration claim when access must be restored repeatedly", async () => {
        const { files, released } = fileAccess()
        files.nodes.first.isLocked = true
        let attempts = 0
        files.restoreFileAccess = async () => {
            attempts++
            files.nodes.first.isLocked = attempts < 2
            return `blob:restore-${attempts}`
        }
        const { workspace, current } = reader(files)
        await workspace.open("first")
        expect(current()).toMatchObject({ url: "blob:restore-2" })
        expect(released).toEqual(["blob:restore-1"])
        await workspace.dispose()
        expect(released).toEqual(["blob:restore-1", "blob:restore-2"])
    })

    it("releases a rejected publication claim exactly once", async () => {
        const { files, released } = fileAccess()
        const workspace = new ReadingWorkspace({
            files,
            getCurrentBook: () => null,
            publish: () => false,
        })
        await expect(workspace.open("first")).resolves.toBe(false)
        expect(await workspace.loadDocument()).toBeUndefined()
        await workspace.close()
        await workspace.dispose()
        expect(released).toEqual(["blob:first"])
    })

    it("replaces a relinked source and closes only the superseded adapter", async () => {
        const { files, released } = fileAccess()
        const { loader, closed } = documentLoader()
        const { workspace, current } = reader(files, loader)
        await workspace.open("first")
        await workspace.loadDocument()
        files.getContentGeneration = () => 1
        files.isCurrentContent = (_id, generation) => generation === 1
        files.getFileUrl = async () => "blob:relinked"
        await workspace.synchronize()
        expect(current()).toMatchObject({ id: "first", url: "blob:relinked" })
        expect(closed).toEqual(["first"])
        expect(released).toEqual(["blob:first"])
        await workspace.loadDocument()
        await workspace.dispose()
        expect(closed).toEqual(["first", "first"])
        expect(released).toEqual(["blob:first", "blob:relinked"])
    })

    it("keeps an inaccessible relinked document visibly locked", async () => {
        const { files, released } = fileAccess()
        const { workspace, current } = reader(files)
        await workspace.open("first")
        files.getContentGeneration = () => 1
        files.isCurrentContent = (_id, generation) => generation === 1
        files.getFileUrl = async () => ""
        await workspace.synchronize()
        expect(current()).toMatchObject({ id: "first", url: "", isLocked: true })
        expect(released).toEqual(["blob:first"])
        await workspace.dispose()
        expect(released).toEqual(["blob:first"])
    })

    it.each(["relink", "delete"] as const)(
        "does not let %s maintenance cancel an explicit open of another document",
        async (maintenance) => {
            const { files, released } = fileAccess()
            const { workspace, current } = reader(files)
            await workspace.open("first")
            const pending = deferred<string>()
            files.getFileUrl = (id) =>
                id === "second" ? pending.promise : Promise.resolve("blob:relinked")
            const opening = workspace.open("second")
            if (maintenance === "delete") delete files.nodes.first
            await workspace.synchronize()
            pending.resolve("blob:second")
            await expect(opening).resolves.toBe(true)
            expect(current()).toMatchObject({ id: "second", url: "blob:second" })
            expect(released).toEqual(["blob:first"])
            await workspace.dispose()
        },
    )

    it("retries maintenance when a relink supersedes an in-flight synchronization", async () => {
        const { files, released } = fileAccess()
        const pending = deferred<string>()
        let generation = 0
        files.getContentGeneration = () => generation
        files.isCurrentContent = (_id, expected) => expected === generation
        files.getFileUrl = () =>
            generation === 0 ? pending.promise : Promise.resolve("blob:relinked")
        let book: Book | null = { id: "first", name: "First", updatedAt: 1, pageNumber: 5, url: "" }
        const workspace = new ReadingWorkspace({
            files,
            getCurrentBook: () => book,
            publish: (value) => {
                book = value
            },
        })
        const initial = workspace.synchronize()
        generation = 1
        const relinked = workspace.synchronize(true)
        pending.resolve("blob:stale")
        await Promise.all([initial, relinked])
        expect(book).toMatchObject({ id: "first", url: "blob:relinked" })
        expect(released).toEqual(["blob:stale"])
        await workspace.dispose()
    })

    it.each(["available", "locked"] as const)(
        "refreshes a relinked active document as %s when a superseding explicit open fails",
        async (access) => {
            const { files, released } = fileAccess()
            const { workspace, current } = reader(files)
            await workspace.open("first")
            const pending = deferred<string>()
            files.getFileUrl = (id) =>
                id === "second"
                    ? pending.promise
                    : Promise.resolve(access === "available" ? "blob:relinked" : "")
            const opening = workspace.open("second")
            files.getContentGeneration = () => 1
            files.isCurrentContent = (_id, generation) => generation === 1
            await workspace.synchronize(true)
            pending.resolve("")
            await expect(opening).resolves.toBe(false)
            expect(current()).toMatchObject(
                access === "available"
                    ? { id: "first", url: "blob:relinked" }
                    : { id: "first", url: "", isLocked: true },
            )
            expect(released).toEqual(["blob:first"])
            await workspace.dispose()
        },
    )

    it("publishes an accessible document, reuses its source and closes its claim once", async () => {
        const { files, acquired, released } = fileAccess()
        const { workspace, current } = reader(files)

        await expect(workspace.open("first")).resolves.toBe(true)
        expect(current()).toMatchObject({ id: "first", url: "blob:first" })
        await workspace.open("first")
        expect(acquired).toEqual(["first"])
        expect(released).toEqual([])

        await workspace.close()
        await workspace.close()
        await workspace.dispose()
        expect(current()).toBeNull()
        expect(released).toEqual(["blob:first"])
    })
})
