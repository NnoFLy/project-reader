import { describe, expect, it, vi } from "vitest"
import { createExtensionStorage, MemoryStorageBackend } from "$lib/core/storage"
import { ReadingStorage, ReadingStorageError } from "./readingStorage"
import type { Book } from "./stores/viewerStore.types"
import type { ViewerFileCapability, ViewerFileNode } from "./viewerHost"
import { ReadingWorkspace, type ReadingWorkspaceOptions } from "./readingWorkspace"
import type { StorageNamespace } from "$lib/extension-api"
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

function reader(
    files = fileAccess().files,
    loader?: ViewerDocumentLoader,
    options: Partial<ReadingWorkspaceOptions> = {},
) {
    let book: Book | null = null
    const workspace = new ReadingWorkspace({
        files,
        loader,
        getCurrentBook: () => book,
        publish: (value) => {
            book = value
        },
        ...options,
    })
    return { workspace, current: () => book }
}

function readingNamespace(): StorageNamespace {
    return createExtensionStorage(new MemoryStorageBackend(), "builtin.viewer").namespace("viewer")
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
    it("reconstructs only the current document with independent saved position and display", async () => {
        const storage = new ReadingStorage(
            createExtensionStorage(new MemoryStorageBackend(), "builtin.viewer").namespace(
                "viewer",
            ),
        )
        function start() {
            const access = fileAccess()
            let book: Book | null = null
            const workspace = new ReadingWorkspace({
                files: access.files,
                storage,
                getCurrentBook: () => book,
                publish: (value) => {
                    book = value
                },
            })
            return { workspace, ...access }
        }
        const first = start()
        await first.workspace.open("first")
        first.workspace.setPosition(7, 0.35)
        first.workspace.setScale(1.5)
        first.workspace.setLayout("split")
        await first.workspace.close()
        await first.workspace.open("second")
        first.workspace.setPosition(3, 0.2)
        first.workspace.setScale(2)
        first.workspace.setLayout("scroll")
        await first.workspace.flush()
        await first.workspace.dispose()
        const restored = start()
        await restored.workspace.restore()
        expect(restored.acquired).toEqual(["second"])
        expect(restored.workspace.snapshot).toMatchObject({
            documentId: "second",
            state: { pageNumber: 3, scrollPosition: 0.2, scale: 2, layout: "scroll" },
        })
        await restored.workspace.open("first")
        expect(restored.workspace.snapshot).toMatchObject({
            documentId: "first",
            state: { pageNumber: 7, scrollPosition: 0.35, scale: 1.5, layout: "split" },
        })
        await restored.workspace.dispose()
    })
    it("restores a signed page-relative offset after reopening and reconstruction", async () => {
        const storage = new ReadingStorage(readingNamespace())
        const { workspace, current } = reader(undefined, undefined, { storage })
        await workspace.open("first")
        workspace.setPosition(2, -0.4666666666666667)
        await workspace.close()
        await workspace.open("first")
        expect(current()).toMatchObject({ pageNumber: 2, scrollPosition: -0.4666666666666667 })
        await workspace.flush()
        await workspace.dispose()

        const restored = reader(undefined, undefined, { storage })
        await restored.workspace.restore()
        expect(restored.workspace.snapshot.state).toMatchObject({
            pageNumber: 2,
            scrollPosition: -0.4666666666666667,
        })
        expect(restored.current()).toMatchObject({
            id: "first",
            pageNumber: 2,
            scrollPosition: -0.4666666666666667,
        })
        await restored.workspace.dispose()
    })

    it("keeps signed positions intact when unsafe reading changes are rejected", async () => {
        const { workspace } = reader()
        await workspace.open("first")
        workspace.setPosition(2, -0.4666666666666667)
        for (const offset of [NaN, Infinity, -Infinity]) workspace.setPosition(3, offset)
        for (const page of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])
            workspace.setPosition(page, 0.5)
        for (const scale of [0.24, 5.01, NaN, Infinity, -Infinity]) workspace.setScale(scale)
        workspace.setLayout("unsafe" as "scroll")
        expect(workspace.snapshot.state).toEqual({
            pageNumber: 2,
            scrollPosition: -0.4666666666666667,
            scale: 1.5,
            layout: "scroll",
        })
        await workspace.dispose()
    })

    it.each([
        { scrollPosition: NaN },
        { scrollPosition: Infinity },
        { scrollPosition: -Infinity },
        { scrollPosition: "-0.4" },
        { pageNumber: 0 },
        { pageNumber: -1 },
        { pageNumber: 1.5 },
        { pageNumber: Number.MAX_SAFE_INTEGER + 1 },
        { pageNumber: Infinity },
        { scale: 0.24 },
        { scale: 5.01 },
        { scale: NaN },
        { scale: Infinity },
        { layout: "unsafe" },
    ])("rejects untrusted document state with invalid fields: %j", async (invalid) => {
        const namespace = readingNamespace()
        const storage = new ReadingStorage(namespace)
        await storage.writeCurrent("first")
        await storage.writeDocument("first", {
            pageNumber: 2,
            scrollPosition: -0.4666666666666667,
            scale: 2,
            layout: "single",
        })
        const key = (await namespace.keys()).find((key) => key.startsWith("reading-v1-document-"))!
        await namespace.set(key, {
            version: 1,
            documentId: "first",
            pageNumber: 2,
            scrollPosition: -0.4666666666666667,
            scale: 2,
            layout: "single",
            ...invalid,
        })
        const { workspace } = reader(undefined, undefined, { storage })
        await workspace.restore()
        expect(workspace.snapshot.state).toEqual({
            pageNumber: 1,
            scrollPosition: 0,
            scale: 1.5,
            layout: "scroll",
        })
        await workspace.dispose()
    })

    it.each(["current-open", "current-close", "document-open", "document-close"])(
        "fences delayed %s restoration reads against explicit intent",
        async (scenario) => {
            const namespace = readingNamespace()
            const storage = new ReadingStorage(namespace)
            await storage.writeCurrent("first")
            await storage.writeDocument("first", {
                pageNumber: 8,
                scrollPosition: 0.4,
                scale: 2.5,
                layout: "single",
            })
            const pending = deferred<void>()
            const entered = deferred<void>()
            const get = namespace.get.bind(namespace)
            let blocked = false
            namespace.get = async <T>(key: string): Promise<T | undefined> => {
                if (
                    !blocked &&
                    (scenario.startsWith("current")
                        ? key === "reading-v1-current"
                        : key.startsWith("reading-v1-document-"))
                ) {
                    blocked = true
                    const value = await get<T>(key)
                    entered.resolve()
                    await pending.promise
                    return value
                }
                return get<T>(key)
            }
            const access = fileAccess()
            const { workspace, current } = reader(access.files, undefined, { storage })
            const restoring = workspace.restore()
            await entered.promise
            if (scenario.endsWith("open")) await workspace.open("second")
            else await workspace.close()
            pending.resolve()
            await restoring
            await workspace.flush()
            expect(workspace.snapshot.documentId).toBe(scenario.endsWith("open") ? "second" : null)
            expect(current()?.id ?? null).toBe(scenario.endsWith("open") ? "second" : null)
            expect(access.acquired).toEqual(scenario.endsWith("open") ? ["second"] : [])
            expect(await storage.readCurrent()).toBe(scenario.endsWith("open") ? "second" : null)
            await workspace.dispose()
        },
    )

    it.each(["open", "close"])(
        "does not begin restoration over an earlier explicit %s",
        async (intent) => {
            const storage = new ReadingStorage(readingNamespace())
            await storage.writeCurrent("first")
            const access = fileAccess()
            const { workspace } = reader(access.files)
            if (intent === "open") await workspace.open("second")
            else await workspace.close()
            await workspace.restore(storage)
            await workspace.flush()
            expect(await storage.readCurrent()).toBe(intent === "open" ? "second" : null)
            expect(workspace.snapshot.documentId).toBe(intent === "open" ? "second" : null)
            expect(access.acquired).toEqual(intent === "open" ? ["second"] : [])
            await workspace.dispose()
        },
    )

    it("keeps delayed immutable saves bound to their document and the final current selection", async () => {
        const namespace = readingNamespace()
        const storage = new ReadingStorage(namespace)
        const pending = deferred<void>()
        const entered = deferred<void>()
        const set = namespace.set.bind(namespace)
        let blocked = false
        namespace.set = async (key, value) => {
            if (!blocked) {
                blocked = true
                entered.resolve()
                await pending.promise
            }
            await set(key, value)
        }
        const { workspace } = reader(undefined, undefined, { storage })
        await workspace.open("first")
        await entered.promise
        workspace.setPosition(7, 0.5)
        workspace.setLayout("split")
        await workspace.open("second")
        workspace.setPosition(3, 0.2)
        workspace.setScale(2)
        await workspace.close()
        await workspace.open("first")
        pending.resolve()
        await workspace.flush()
        const recovered = reader(undefined, undefined, { storage }).workspace
        await recovered.restore()
        expect(recovered.snapshot).toMatchObject({
            documentId: "first",
            state: { pageNumber: 7, scrollPosition: 0.5, layout: "split" },
        })
        await recovered.open("second")
        expect(recovered.snapshot.state).toMatchObject({
            pageNumber: 3,
            scrollPosition: 0.2,
            scale: 2,
        })
        await Promise.all([workspace.dispose(), recovered.dispose()])
    })

    it("preserves in-memory work through typed safe storage failures", async () => {
        const namespace = readingNamespace()
        namespace.get = async () => {
            throw new Error("private bytes and raw stack")
        }
        namespace.set = async () => {
            throw new Error("private bytes and raw stack")
        }
        const errors: ReadingStorageError[] = []
        const { workspace } = reader(undefined, undefined, {
            storage: new ReadingStorage(namespace),
            onStorageError: (error) => errors.push(error),
        })
        await workspace.restore()
        await workspace.open("first")
        workspace.setPosition(6, 0.4)
        workspace.setScale(1.75)
        await workspace.flush()
        await workspace.close()
        await workspace.open("first")
        expect(workspace.snapshot.state).toMatchObject({
            pageNumber: 6,
            scrollPosition: 0.4,
            scale: 1.75,
        })
        expect(errors.some((error) => error.code === "reading.storage.read")).toBe(true)
        expect(errors.some((error) => error.code === "reading.storage.write")).toBe(true)
        expect(
            errors.every(
                (error) =>
                    error instanceof ReadingStorageError && !error.message.includes("private"),
            ),
        ).toBe(true)
        await workspace.dispose()
    })

    it.each([
        null,
        { version: 99, documentId: "first" },
        { version: 1, documentId: { html: "<script>private</script>" } },
    ])(
        "ignores malformed or unknown current records without legacy fallback: %j",
        async (record) => {
            const namespace = readingNamespace()
            await namespace.set("reading-v1-current", record)
            await namespace.set("book", {
                id: "first",
                pageNumber: 99,
                url: "https://untrusted.invalid",
            })
            const access = fileAccess()
            const { workspace } = reader(access.files, undefined, {
                storage: new ReadingStorage(namespace),
            })
            await workspace.restore()
            expect(workspace.snapshot.documentId).toBeNull()
            expect(access.acquired).toEqual([])
            expect(await namespace.get("book")).toMatchObject({ pageNumber: 99 })
            await workspace.dispose()
        },
    )

    it.each(["absent", "malformed", "unknown"])(
        "starts from application defaults for %s document state, never legacy metadata",
        async (kind) => {
            const namespace = readingNamespace()
            const storage = new ReadingStorage(namespace)
            await storage.writeCurrent("first")
            await storage.writeDocument("first", {
                pageNumber: 9,
                scrollPosition: 0.9,
                scale: 4,
                layout: "split",
            })
            const key = (await namespace.keys()).find((key) =>
                key.startsWith("reading-v1-document-"),
            )!
            if (kind === "absent") await namespace.delete(key)
            else if (kind === "unknown")
                await namespace.set(key, { ...(await namespace.get<object>(key)), version: 2 })
            else
                await namespace.set(key, {
                    version: 1,
                    documentId: "first",
                    pageNumber: "<img onerror=alert(1)>",
                    scale: Infinity,
                    layout: "unsafe",
                })
            const access = fileAccess()
            access.files.nodes.first.metadata = { pageNumber: 77, scrollPosition: 0.8 }
            const { workspace, current } = reader(access.files, undefined, {
                storage,
                defaults: () => ({ scale: 1.25, layout: "single" }),
            })
            await workspace.restore()
            expect(workspace.snapshot.state).toEqual({
                pageNumber: 1,
                scrollPosition: 0,
                scale: 1.25,
                layout: "single",
            })
            expect(current()).toMatchObject({ pageNumber: 1, scrollPosition: 0, url: "blob:first" })
            await workspace.dispose()
        },
    )

    it("reports pending restoration readiness without default writes, then suppresses completion after close", async () => {
        vi.useFakeTimers()
        const namespace = readingNamespace()
        const storage = new ReadingStorage(namespace)
        await storage.writeCurrent("first")
        const pending = deferred<void>()
        const entered = deferred<void>()
        const get = namespace.get.bind(namespace)
        let blocked = false
        namespace.get = async <T>(key: string): Promise<T | undefined> => {
            const value = await get<T>(key)
            if (!blocked && key === "reading-v1-current") {
                blocked = true
                entered.resolve()
                await pending.promise
            }
            return value
        }
        const access = fileAccess()
        const { workspace } = reader(access.files, undefined, { storage })
        try {
            const restoring = workspace.restore()
            await entered.promise
            await vi.advanceTimersByTimeAsync(250)
            await expect(restoring).resolves.toBe("pending")
            expect(await storage.readCurrent()).toBe("first")
            expect(await storage.readDocument("first")).toBeNull()
            expect(access.acquired).toEqual([])
            await workspace.close()
            pending.resolve()
            await vi.advanceTimersByTimeAsync(0)
            await workspace.flush()
            expect(workspace.snapshot.documentId).toBeNull()
            expect(await storage.readCurrent()).toBeNull()
            expect(access.acquired).toEqual([])
            await workspace.dispose()
        } finally {
            pending.resolve()
            vi.useRealTimers()
        }
    })

    it("bounds flush/disposal and never resumes writes after the host revokes its lifetime", async () => {
        vi.useFakeTimers()
        const lifetime = new AbortController()
        const backend = new MemoryStorageBackend({ signal: lifetime.signal })
        const namespace = createExtensionStorage(backend, "builtin.viewer").namespace("viewer")
        const storage = new ReadingStorage(namespace)
        const entered = deferred<void>()
        const pending = deferred<void>()
        const set = namespace.set.bind(namespace)
        namespace.set = async (key, value) => {
            entered.resolve()
            await pending.promise
            await set(key, value)
        }
        const { workspace } = reader(undefined, undefined, {
            storage,
            writeSignal: lifetime.signal,
        })
        try {
            await workspace.open("first")
            await entered.promise
            workspace.setPosition(9, 0.4)
            const flushing = workspace.flush()
            await vi.advanceTimersByTimeAsync(250)
            await flushing
            lifetime.abort()
            const stopping = workspace.dispose()
            await vi.advanceTimersByTimeAsync(250)
            await stopping
            expect(workspace.snapshot).toMatchObject({
                documentId: "first",
                state: { pageNumber: 9 },
            })
            pending.resolve()
            await workspace.flush()
            expect(await storage.readCurrent()).toBeNull()
            expect(await storage.readDocument("first")).toBeNull()
            await expect(workspace.open("second")).resolves.toBe(false)
        } finally {
            pending.resolve()
            vi.useRealTimers()
        }
    })

    it("retains absent and deleted intended references until an explicit close", async () => {
        const storage = new ReadingStorage(readingNamespace())
        await storage.writeCurrent("first")
        const access = fileAccess()
        delete access.files.nodes.first
        const { workspace, current } = reader(access.files, undefined, { storage })
        await workspace.restore()
        expect(workspace.snapshot).toMatchObject({ documentId: "first", status: "missing" })
        expect(current()).toBeNull()
        expect(access.acquired).toEqual([])
        access.files.nodes.first = {
            id: "first",
            name: "Relinked",
            type: "file",
            updatedAt: 1,
            metadata: {},
        }
        await workspace.retry()
        workspace.setPosition(4, 0.2)
        delete access.files.nodes.first
        await workspace.synchronize()
        await workspace.flush()
        expect(workspace.snapshot).toMatchObject({
            documentId: "first",
            status: "missing",
            state: { pageNumber: 4 },
        })
        expect(await storage.readCurrent()).toBe("first")
        await workspace.close()
        await workspace.flush()
        expect(await storage.readCurrent()).toBeNull()
        await workspace.dispose()
    })

    it("does not treat a legacy published Book position as a recovery fallback", async () => {
        let book: Book | null = {
            id: "first",
            name: "Legacy",
            updatedAt: 1,
            pageNumber: 77,
            scrollPosition: 0.8,
        }
        const workspace = new ReadingWorkspace({
            files: fileAccess().files,
            storage: new ReadingStorage(readingNamespace()),
            getCurrentBook: () => book,
            publish: (value) => {
                book = value
            },
            defaults: () => ({ scale: 1.25, layout: "single" }),
        })
        await workspace.synchronize()
        expect(workspace.snapshot.state).toEqual({
            pageNumber: 1,
            scrollPosition: 0,
            scale: 1.25,
            layout: "single",
        })
        expect(book).toMatchObject({ pageNumber: 1, scrollPosition: 0 })
        await workspace.dispose()
    })

    it("drains queued reading changes during orderly disposal without clearing the current reference", async () => {
        const storage = new ReadingStorage(
            createExtensionStorage(new MemoryStorageBackend(), "builtin.viewer").namespace(
                "viewer",
            ),
        )
        const access = fileAccess()
        let book: Book | null = null
        const workspace = new ReadingWorkspace({
            files: access.files,
            storage,
            getCurrentBook: () => book,
            publish: (value) => {
                book = value
            },
        })
        await workspace.open("first")
        workspace.setPosition(9, 0.7)
        workspace.setScale(3)
        await workspace.dispose()
        const restored = new ReadingWorkspace({
            files: fileAccess().files,
            storage,
            getCurrentBook: () => book,
            publish: (value) => {
                book = value
            },
        })
        await restored.restore()
        expect(restored.snapshot).toMatchObject({
            documentId: "first",
            state: { pageNumber: 9, scrollPosition: 0.7, scale: 3 },
        })
        await restored.dispose()
    })

    it("retains unavailable restored identity and reading state for an explicit retry", async () => {
        const storage = new ReadingStorage(
            createExtensionStorage(new MemoryStorageBackend(), "builtin.viewer").namespace(
                "viewer",
            ),
        )
        await storage.writeCurrent("first")
        await storage.writeDocument("first", {
            pageNumber: 8,
            scrollPosition: 0.4,
            scale: 2.5,
            layout: "single",
        })
        const { files } = fileAccess()
        files.getFileUrl = async () => ""
        let book: Book | null = null
        const workspace = new ReadingWorkspace({
            files,
            storage,
            getCurrentBook: () => book,
            publish: (value) => {
                book = value
            },
        })
        await workspace.restore()
        expect(workspace.snapshot).toMatchObject({
            documentId: "first",
            status: "unavailable",
            state: { pageNumber: 8, scale: 2.5 },
        })
        expect(book).toMatchObject({ id: "first", isLocked: true, url: "" })
        files.getFileUrl = async () => "blob:retry"
        await expect(workspace.retry()).resolves.toBe(true)
        expect(workspace.snapshot).toMatchObject({
            documentId: "first",
            status: "ready",
            state: { pageNumber: 8, scale: 2.5 },
        })
        await workspace.dispose()
    })

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

    it("returns the pending document when the same reading session is reopened", async () => {
        const access = fileAccess()
        const real = documentLoader()
        const pending = deferred<void>()
        const entered = deferred<void>()
        const loader: ViewerDocumentLoader = {
            open: async (input, signal) => {
                entered.resolve()
                await pending.promise
                return real.loader.open(input, signal)
            },
        }
        const { workspace, current } = reader(access.files, loader)
        await workspace.open("first")
        const loading = workspace.loadDocument()
        await entered.promise
        await expect(workspace.open("first")).resolves.toBe(true)
        pending.resolve()
        const document = await loading
        expect(document?.kind).toBe("reflowable")
        expect(await workspace.loadDocument()).toBe(document)
        expect(current()).toMatchObject({ id: "first", url: "blob:first" })
        expect(access.acquired).toEqual(["first"])
        expect(real.closed).toEqual([])
        await workspace.dispose()
        await document?.close()
        expect(real.closed).toEqual(["first"])
        expect(real.sources).toEqual(["first"])
        expect(access.released).toEqual(["blob:first"])
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
