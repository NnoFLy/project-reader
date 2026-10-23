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

function noteInput() {
    return {
        pageNumber: 2,
        start: 4,
        end: 11,
        text: "passage",
        noteContent: "My note",
        color: "yellow" as const,
        association: { contentHash: null, verification: "unverified" as const },
    }
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
    const sparseDraftRecords: unknown[] = []
    sparseDraftRecords.length = 1

    it.each(["save", "discard", "cancel"] as const)(
        "requires an explicit %s close decision and prevents low-level bypass",
        async (choice) => {
            const storage = new ReadingStorage(readingNamespace())
            const { workspace, current } = reader(undefined, undefined, { storage })
            await workspace.open("first")
            await workspace.createDraft("first", noteInput())
            await workspace.close()
            expect(current()?.id).toBe("first")
            expect(await workspace.setCurrentBook(null)).toBe(false)
            const request = await workspace.requestClose()
            expect(request.status).toBe("confirmation-required")
            if (request.status !== "confirmation-required") throw new Error("Expected decision")
            expect((await workspace.resolveClose(request.token, choice)).status).toBe(
                choice === "cancel" ? "cancelled" : "closed",
            )
            expect(workspace.snapshot.documentId).toBe(choice === "cancel" ? "first" : null)
            expect(workspace.annotations("first").drafts).toHaveLength(choice === "cancel" ? 1 : 0)
            expect(workspace.annotations("first").notes).toHaveLength(choice === "save" ? 1 : 0)
            await workspace.dispose()
            const recovered = reader(undefined, undefined, { storage }).workspace
            await recovered.restore()
            await recovered.loadDrafts("first")
            expect(recovered.snapshot.documentId).toBe(choice === "cancel" ? "first" : null)
            expect(recovered.annotations("first").drafts).toHaveLength(choice === "cancel" ? 1 : 0)
            await recovered.dispose()
        },
    )

    it.each(["same", "other"] as const)(
        "supersedes a pending save-close after a newer %s document selection",
        async (selection) => {
            const namespace = readingNamespace()
            const storage = new ReadingStorage(namespace)
            const workspace = reader(undefined, undefined, { storage }).workspace
            await workspace.open("first")
            await workspace.createDraft("first", noteInput())
            await workspace.createDraft("second", noteInput())
            const request = await workspace.requestClose()
            if (request.status !== "confirmation-required") throw new Error("Expected decision")
            const pending = deferred<void>()
            const entered = deferred<void>()
            const set = namespace.set.bind(namespace)
            let blocked = false
            namespace.set = async (key, value) => {
                if (!blocked && key.startsWith("reading-v1-annotations-")) {
                    blocked = true
                    entered.resolve()
                    await pending.promise
                }
                await set(key, value)
            }
            const closing = workspace.resolveClose(request.token, "save")
            await entered.promise
            const id = selection === "same" ? "first" : "second"
            await workspace.open(id)
            pending.resolve()
            expect((await closing).status).toBe("superseded")
            expect(workspace.snapshot.documentId).toBe(id)
            expect(workspace.annotations("first").notes).toHaveLength(1)
            expect(workspace.annotations("first").drafts).toEqual([])
            expect(workspace.annotations("second").drafts).toHaveLength(1)
            await workspace.dispose()
        },
    )

    it.each(["before", "during"] as const)(
        "does not drop changed drafts %s close save",
        async (when) => {
            const namespace = readingNamespace()
            const storage = new ReadingStorage(namespace)
            const workspace = reader(undefined, undefined, { storage }).workspace
            await workspace.open("first")
            const created = await workspace.createDraft("first", noteInput())
            if (!created.ok) throw new Error("Expected draft")
            const request = await workspace.requestClose()
            if (request.status !== "confirmation-required") throw new Error("Expected decision")
            if (when === "before") {
                await workspace.updateDraft("first", created.value.id, {
                    noteContent: "Newer",
                    color: "blue",
                })
                expect((await workspace.resolveClose(request.token, "save")).status).toBe("changed")
            } else {
                const pending = deferred<void>()
                const entered = deferred<void>()
                const set = namespace.set.bind(namespace)
                let blocked = false
                namespace.set = async (key, value) => {
                    if (!blocked && key.startsWith("reading-v1-annotations-")) {
                        blocked = true
                        entered.resolve()
                        await pending.promise
                    }
                    await set(key, value)
                }
                const closing = workspace.resolveClose(request.token, "save")
                await entered.promise
                const editing = workspace.updateDraft("first", created.value.id, {
                    noteContent: "Newer",
                    color: "blue",
                })
                pending.resolve()
                expect((await closing).status).toBe("changed")
                await editing
            }
            expect(workspace.snapshot.documentId).toBe("first")
            expect(workspace.annotations("first").drafts).toMatchObject([
                { noteContent: "Newer", color: "blue" },
            ])
            await workspace.dispose()
            const recovered = reader(undefined, undefined, { storage }).workspace
            await recovered.loadDrafts("first")
            expect(recovered.annotations("first").drafts).toMatchObject([{ noteContent: "Newer" }])
            await recovered.dispose()
        },
    )

    it.each([
        { drafts: [null] },
        { drafts: sparseDraftRecords },
        { drafts: "private" },
        { drafts: Array.from({ length: 10_001 }) },
        { draft: { id: "../invalid" } },
        { draft: { bookId: "second" } },
        { draft: { start: -1 } },
        { draft: { end: 3 } },
        { draft: { pageNumber: Infinity } },
        { draft: { noteContent: null } },
        { draft: { text: {} } },
        { draft: { color: "<script>private</script>" } },
        { draft: { association: { contentHash: "blob:private", verification: "unverified" } } },
        { draft: { association: { contentHash: null, verification: "verified" } } },
        { duplicate: true },
    ])(
        "rejects malformed, sparse or untrusted recovered draft records without text feedback (%#)",
        async (invalid) => {
            const namespace = readingNamespace()
            const draft = {
                ...noteInput(),
                id: "draft-1",
                bookId: "first",
                createdAt: 1,
                ...invalid.draft,
            }
            namespace.get = async <T>(): Promise<T | undefined> =>
                ({
                    version: 1,
                    documentId: "first",
                    notes: [],
                    bookmarks: [],
                    drafts: invalid.duplicate ? [draft, draft] : (invalid.drafts ?? [draft]),
                }) as T
            const errors: ReadingStorageError[] = []
            const workspace = reader(undefined, undefined, {
                storage: new ReadingStorage(namespace),
                onStorageError: (error) => errors.push(error),
            }).workspace
            expect(await workspace.loadDrafts("first")).toBe(false)
            expect(workspace.annotations("first")).toMatchObject({
                loaded: false,
                drafts: [],
                error: "reading.storage.read",
            })
            expect(errors.map((error) => error.message)).toEqual(["Unable to load reading state"])
            await workspace.dispose()
        },
    )

    it("does not duplicate a promoted note when a committed save reports failure and is retried", async () => {
        const namespace = readingNamespace()
        const storage = new ReadingStorage(namespace)
        const workspace = reader(undefined, undefined, { storage }).workspace
        const created = await workspace.createDraft("first", noteInput())
        if (!created.ok) throw new Error("Expected draft")
        const set = namespace.set.bind(namespace)
        namespace.set = async (key, value) => {
            await set(key, value)
            throw new Error("private")
        }
        expect((await workspace.saveDraft("first", created.value.id)).ok).toBe(false)
        expect(workspace.annotations("first").drafts).toHaveLength(1)
        namespace.set = set
        expect((await workspace.saveDraft("first", created.value.id)).ok).toBe(true)
        await workspace.dispose()
        const recovered = reader(undefined, undefined, { storage }).workspace
        await recovered.loadDrafts("first")
        expect(recovered.annotations("first").drafts).toEqual([])
        expect(recovered.annotations("first").notes).toMatchObject([{ id: created.value.id }])
        await recovered.dispose()
    })

    it("does not close after the host revokes write ownership during close persistence", async () => {
        const lifetime = new AbortController()
        const namespace = readingNamespace()
        const storage = new ReadingStorage(namespace)
        const workspace = reader(undefined, undefined, {
            storage,
            writeSignal: lifetime.signal,
        }).workspace
        await workspace.open("first")
        await workspace.flush()
        const remove = namespace.delete.bind(namespace)
        namespace.delete = async (key) => {
            await remove(key)
            lifetime.abort()
        }
        expect((await workspace.requestClose()).status).toBe("failed")
        expect(workspace.snapshot.documentId).toBe("first")
        await workspace.dispose()
    })

    it("recovers only the last successful draft write while retaining failed new drafts in memory", async () => {
        const namespace = readingNamespace()
        const storage = new ReadingStorage(namespace)
        const workspace = reader(undefined, undefined, { storage }).workspace
        const persisted = await workspace.createDraft("first", noteInput())
        if (!persisted.ok) throw new Error("Expected draft")
        namespace.set = async () => {
            throw new Error("private")
        }
        const unsaved = await workspace.createDraft("first", {
            ...noteInput(),
            noteContent: "Only in memory",
        })
        expect(unsaved.ok).toBe(false)
        expect(workspace.annotations("first")).toMatchObject({
            dirty: true,
            drafts: [
                { id: persisted.value.id },
                { id: unsaved.value?.id, noteContent: "Only in memory" },
            ],
        })
        const recovered = reader(undefined, undefined, { storage }).workspace
        await recovered.loadDrafts("first")
        expect(recovered.annotations("first").drafts).toHaveLength(1)
        expect(recovered.annotations("first").drafts[0].id).toBe(persisted.value.id)
        await Promise.all([workspace.dispose(), recovered.dispose()])
    })

    it("preserves draft memory while the host fences a delayed write after writer abort", async () => {
        const lifetime = new AbortController()
        const backend = new MemoryStorageBackend({ signal: lifetime.signal })
        const namespace = createExtensionStorage(backend, "builtin.viewer").namespace("viewer")
        const pending = deferred<void>()
        const entered = deferred<void>()
        const set = namespace.set.bind(namespace)
        namespace.set = async (key, value) => {
            entered.resolve()
            await pending.promise
            await set(key, value)
        }
        const storage = new ReadingStorage(namespace)
        const workspace = reader(undefined, undefined, {
            storage,
            writeSignal: lifetime.signal,
        }).workspace
        const creating = workspace.createDraft("first", noteInput())
        await entered.promise
        lifetime.abort()
        pending.resolve()
        expect((await creating).ok).toBe(false)
        expect(workspace.annotations("first")).toMatchObject({
            dirty: true,
            drafts: [{ noteContent: "My note" }],
        })
        await workspace.dispose()
        const recovered = reader(undefined, undefined, { storage }).workspace
        await recovered.loadDrafts("first")
        expect(recovered.annotations("first").drafts).toEqual([])
        await recovered.dispose()
    })

    it("keeps the reader open if persisting explicit close fails", async () => {
        const namespace = readingNamespace()
        const storage = new ReadingStorage(namespace)
        const workspace = reader(undefined, undefined, { storage }).workspace
        await workspace.open("first")
        await workspace.flush()
        namespace.delete = async () => {
            throw new Error("private")
        }
        expect((await workspace.requestClose()).status).toBe("failed")
        expect(workspace.snapshot.documentId).toBe("first")
        await workspace.dispose()
    })

    it.each(["draft", "selection"] as const)(
        "rechecks %s changes during the final close write and repairs the persisted selection",
        async (change) => {
            const namespace = readingNamespace()
            const storage = new ReadingStorage(namespace)
            const workspace = reader(undefined, undefined, { storage }).workspace
            await workspace.open("first")
            await workspace.createDraft("first", noteInput())
            const request = await workspace.requestClose()
            if (request.status !== "confirmation-required") throw new Error("Expected decision")
            const pending = deferred<void>()
            const entered = deferred<void>()
            const remove = namespace.delete.bind(namespace)
            namespace.delete = async (key) => {
                entered.resolve()
                await pending.promise
                await remove(key)
            }
            const closing = workspace.resolveClose(request.token, "save")
            await entered.promise
            const changing =
                change === "draft"
                    ? workspace.createDraft("first", { ...noteInput(), noteContent: "New work" })
                    : workspace.open("second")
            pending.resolve()
            expect((await closing).status).toBe(change === "draft" ? "changed" : "superseded")
            await changing
            expect(workspace.snapshot.documentId).toBe(change === "draft" ? "first" : "second")
            await workspace.flush()
            await workspace.dispose()
            const recovered = reader(undefined, undefined, { storage }).workspace
            await recovered.restore()
            expect(recovered.snapshot.documentId).toBe(change === "draft" ? "first" : "second")
            await recovered.loadDrafts("first")
            expect(recovered.annotations("first").drafts).toHaveLength(change === "draft" ? 1 : 0)
            await recovered.dispose()
        },
    )

    it("bounds close persistence, leaves work open and never completes a timed-out close later", async () => {
        vi.useFakeTimers()
        const namespace = readingNamespace()
        const storage = new ReadingStorage(namespace)
        const workspace = reader(undefined, undefined, { storage }).workspace
        try {
            await workspace.open("first")
            await workspace.flush()
            const pending = deferred<void>()
            const entered = deferred<void>()
            const remove = namespace.delete.bind(namespace)
            namespace.delete = async (key) => {
                entered.resolve()
                await pending.promise
                await remove(key)
            }
            const closing = workspace.requestClose()
            await entered.promise
            await vi.advanceTimersByTimeAsync(250)
            expect((await closing).status).toBe("failed")
            expect(workspace.snapshot.documentId).toBe("first")
            pending.resolve()
            await vi.advanceTimersByTimeAsync(0)
            await workspace.flush()
            expect(workspace.snapshot.documentId).toBe("first")
            await workspace.dispose()
            const recovered = reader(undefined, undefined, { storage }).workspace
            await recovered.restore()
            expect(recovered.snapshot.documentId).toBe("first")
            await recovered.dispose()
        } finally {
            vi.useRealTimers()
        }
    })

    it("preserves independent drafts through every existing saved-note and bookmark mutation", async () => {
        const storage = new ReadingStorage(readingNamespace())
        const workspace = reader(undefined, undefined, { storage }).workspace
        await workspace.createDraft("first", noteInput())
        const note = await workspace.createNote("first", noteInput())
        if (!note.ok) throw new Error("Expected note")
        await workspace.updateNote("first", note.value.id, { noteContent: "Saved", color: "green" })
        await workspace.deleteNote("first", note.value.id)
        const bookmark = await workspace.createBookmark("first", {
            pageNumber: 1,
            name: "Bookmark",
            association: noteInput().association,
        })
        if (!bookmark.ok) throw new Error("Expected bookmark")
        await workspace.updateBookmark("first", bookmark.value.id, "Edited")
        await workspace.deleteBookmark("first", bookmark.value.id)
        expect(workspace.annotations("first").drafts).toMatchObject([{ noteContent: "My note" }])
        await workspace.dispose()
        const recovered = reader(undefined, undefined, { storage }).workspace
        await recovered.loadDrafts("first")
        expect(recovered.annotations("first").drafts).toMatchObject([{ noteContent: "My note" }])
        await recovered.dispose()
    })

    it("keeps delayed draft hydration in admission order, captures input and never lets a stale load overwrite discard", async () => {
        const namespace = readingNamespace()
        const storage = new ReadingStorage(namespace)
        const seed = reader(undefined, undefined, { storage }).workspace
        const created = await seed.createDraft("first", noteInput())
        if (!created.ok) throw new Error("Expected draft")
        await seed.dispose()
        const pending = deferred<void>()
        const entered = deferred<void>()
        const get = namespace.get.bind(namespace)
        let blocked = false
        namespace.get = async <T>(key: string): Promise<T | undefined> => {
            const value = await get<T>(key)
            if (!blocked && key.startsWith("reading-v1-annotations-")) {
                blocked = true
                entered.resolve()
                await pending.promise
            }
            return value
        }
        const workspace = reader(undefined, undefined, { storage }).workspace
        const changes = { noteContent: "Earlier", color: "pink" as const }
        const earlier = workspace.updateDraft("first", created.value.id, changes)
        await entered.promise
        changes.noteContent = "Not captured"
        const later = workspace.updateDraft("first", created.value.id, {
            noteContent: "Later",
            color: "blue",
        })
        await workspace.open("second")
        // This independent reader load may publish before the shared mutation hydration.
        expect(await workspace.loadDrafts("first")).toBe(true)
        pending.resolve()
        const [first, last] = await Promise.all([earlier, later])
        expect(first.value?.noteContent).toBe("Earlier")
        expect(last.value?.noteContent).toBe("Later")
        expect(workspace.annotations("first").drafts).toMatchObject([{ noteContent: "Later" }])
        expect(workspace.annotations("second").drafts).toEqual([])
        await workspace.dispose()
        const recovered = reader(undefined, undefined, { storage }).workspace
        await recovered.loadDrafts("first")
        expect(recovered.annotations("first").drafts).toMatchObject([{ noteContent: "Later" }])
        await recovered.dispose()
    })

    it("does not let a stale independent draft load restore explicitly discarded work", async () => {
        const namespace = readingNamespace()
        const storage = new ReadingStorage(namespace)
        const seed = reader(undefined, undefined, { storage }).workspace
        const created = await seed.createDraft("first", noteInput())
        if (!created.ok) throw new Error("Expected draft")
        await seed.dispose()
        const pending = deferred<void>()
        const entered = deferred<void>()
        const get = namespace.get.bind(namespace)
        let blocked = false
        namespace.get = async <T>(key: string): Promise<T | undefined> => {
            const value = await get<T>(key)
            if (!blocked) {
                blocked = true
                entered.resolve()
                await pending.promise
            }
            return value
        }
        const workspace = reader(undefined, undefined, { storage }).workspace
        const loading = workspace.loadDrafts("first")
        await entered.promise
        expect((await workspace.discardDraft("first", created.value.id)).ok).toBe(true)
        pending.resolve()
        await loading
        expect(workspace.annotations("first").drafts).toEqual([])
        await workspace.dispose()
    })

    it("isolates draft work by owning workspace and fences pending hydration after writer abort", async () => {
        const storage = new ReadingStorage(readingNamespace())
        const other = reader(undefined, undefined, {
            storage: new ReadingStorage(readingNamespace()),
        }).workspace
        const seed = reader(undefined, undefined, { storage }).workspace
        await seed.createDraft("first", noteInput())
        await other.loadDrafts("first")
        expect(other.annotations("first").drafts).toEqual([])
        await seed.dispose()
        const namespace = readingNamespace()
        const lifetime = new AbortController()
        const pending = deferred<void>()
        const entered = deferred<void>()
        namespace.get = async () => {
            entered.resolve()
            await pending.promise
            return undefined
        }
        const workspace = reader(undefined, undefined, {
            storage: new ReadingStorage(namespace),
            writeSignal: lifetime.signal,
        }).workspace
        const creating = workspace.createDraft("first", noteInput())
        await entered.promise
        lifetime.abort()
        pending.resolve()
        expect((await creating).ok).toBe(false)
        expect((await workspace.createDraft("first", noteInput())).ok).toBe(false)
        expect(workspace.annotations("first").drafts).toEqual([])
        await Promise.all([workspace.dispose(), other.dispose()])
    })

    it("does not resurrect a draft when an older write completes after discard", async () => {
        const namespace = readingNamespace()
        const storage = new ReadingStorage(namespace)
        const workspace = reader(undefined, undefined, { storage }).workspace
        const created = await workspace.createDraft("first", noteInput())
        if (!created.ok) throw new Error("Expected draft")
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
        const editing = workspace.updateDraft("first", created.value.id, {
            noteContent: "Older",
            color: "blue",
        })
        await entered.promise
        const discarded = workspace.discardDraft("first", created.value.id)
        await workspace.open("second")
        pending.resolve()
        expect((await editing).ok).toBe(true)
        expect((await discarded).ok).toBe(true)
        await workspace.dispose()
        const recovered = reader(undefined, undefined, { storage }).workspace
        await recovered.loadDrafts("first")
        expect(recovered.annotations("first").drafts).toEqual([])
        await recovered.dispose()
    })

    it("abandons a pending draft promotion after individual discard without losing other edits", async () => {
        const namespace = readingNamespace()
        const storage = new ReadingStorage(namespace)
        const workspace = reader(undefined, undefined, { storage }).workspace
        const saved = await workspace.createNote("first", {
            ...noteInput(),
            noteContent: "Existing note",
        })
        const abandoned = await workspace.createDraft("first", noteInput())
        const retained = await workspace.createDraft("first", {
            ...noteInput(),
            noteContent: "Retained draft",
        })
        if (!saved.ok || !abandoned.ok || !retained.ok) throw new Error("Expected annotations")
        const pending = deferred<void>()
        const entered = deferred<void>()
        const discardedInMemory = deferred<void>()
        const set = namespace.set.bind(namespace)
        let blocked = false
        namespace.set = async (key, value) => {
            if (!blocked && key.startsWith("reading-v1-annotations-")) {
                blocked = true
                entered.resolve()
                await pending.promise
            }
            await set(key, value)
        }
        const unsubscribe = workspace.subscribeAnnotations((id, state) => {
            if (id === "first" && !state.drafts.some((draft) => draft.id === abandoned.value.id))
                discardedInMemory.resolve()
        })
        try {
            const saving = workspace.saveDraft("first", abandoned.value.id)
            await entered.promise
            const discarding = workspace.discardDraft("first", abandoned.value.id)
            await discardedInMemory.promise
            const editing = workspace.updateDraft("first", retained.value.id, {
                noteContent: "Newer draft edit",
                color: "purple",
            })
            const updating = workspace.updateNote("first", saved.value.id, {
                noteContent: "Newer saved-note edit",
                color: "blue",
            })
            pending.resolve()
            await saving
            expect((await discarding).ok).toBe(true)
            expect((await editing).ok).toBe(true)
            expect((await updating).ok).toBe(true)
            const expected = {
                notes: [
                    expect.objectContaining({
                        id: saved.value.id,
                        noteContent: "Newer saved-note edit",
                    }),
                ],
                drafts: [
                    expect.objectContaining({
                        id: retained.value.id,
                        noteContent: "Newer draft edit",
                        color: "purple",
                    }),
                ],
            }
            expect(workspace.annotations("first")).toMatchObject(expected)
            await workspace.dispose()
            const recovered = reader(undefined, undefined, { storage }).workspace
            try {
                expect(await recovered.loadDrafts("first")).toBe(true)
                expect(recovered.annotations("first")).toMatchObject(expected)
            } finally {
                await recovered.dispose()
            }
        } finally {
            pending.resolve()
            unsubscribe()
            await workspace.dispose()
        }
    })

    it("abandons a pending draft promotion after close-discard and preserves newer saved-note edits", async () => {
        const namespace = readingNamespace()
        const storage = new ReadingStorage(namespace)
        const workspace = reader(undefined, undefined, { storage }).workspace
        await workspace.open("first")
        const saved = await workspace.createNote("first", {
            ...noteInput(),
            noteContent: "Existing note",
        })
        const abandoned = await workspace.createDraft("first", noteInput())
        if (!saved.ok || !abandoned.ok) throw new Error("Expected annotations")
        await workspace.flush()
        const pending = deferred<void>()
        const entered = deferred<void>()
        const discardedInMemory = deferred<void>()
        const set = namespace.set.bind(namespace)
        let blocked = false
        namespace.set = async (key, value) => {
            if (!blocked && key.startsWith("reading-v1-annotations-")) {
                blocked = true
                entered.resolve()
                await pending.promise
            }
            await set(key, value)
        }
        const unsubscribe = workspace.subscribeAnnotations((id, state) => {
            if (id === "first" && state.drafts.length === 0) discardedInMemory.resolve()
        })
        try {
            const saving = workspace.saveDraft("first", abandoned.value.id)
            await entered.promise
            const request = await workspace.requestClose()
            if (request.status !== "confirmation-required") throw new Error("Expected decision")
            const closing = workspace.resolveClose(request.token, "discard")
            await discardedInMemory.promise
            const editing = workspace.updateNote("first", saved.value.id, {
                noteContent: "Newer saved-note edit",
                color: "blue",
            })
            pending.resolve()
            await saving
            expect((await closing).status).toBe("closed")
            expect((await editing).ok).toBe(true)
            const expected = {
                notes: [
                    expect.objectContaining({
                        id: saved.value.id,
                        noteContent: "Newer saved-note edit",
                    }),
                ],
                drafts: [],
            }
            expect(workspace.snapshot.documentId).toBeNull()
            expect(workspace.annotations("first")).toMatchObject(expected)
            await workspace.dispose()
            const recovered = reader(undefined, undefined, { storage }).workspace
            try {
                await recovered.restore()
                expect(await recovered.loadDrafts("first")).toBe(true)
                expect(recovered.snapshot.documentId).toBeNull()
                expect(recovered.annotations("first")).toMatchObject(expected)
            } finally {
                await recovered.dispose()
            }
        } finally {
            pending.resolve()
            unsubscribe()
            await workspace.dispose()
        }
    })

    it("keeps edits made during atomic draft save and merges later notes without duplicating retry identity", async () => {
        const namespace = readingNamespace()
        const storage = new ReadingStorage(namespace)
        const workspace = reader(undefined, undefined, { storage }).workspace
        const created = await workspace.createDraft("first", noteInput())
        if (!created.ok) throw new Error("Expected draft")
        const pending = deferred<void>()
        const entered = deferred<void>()
        const set = namespace.set.bind(namespace)
        let blocked = false
        namespace.set = async (key, value) => {
            if (!blocked && key.startsWith("reading-v1-annotations-")) {
                blocked = true
                entered.resolve()
                await pending.promise
            }
            await set(key, value)
        }
        const saving = workspace.saveDraft("first", created.value.id)
        await entered.promise
        const editing = workspace.updateDraft("first", created.value.id, {
            noteContent: "Newer",
            color: "purple",
        })
        const adding = workspace.createNote("first", {
            ...noteInput(),
            noteContent: "Separate saved note",
        })
        pending.resolve()
        expect((await saving).ok).toBe(true)
        expect((await editing).ok).toBe(true)
        expect((await adding).ok).toBe(true)
        expect(workspace.annotations("first").drafts).toMatchObject([{ noteContent: "Newer" }])
        expect((await workspace.saveDraft("first", created.value.id)).ok).toBe(true)
        await workspace.dispose()
        const recovered = reader(undefined, undefined, { storage }).workspace
        await recovered.loadDrafts("first")
        expect(recovered.annotations("first").drafts).toEqual([])
        expect(recovered.annotations("first").notes).toHaveLength(2)
        expect(recovered.annotations("first").notes).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    id: created.value.id,
                    noteContent: "Newer",
                    color: "purple",
                }),
                expect.objectContaining({ noteContent: "Separate saved note" }),
            ]),
        )
        await recovered.dispose()
    })

    it.each(["save", "discard"] as const)(
        "keeps the document open on failed close %s and permits an explicit discard retry",
        async (choice) => {
            const namespace = readingNamespace()
            const storage = new ReadingStorage(namespace)
            const workspace = reader(undefined, undefined, { storage }).workspace
            await workspace.open("first")
            await workspace.createDraft("first", noteInput())
            await workspace.createDraft("second", noteInput())
            const request = await workspace.requestClose()
            if (request.status !== "confirmation-required") throw new Error("Expected decision")
            const set = namespace.set.bind(namespace)
            namespace.set = async () => {
                throw new Error("private")
            }
            expect((await workspace.resolveClose(request.token, choice)).status).toBe("failed")
            expect(workspace.snapshot.documentId).toBe("first")
            expect(workspace.annotations("first").dirty).toBe(true)
            expect(workspace.annotations("first").drafts).toHaveLength(choice === "save" ? 1 : 0)
            namespace.set = set
            const retry = await workspace.requestClose()
            const result =
                retry.status === "confirmation-required"
                    ? await workspace.resolveClose(retry.token, "discard")
                    : retry
            expect(result.status).toBe("closed")
            expect(workspace.annotations("first").drafts).toEqual([])
            expect(workspace.annotations("second").drafts).toHaveLength(1)
            await workspace.dispose()
        },
    )

    it("does not close a newer document whose selection was already loading when close was requested", async () => {
        const storage = new ReadingStorage(readingNamespace())
        const access = fileAccess()
        const pending = deferred<string>()
        access.files.getFileUrl = (id) =>
            id === "second" ? pending.promise : Promise.resolve(`blob:${id}`)
        const workspace = reader(access.files, undefined, { storage }).workspace
        await workspace.open("first")
        await workspace.createDraft("first", noteInput())
        const opening = workspace.open("second")
        const request = await workspace.requestClose()
        if (request.status !== "confirmation-required") throw new Error("Expected decision")
        pending.resolve("blob:second")
        await opening
        expect((await workspace.resolveClose(request.token, "discard")).status).toBe("superseded")
        expect(workspace.snapshot.documentId).toBe("second")
        expect(workspace.annotations("first").drafts).toEqual([])
        await workspace.dispose()
    })

    it("atomically saves a recovered draft using stable note identity and preserves unverified association on retries", async () => {
        const namespace = readingNamespace()
        const storage = new ReadingStorage(namespace)
        const seed = reader(undefined, undefined, { storage }).workspace
        const created = await seed.createDraft("first", {
            ...noteInput(),
            association: { contentHash: "a".repeat(64), verification: "unverified" },
        })
        if (!created.ok) throw new Error("Expected draft")
        await seed.dispose()
        const workspace = reader(undefined, undefined, { storage }).workspace
        await workspace.loadDrafts("first")
        const set = namespace.set.bind(namespace)
        namespace.set = async () => {
            throw new Error("private")
        }
        expect((await workspace.saveDraft("first", created.value.id)).ok).toBe(false)
        expect(workspace.annotations("first").drafts).toHaveLength(1)
        expect(workspace.annotations("first").notes).toHaveLength(0)
        namespace.set = set
        expect((await workspace.saveDraft("first", created.value.id)).ok).toBe(true)
        expect(workspace.annotations("first").drafts).toEqual([])
        expect(workspace.annotations("first").notes).toMatchObject([
            {
                id: created.value.id,
                association: { contentHash: "a".repeat(64), verification: "unverified" },
            },
        ])
        await workspace.dispose()
        const recovered = reader(undefined, undefined, { storage }).workspace
        await recovered.loadAnnotations("first")
        expect(recovered.annotations("first").drafts).toEqual([])
        expect(recovered.annotations("first").notes).toHaveLength(1)
        await recovered.dispose()
    })

    it("retains dirty draft edits on safe persistence failures, retries and explicitly discards without resources", async () => {
        const namespace = readingNamespace()
        const storage = new ReadingStorage(namespace)
        const errors: ReadingStorageError[] = []
        const access = fileAccess()
        const workspace = reader(access.files, undefined, {
            storage,
            onStorageError: (error) => errors.push(error),
        }).workspace
        const created = await workspace.createDraft("first", noteInput())
        if (!created.ok) throw new Error("Expected draft")
        const set = namespace.set.bind(namespace)
        namespace.set = async () => {
            throw new Error("private text")
        }
        delete access.files.nodes.first
        workspace.invalidateAnnotations("first")
        const edited = await workspace.updateDraft("first", created.value.id, {
            noteContent: "Retained",
            color: "blue",
        })
        expect(edited.ok).toBe(false)
        expect(workspace.annotations("first")).toMatchObject({
            dirty: true,
            error: "reading.storage.write",
            drafts: [{ id: created.value.id, noteContent: "Retained", color: "blue" }],
        })
        expect(errors.map((error) => error.message)).toEqual(["Unable to save reading state"])
        namespace.set = set
        expect((await workspace.persistDrafts("first")).ok).toBe(true)
        await workspace.dispose()
        const recovered = reader(access.files, undefined, { storage }).workspace
        await recovered.loadDrafts("first")
        expect(recovered.annotations("first").drafts).toMatchObject([
            { noteContent: "Retained", color: "blue" },
        ])
        expect((await recovered.discardDraft("first", created.value.id)).ok).toBe(true)
        await recovered.dispose()
        const empty = reader(access.files, undefined, { storage }).workspace
        await empty.loadDrafts("first")
        expect(empty.annotations("first").drafts).toEqual([])
        await empty.dispose()
    })

    it("recovers independent Note drafts across switches and unloaded document resources without saving notes", async () => {
        const storage = new ReadingStorage(readingNamespace())
        const workspace = reader(undefined, undefined, { storage }).workspace
        await workspace.open("first")
        const first = await workspace.createDraft("first", noteInput())
        const second = await workspace.createDraft("first", {
            ...noteInput(),
            start: 20,
            end: 25,
            text: "other",
            noteContent: "Independent",
            color: "pink",
        })
        await workspace.open("second")
        await workspace.createDraft("second", { ...noteInput(), noteContent: "Second document" })
        expect(first.ok && second.ok && first.value.id !== second.value.id).toBe(true)
        await workspace.dispose()
        const access = fileAccess()
        delete access.files.nodes.first
        const recovered = reader(access.files, undefined, { storage }).workspace
        expect(await recovered.loadDrafts("first")).toBe(true)
        expect(recovered.annotations("first").drafts).toMatchObject([
            {
                id: first.value?.id,
                start: 4,
                end: 11,
                text: "passage",
                noteContent: "My note",
                color: "yellow",
            },
            {
                id: second.value?.id,
                start: 20,
                end: 25,
                text: "other",
                noteContent: "Independent",
                color: "pink",
            },
        ])
        expect(recovered.annotations("first").notes).toEqual([])
        await recovered.loadDrafts("second")
        expect(recovered.annotations("second").drafts).toMatchObject([
            { noteContent: "Second document" },
        ])
        await recovered.dispose()
    })

    it("persists a new passage note under stable document identity across workspace reconstruction", async () => {
        const storage = new ReadingStorage(readingNamespace())
        const workspace = reader(undefined, undefined, { storage }).workspace
        const saved = await workspace.createNote("first", {
            pageNumber: 2,
            start: 4,
            end: 11,
            text: "passage",
            noteContent: "My note",
            color: "yellow",
            association: { contentHash: null, verification: "unverified" },
        })
        expect(saved.ok).toBe(true)
        await workspace.close()
        await workspace.dispose()
        const restored = reader(undefined, undefined, { storage }).workspace
        await restored.loadAnnotations("first")
        expect(restored.annotations("first").notes).toMatchObject([
            {
                bookId: "first",
                pageNumber: 2,
                start: 4,
                end: 11,
                text: "passage",
                noteContent: "My note",
                color: "yellow",
                association: { contentHash: null, verification: "unverified" },
            },
        ])
        await restored.dispose()
    })

    it("retains edited notes after reopen and durably deletes them", async () => {
        const storage = new ReadingStorage(readingNamespace())
        const workspace = reader(undefined, undefined, { storage }).workspace
        const saved = await workspace.createNote("first", noteInput())
        if (!saved.ok) throw new Error("Expected saved note")
        expect(
            (
                await workspace.updateNote("first", saved.value.id, {
                    noteContent: "Edited",
                    color: "blue",
                })
            ).ok,
        ).toBe(true)
        await workspace.dispose()
        const reopened = reader(undefined, undefined, { storage }).workspace
        await reopened.loadAnnotations("first")
        expect(reopened.annotations("first").notes).toMatchObject([
            { noteContent: "Edited", color: "blue" },
        ])
        expect((await reopened.deleteNote("first", saved.value.id)).ok).toBe(true)
        await reopened.dispose()
        const recovered = reader(undefined, undefined, { storage }).workspace
        await recovered.loadAnnotations("first")
        expect(recovered.annotations("first").notes).toEqual([])
        await recovered.dispose()
    })

    it("durably creates, edits and deletes document-linked bookmarks independently of notes", async () => {
        const storage = new ReadingStorage(readingNamespace())
        const workspace = reader(undefined, undefined, { storage }).workspace
        await workspace.createNote("first", noteInput())
        const saved = await workspace.createBookmark("first", {
            pageNumber: 8,
            name: "Remember",
            association: { contentHash: null, verification: "unverified" },
        })
        if (!saved.ok) throw new Error("Expected saved bookmark")
        expect((await workspace.updateBookmark("first", saved.value.id, "Renamed")).ok).toBe(true)
        await workspace.dispose()
        const reopened = reader(undefined, undefined, { storage }).workspace
        await reopened.loadAnnotations("first")
        expect(reopened.annotations("first").bookmarks).toMatchObject([
            { bookId: "first", pageNumber: 8, name: "Renamed" },
        ])
        expect((await reopened.deleteBookmark("first", saved.value.id)).ok).toBe(true)
        await reopened.dispose()
        const recovered = reader(undefined, undefined, { storage }).workspace
        await recovered.loadAnnotations("first")
        expect(recovered.annotations("first").bookmarks).toEqual([])
        expect(recovered.annotations("first").notes).toHaveLength(1)
        await recovered.dispose()
    })

    it("does not let an older annotation load hide a completed write", async () => {
        const namespace = readingNamespace()
        const pending = deferred<void>()
        const entered = deferred<void>()
        const get = namespace.get.bind(namespace)
        let blocked = false
        namespace.get = async <T>(key: string): Promise<T | undefined> => {
            const value = await get<T>(key)
            if (!blocked && key.startsWith("reading-v1-annotations-")) {
                blocked = true
                entered.resolve()
                await pending.promise
            }
            return value
        }
        const workspace = reader(undefined, undefined, {
            storage: new ReadingStorage(namespace),
        }).workspace
        const loading = workspace.loadAnnotations("first")
        await entered.promise
        expect((await workspace.createNote("first", noteInput())).ok).toBe(true)
        pending.resolve()
        await loading
        expect(workspace.annotations("first").notes).toMatchObject([{ noteContent: "My note" }])
        await workspace.dispose()
    })

    it("publishes immutable per-document annotation snapshots and reading summaries", async () => {
        const workspace = reader(undefined, undefined, {
            storage: new ReadingStorage(readingNamespace()),
        }).workspace
        const changes: string[] = []
        const unsubscribe = workspace.subscribeAnnotations((id) => changes.push(id))
        await workspace.createNote("first", noteInput())
        const before = workspace.annotations("first")
        const note = before.notes[0]
        await workspace.updateNote("first", note.id, { noteContent: "New", color: "green" })
        expect(before.notes[0].noteContent).toBe("My note")
        expect(Object.isFrozen(before)).toBe(true)
        expect(Object.isFrozen(before.notes)).toBe(true)
        expect(Object.isFrozen(note)).toBe(true)
        expect(Object.isFrozen(note.association)).toBe(true)
        expect(changes).toContain("first")
        expect(await workspace.getReadingSummary("first")).toEqual({
            documentId: "first",
            noteCount: 1,
            bookmarkCount: 0,
        })
        expect(workspace.annotations("first")).toMatchObject({
            loaded: true,
            dirty: false,
            error: null,
        })
        unsubscribe()
        const count = changes.length
        await workspace.createNote("second", noteInput())
        expect(changes).toHaveLength(count)
        await workspace.dispose()
    })

    it("returns safe failed-save feedback and lets recoverable in-memory edits and deletions be retried", async () => {
        const namespace = readingNamespace()
        const set = namespace.set.bind(namespace)
        let failing = true
        namespace.set = async (key, value) => {
            if (failing) throw new Error("private passage and stack")
            return set(key, value)
        }
        const errors: ReadingStorageError[] = []
        const storage = new ReadingStorage(namespace)
        const workspace = reader(undefined, undefined, {
            storage,
            onStorageError: (error) => errors.push(error),
        }).workspace
        const failed = await workspace.createNote("first", noteInput())
        expect(failed).toMatchObject({
            ok: false,
            error: { code: "reading.storage.write", message: "Unable to save reading state" },
            value: { noteContent: "My note" },
        })
        expect(workspace.annotations("first")).toMatchObject({
            dirty: true,
            error: "reading.storage.write",
            notes: [{ noteContent: "My note" }],
        })
        failing = false
        expect((await workspace.saveAnnotations("first")).ok).toBe(true)
        const noteId = workspace.annotations("first").notes[0].id
        failing = true
        expect((await workspace.deleteNote("first", noteId)).ok).toBe(false)
        expect(workspace.annotations("first")).toMatchObject({ dirty: true, notes: [] })
        failing = false
        expect((await workspace.saveAnnotations("first")).ok).toBe(true)
        expect(
            errors.every(
                (error) => !error.message.includes("private") && error.cause === undefined,
            ),
        ).toBe(true)
        await workspace.dispose()
        const recovered = reader(undefined, undefined, { storage }).workspace
        await recovered.loadAnnotations("first")
        expect(recovered.annotations("first").notes).toEqual([])
        await recovered.dispose()
    })

    it("rejects annotation mutations after disposal and fences a pending load", async () => {
        const namespace = readingNamespace()
        const get = namespace.get.bind(namespace)
        const pending = deferred<void>()
        const entered = deferred<void>()
        namespace.get = async <T>(key: string): Promise<T | undefined> => {
            const value = await get<T>(key)
            entered.resolve()
            await pending.promise
            return value
        }
        const workspace = reader(undefined, undefined, {
            storage: new ReadingStorage(namespace),
        }).workspace
        const events: string[] = []
        workspace.subscribeAnnotations((id) => events.push(id))
        const creating = workspace.createNote("first", noteInput())
        await entered.promise
        await workspace.dispose()
        pending.resolve()
        expect((await creating).ok).toBe(false)
        expect((await workspace.deleteNote("first", "absent")).ok).toBe(false)
        expect((await workspace.deleteBookmark("first", "absent")).ok).toBe(false)
        expect(
            (
                await workspace.createBookmark("first", {
                    pageNumber: 1,
                    name: "late",
                    association: noteInput().association,
                })
            ).ok,
        ).toBe(false)
        expect(events).toEqual([])
        const restored = reader(undefined, undefined, {
            storage: new ReadingStorage(namespace),
        }).workspace
        await restored.loadAnnotations("first")
        expect(restored.annotations("first").notes).toEqual([])
        await restored.dispose()
    })

    it.each(["delete", "replace", "revoke"] as const)(
        "fences queued annotation writes on document %s without discarding recoverable work",
        async (change) => {
            const namespace = readingNamespace()
            const set = namespace.set.bind(namespace)
            const pending = deferred<void>()
            const entered = deferred<void>()
            let blocked = false
            namespace.set = async (key, value) => {
                if (!blocked) {
                    blocked = true
                    entered.resolve()
                    await pending.promise
                }
                await set(key, value)
            }
            const access = fileAccess()
            const lifetime = new AbortController()
            const storage = new ReadingStorage(namespace)
            const workspace = reader(access.files, undefined, {
                storage,
                writeSignal: lifetime.signal,
            }).workspace
            await workspace.open("first")
            await entered.promise
            const saving = workspace.createNote("first", noteInput())
            await vi.waitFor(() => expect(workspace.annotations("first").notes).toHaveLength(1))
            if (change === "delete") delete access.files.nodes.first
            if (change === "replace") access.files.getContentGeneration = () => 1
            if (change === "revoke") lifetime.abort()
            pending.resolve()
            expect((await saving).ok).toBe(false)
            expect(workspace.annotations("first")).toMatchObject({
                dirty: true,
                notes: [{ noteContent: "My note" }],
            })
            expect((await workspace.createNote("first", noteInput())).ok).toBe(change === "replace")
            await workspace.flush()
            const recovered = reader(undefined, undefined, { storage }).workspace
            await recovered.loadAnnotations("first")
            expect(recovered.annotations("first").notes).toHaveLength(change === "replace" ? 2 : 0)
            await Promise.all([workspace.dispose(), recovered.dispose()])
        },
    )

    it("preserves work while explicit invalidation fences old writes even after resume", async () => {
        const namespace = readingNamespace()
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
        const storage = new ReadingStorage(namespace)
        const workspace = reader(undefined, undefined, { storage }).workspace
        await workspace.open("first")
        await entered.promise
        const saving = workspace.createNote("first", noteInput())
        await vi.waitFor(() => expect(workspace.annotations("first").notes).toHaveLength(1))
        workspace.invalidateAnnotations("first")
        expect((await workspace.createNote("first", noteInput())).ok).toBe(false)
        workspace.resumeAnnotations("first")
        pending.resolve()
        expect((await saving).ok).toBe(false)
        expect(workspace.annotations("first")).toMatchObject({
            dirty: true,
            notes: [{ noteContent: "My note" }],
        })
        const beforeRetry = reader(undefined, undefined, { storage }).workspace
        await beforeRetry.loadAnnotations("first")
        expect(beforeRetry.annotations("first").notes).toEqual([])
        expect((await workspace.saveAnnotations("first")).ok).toBe(true)
        const recovered = reader(undefined, undefined, { storage }).workspace
        await recovered.loadAnnotations("first")
        expect(recovered.annotations("first").notes).toHaveLength(1)
        expect(recovered.annotations("first").notes[0].association.verification).toBe("unverified")
        await Promise.all([workspace.dispose(), beforeRetry.dispose(), recovered.dispose()])
    })

    it.each(["invalidate", "replace", "delete"] as const)(
        "suppresses annotation hydration after %s without reviving it on resume",
        async (change) => {
            const namespace = readingNamespace()
            const seed = reader(undefined, undefined, {
                storage: new ReadingStorage(namespace),
            }).workspace
            await seed.createNote("first", noteInput())
            await seed.dispose()
            const pending = deferred<void>()
            const entered = deferred<void>()
            const get = namespace.get.bind(namespace)
            namespace.get = async <T>(key: string): Promise<T | undefined> => {
                const value = await get<T>(key)
                entered.resolve()
                await pending.promise
                return value
            }
            const access = fileAccess()
            const workspace = reader(access.files, undefined, {
                storage: new ReadingStorage(namespace),
            }).workspace
            const events: string[] = []
            workspace.subscribeAnnotations((id) => events.push(id))
            const loading = workspace.loadAnnotations("first")
            await entered.promise
            if (change === "invalidate") {
                workspace.invalidateAnnotations("first")
                workspace.resumeAnnotations("first")
            }
            if (change === "replace") access.files.getContentGeneration = () => 1
            if (change === "delete") delete access.files.nodes.first
            pending.resolve()
            expect(await loading).toBe(false)
            expect(workspace.annotations("first")).toMatchObject({ loaded: false, notes: [] })
            expect(events).toEqual([])
            await workspace.dispose()
        },
    )

    it("never overwrites unread annotations after failed hydration and can retry a safe load", async () => {
        const namespace = readingNamespace()
        const storage = new ReadingStorage(namespace)
        const seed = reader(undefined, undefined, { storage }).workspace
        const saved = await seed.createNote("first", noteInput())
        if (!saved.ok) throw new Error("Expected note")
        await seed.dispose()
        const get = namespace.get.bind(namespace)
        namespace.get = async () => {
            throw new Error("private imported passage")
        }
        const errors: ReadingStorageError[] = []
        const workspace = reader(undefined, undefined, {
            storage,
            onStorageError: (error) => errors.push(error),
        }).workspace
        expect((await workspace.deleteNote("first", saved.value.id)).ok).toBe(false)
        expect((await workspace.deleteBookmark("first", "unknown")).ok).toBe(false)
        expect(workspace.annotations("first")).toMatchObject({
            loaded: false,
            error: "reading.storage.read",
        })
        namespace.get = get
        expect(await workspace.loadAnnotations("first")).toBe(true)
        expect(workspace.annotations("first")).toMatchObject({
            loaded: true,
            error: null,
            notes: [{ noteContent: "My note" }],
        })
        expect(errors.every((error) => error.message === "Unable to load reading state")).toBe(true)
        await workspace.dispose()
    })

    it.each([
        { id: "../unsafe" },
        { id: "x".repeat(129) },
        { bookId: "second" },
        { pageNumber: 0 },
        { pageNumber: 1.5 },
        { pageNumber: 10_000_001 },
        { start: -1 },
        { end: 3 },
        { end: Infinity },
        { end: 100_000_001 },
        { text: {} },
        { text: "x".repeat(100_001) },
        { noteContent: "x".repeat(1_000_001) },
        { noteContent: null },
        { color: "<img onerror=alert(1)>" },
        { createdAt: -1 },
        { association: { contentHash: "blob:transient", verification: "unverified" } },
        { association: { contentHash: "a".repeat(64), verification: "verified" } },
        { association: null },
    ])(
        "rejects untrusted recovered note fields without exposing private feedback ($id $pageNumber $color)",
        async (invalid) => {
            const namespace = readingNamespace()
            namespace.get = async <T>(): Promise<T | undefined> =>
                ({
                    version: 1,
                    documentId: "first",
                    notes: [
                        { ...noteInput(), id: "note-1", bookId: "first", createdAt: 1, ...invalid },
                    ],
                    bookmarks: [],
                }) as T
            const errors: ReadingStorageError[] = []
            const workspace = reader(undefined, undefined, {
                storage: new ReadingStorage(namespace),
                onStorageError: (error) => errors.push(error),
            }).workspace
            expect(await workspace.loadAnnotations("first")).toBe(false)
            expect(workspace.annotations("first")).toMatchObject({
                loaded: false,
                notes: [],
                error: "reading.storage.read",
            })
            expect(errors.map((error) => error.message)).toEqual(["Unable to load reading state"])
            await workspace.dispose()
        },
    )

    it("rejects invalid mutation IDs and fields without changing saved annotations", async () => {
        const workspace = reader(undefined, undefined, {
            storage: new ReadingStorage(readingNamespace()),
        }).workspace
        await workspace.createNote("first", noteInput())
        expect((await workspace.deleteNote("first", "../unsafe")).ok).toBe(false)
        expect((await workspace.deleteBookmark("first", "x".repeat(129))).ok).toBe(false)
        expect((await workspace.createNote("first", { ...noteInput(), end: -1 })).ok).toBe(false)
        expect(
            (
                await workspace.createBookmark("first", {
                    pageNumber: 0,
                    name: "",
                    association: noteInput().association,
                })
            ).ok,
        ).toBe(false)
        expect(workspace.annotations("first").notes).toHaveLength(1)
        await workspace.dispose()
    })

    it("captures initiating note input before delayed hydration and reader replacement", async () => {
        const namespace = readingNamespace()
        const pending = deferred<void>()
        const entered = deferred<void>()
        const get = namespace.get.bind(namespace)
        namespace.get = async <T>(key: string): Promise<T | undefined> => {
            const value = await get<T>(key)
            if (key.startsWith("reading-v1-annotations-")) {
                entered.resolve()
                await pending.promise
            }
            return value
        }
        const workspace = reader(undefined, undefined, {
            storage: new ReadingStorage(namespace),
        }).workspace
        const input = {
            ...noteInput(),
            association: { contentHash: "a".repeat(64), verification: "unverified" as const },
        }
        const saving = workspace.createNote("first", input)
        await entered.promise
        input.noteContent = "Changed after initiation"
        input.association.contentHash = "b".repeat(64)
        await workspace.open("second")
        pending.resolve()
        const result = await saving
        expect(result).toMatchObject({
            ok: true,
            value: {
                bookId: "first",
                noteContent: "My note",
                association: { contentHash: "a".repeat(64), verification: "unverified" },
            },
        })
        expect(workspace.snapshot.documentId).toBe("second")
        expect(workspace.annotations("second").notes).toEqual([])
        await workspace.dispose()
    })

    it.each(["drain", "revoke"] as const)(
        "bounds delayed annotation disposal and honors the host lifetime: %s",
        async (outcome) => {
            vi.useFakeTimers()
            const lifetime = new AbortController()
            const namespace = createExtensionStorage(
                new MemoryStorageBackend({ signal: lifetime.signal }),
                "builtin.viewer",
            ).namespace("viewer")
            const set = namespace.set.bind(namespace)
            const pending = deferred<void>()
            const entered = deferred<void>()
            namespace.set = async (key, value) => {
                entered.resolve()
                await pending.promise
                await set(key, value)
            }
            const storage = new ReadingStorage(namespace)
            const workspace = reader(undefined, undefined, {
                storage,
                writeSignal: lifetime.signal,
            }).workspace
            const events: string[] = []
            workspace.subscribeAnnotations((id) => events.push(id))
            try {
                const saving = workspace.createNote("first", noteInput())
                await entered.promise
                const beforeDisposal = workspace.annotations("first")
                if (outcome === "revoke") lifetime.abort()
                const disposing = workspace.dispose()
                await vi.advanceTimersByTimeAsync(250)
                await disposing
                const eventCount = events.length
                pending.resolve()
                // A completed bounded disposal cannot acknowledge a late write to its former editor.
                expect((await saving).ok).toBe(false)
                expect(workspace.annotations("first")).toBe(beforeDisposal)
                expect(events).toHaveLength(eventCount)
                const recovered = reader(undefined, undefined, { storage }).workspace
                await recovered.loadAnnotations("first")
                expect(recovered.annotations("first").notes).toHaveLength(
                    outcome === "drain" ? 1 : 0,
                )
                await recovered.dispose()
            } finally {
                pending.resolve()
                vi.useRealTimers()
            }
        },
    )

    it.each([
        { version: 2 },
        { documentId: "second" },
        { notes: "unsafe" },
        { bookmarks: null },
        { notes: Array(1) },
        { bookmarks: Array(1) },
        { notes: Array(10_001).fill({}) },
        {
            bookmarks: [
                {
                    id: "bad/id",
                    bookId: "first",
                    pageNumber: 1,
                    name: "Private",
                    createdAt: 1,
                    association: { contentHash: null, verification: "unverified" },
                },
            ],
        },
        {
            bookmarks: [
                {
                    id: "bookmark-1",
                    bookId: "first",
                    pageNumber: NaN,
                    name: "Private",
                    createdAt: 1,
                    association: { contentHash: null, verification: "unverified" },
                },
            ],
        },
        {
            bookmarks: [
                {
                    id: "bookmark-1",
                    bookId: "first",
                    pageNumber: 1,
                    name: {},
                    createdAt: 1,
                    association: { contentHash: null, verification: "unverified" },
                },
            ],
        },
        {
            bookmarks: [
                {
                    id: "bookmark-1",
                    bookId: "first",
                    pageNumber: 1,
                    name: "x".repeat(10_001),
                    createdAt: 1,
                    association: { contentHash: null, verification: "unverified" },
                },
            ],
        },
        {
            notes: [1, 2].map(() => ({
                ...noteInput(),
                id: "duplicate",
                bookId: "first",
                createdAt: 1,
            })),
        },
    ])("rejects malformed annotation envelopes and bookmarks (case %#)", async (invalid) => {
        const namespace = readingNamespace()
        namespace.get = async <T>(): Promise<T | undefined> =>
            ({ version: 1, documentId: "first", notes: [], bookmarks: [], ...invalid }) as T
        const workspace = reader(undefined, undefined, {
            storage: new ReadingStorage(namespace),
        }).workspace
        expect(await workspace.loadAnnotations("first")).toBe(false)
        expect(workspace.annotations("first")).toMatchObject({
            notes: [],
            bookmarks: [],
            error: "reading.storage.read",
        })
        expect(
            await workspace.updateNote("first", "note-1", {
                noteContent: "Edited",
                color: "pink",
            }),
        ).toMatchObject({ ok: false, error: { code: "reading.storage.read" } })
        expect(await workspace.updateBookmark("first", "bookmark-1", "Edited")).toMatchObject({
            ok: false,
            error: { code: "reading.storage.read" },
        })
        await workspace.dispose()
    })

    it("keeps documents and owning workspace instances independent without relying on loaded reader resources", async () => {
        const storage = new ReadingStorage(readingNamespace())
        const workspace = reader(undefined, undefined, { storage }).workspace
        const other = reader(undefined, undefined, {
            storage: new ReadingStorage(readingNamespace()),
        }).workspace
        await workspace.createNote("first", noteInput())
        await workspace.createBookmark("first", {
            pageNumber: 9,
            name: "First",
            association: noteInput().association,
        })
        await workspace.createNote("second", { ...noteInput(), noteContent: "Second" })
        await other.createNote("first", { ...noteInput(), noteContent: "Other instance" })
        await workspace.open("first")
        await workspace.close()
        await workspace.open("second")
        expect(workspace.annotations("first").notes).toMatchObject([{ noteContent: "My note" }])
        expect(workspace.annotations("second").notes).toMatchObject([{ noteContent: "Second" }])
        expect(other.annotations("first").notes).toMatchObject([{ noteContent: "Other instance" }])
        expect(await workspace.getReadingSummary("second")).toEqual({
            documentId: "second",
            noteCount: 1,
            bookmarkCount: 0,
        })
        await Promise.all([workspace.dispose(), other.dispose()])
        const restored = reader(undefined, undefined, { storage }).workspace
        await restored.loadAnnotations("first")
        await restored.loadAnnotations("second")
        expect(restored.annotations("first").bookmarks).toMatchObject([{ name: "First" }])
        expect(restored.annotations("second").bookmarks).toEqual([])
        await restored.dispose()
    })

    it("never reads, migrates or deletes unsupported annotation keys", async () => {
        const namespace = readingNamespace()
        const legacy = { notes: [{ noteContent: "Legacy" }], bookmarks: [{ name: "Legacy" }] }
        await namespace.set("notes", legacy.notes)
        await namespace.set("bookmarks", legacy.bookmarks)
        const get = namespace.get.bind(namespace)
        const remove = namespace.delete.bind(namespace)
        namespace.get = async <T>(key: string): Promise<T | undefined> => {
            if (key === "notes" || key === "bookmarks") throw new Error("Unsupported legacy read")
            return get<T>(key)
        }
        namespace.delete = async (key) => {
            if (key === "notes" || key === "bookmarks")
                throw new Error("Unsupported legacy deletion")
            return remove(key)
        }
        const workspace = reader(undefined, undefined, {
            storage: new ReadingStorage(namespace),
        }).workspace
        await workspace.loadAnnotations("first")
        expect(workspace.annotations("first")).toMatchObject({ notes: [], bookmarks: [] })
        const note = await workspace.createNote("first", noteInput())
        if (!note.ok) throw new Error("Expected new authoritative note")
        expect((await workspace.deleteNote("first", note.value.id)).ok).toBe(true)
        await workspace.close()
        await workspace.dispose()
    })

    it("fails safely before storage is configured and later loads durable annotations without overwriting them", async () => {
        const storage = new ReadingStorage(readingNamespace())
        const seed = reader(undefined, undefined, { storage }).workspace
        await seed.createNote("first", { ...noteInput(), noteContent: "Durable" })
        await seed.dispose()
        const errors: ReadingStorageError[] = []
        const workspace = reader(undefined, undefined, {
            onStorageError: (error) => errors.push(error),
        }).workspace
        const saved = await workspace.createNote("first", noteInput())
        expect(saved).toMatchObject({ ok: false, value: { noteContent: "My note" } })
        expect(Object.isFrozen(saved.value)).toBe(true)
        expect(workspace.annotations("first")).toMatchObject({
            loaded: false,
            dirty: false,
            notes: [],
        })
        expect(await workspace.loadAnnotations("first")).toBe(false)
        await workspace.restore(storage)
        expect(await workspace.loadAnnotations("first")).toBe(true)
        expect(workspace.annotations("first").notes).toMatchObject([{ noteContent: "Durable" }])
        expect(errors.map((error) => error.code)).toEqual([
            "reading.storage.read",
            "reading.storage.read",
        ])
        await workspace.dispose()
    })

    it.each(["note", "bookmark"] as const)(
        "keeps concurrent %s updates in initiation order while hydration is pending",
        async (kind) => {
            vi.useFakeTimers()
            const namespace = readingNamespace()
            const storage = new ReadingStorage(namespace)
            const seed = reader(undefined, undefined, { storage }).workspace
            const saved =
                kind === "note"
                    ? await seed.createNote("first", noteInput())
                    : await seed.createBookmark("first", {
                          pageNumber: 2,
                          name: "Original",
                          association: noteInput().association,
                      })
            if (!saved.ok) throw new Error("Expected saved annotation")
            await seed.dispose()
            const pending = deferred<void>()
            const entered = deferred<void>()
            const get = namespace.get.bind(namespace)
            let blocked = false
            namespace.get = async <T>(key: string): Promise<T | undefined> => {
                const value = await get<T>(key)
                if (!blocked && key.startsWith("reading-v1-annotations-")) {
                    blocked = true
                    entered.resolve()
                    await pending.promise
                }
                return value
            }
            const workspace = reader(undefined, undefined, { storage }).workspace
            const update = (content: string) =>
                kind === "note"
                    ? workspace.updateNote("first", saved.value.id, {
                          noteContent: content,
                          color: "pink",
                      })
                    : workspace.updateBookmark("first", saved.value.id, content)
            try {
                const earlier = update("Earlier")
                await entered.promise
                const later = update("Later")
                // Drain the unblocked storage work before releasing the first read.
                await vi.advanceTimersByTimeAsync(0)
                pending.resolve()
                expect((await earlier).ok).toBe(true)
                expect((await later).ok).toBe(true)
                const expected =
                    kind === "note"
                        ? { notes: [{ noteContent: "Later" }] }
                        : { bookmarks: [{ name: "Later" }] }
                expect(workspace.annotations("first")).toMatchObject(expected)
                await workspace.dispose()
                const recovered = reader(undefined, undefined, { storage }).workspace
                expect(await recovered.loadAnnotations("first")).toBe(true)
                expect(recovered.annotations("first")).toMatchObject(expected)
                await recovered.dispose()
            } finally {
                pending.resolve()
                vi.useRealTimers()
            }
        },
    )

    it("does not make resumed edits wait for or revive invalidated mutation hydration", async () => {
        const namespace = readingNamespace()
        const storage = new ReadingStorage(namespace)
        const seed = reader(undefined, undefined, { storage }).workspace
        const saved = await seed.createNote("first", noteInput())
        if (!saved.ok) throw new Error("Expected saved note")
        await seed.dispose()
        const pending = deferred<void>()
        const entered = deferred<void>()
        const get = namespace.get.bind(namespace)
        let blocked = false
        namespace.get = async <T>(key: string): Promise<T | undefined> => {
            const value = await get<T>(key)
            if (!blocked && key.startsWith("reading-v1-annotations-")) {
                blocked = true
                entered.resolve()
                await pending.promise
            }
            return value
        }
        const workspace = reader(undefined, undefined, { storage }).workspace
        const earlier = workspace.updateNote("first", saved.value.id, {
            noteContent: "Obsolete",
            color: "pink",
        })
        await entered.promise
        workspace.invalidateAnnotations("first")
        workspace.resumeAnnotations("first")
        try {
            expect(
                (
                    await workspace.updateNote("first", saved.value.id, {
                        noteContent: "Resumed",
                        color: "blue",
                    })
                ).ok,
            ).toBe(true)
            pending.resolve()
            expect((await earlier).ok).toBe(false)
            expect(workspace.annotations("first")).toMatchObject({
                dirty: false,
                notes: [{ noteContent: "Resumed" }],
            })
        } finally {
            pending.resolve()
            await workspace.dispose()
        }
    })

    it("orders delayed creates, edits and deletes without resurrecting records or mixing the displayed document", async () => {
        const namespace = readingNamespace()
        const storage = new ReadingStorage(namespace)
        const workspace = reader(undefined, undefined, { storage }).workspace
        const saved = await workspace.createNote("first", noteInput())
        if (!saved.ok) throw new Error("Expected note")
        const set = namespace.set.bind(namespace)
        const pending = deferred<void>()
        const entered = deferred<void>()
        let blocked = false
        namespace.set = async (key, value) => {
            if (!blocked) {
                blocked = true
                entered.resolve()
                await pending.promise
            }
            await set(key, value)
        }
        const updating = workspace.updateNote("first", saved.value.id, {
            noteContent: "Edited",
            color: "pink",
        })
        await entered.promise
        const bookmark = workspace.createBookmark("first", {
            pageNumber: 7,
            name: "First bookmark",
            association: noteInput().association,
        })
        const deleting = workspace.deleteNote("first", saved.value.id)
        await workspace.open("second")
        const creating = workspace.createNote("second", {
            ...noteInput(),
            noteContent: "Second note",
        })
        pending.resolve()
        expect(
            (await Promise.all([updating, bookmark, deleting, creating])).every(
                (result) => result.ok,
            ),
        ).toBe(true)
        expect(workspace.snapshot.documentId).toBe("second")
        expect(workspace.annotations("first")).toMatchObject({
            dirty: false,
            notes: [],
            bookmarks: [{ name: "First bookmark" }],
        })
        await workspace.dispose()
        const recovered = reader(undefined, undefined, { storage }).workspace
        await recovered.loadAnnotations("first")
        await recovered.loadAnnotations("second")
        expect(recovered.annotations("first")).toMatchObject({
            notes: [],
            bookmarks: [{ name: "First bookmark" }],
        })
        expect(recovered.annotations("second")).toMatchObject({
            notes: [{ noteContent: "Second note" }],
            bookmarks: [],
        })
        await recovered.dispose()
    })

    it("does not publish obsolete failed-write feedback after explicit document invalidation", async () => {
        const namespace = readingNamespace()
        const entered = deferred<void>()
        const pending = deferred<void>()
        namespace.set = async () => {
            entered.resolve()
            await pending.promise
            throw new Error("private stale annotation")
        }
        const errors: ReadingStorageError[] = []
        const workspace = reader(undefined, undefined, {
            storage: new ReadingStorage(namespace),
            onStorageError: (error) => errors.push(error),
        }).workspace
        const events: string[] = []
        workspace.subscribeAnnotations((id) => events.push(id))
        const saving = workspace.createNote("first", noteInput())
        await entered.promise
        workspace.invalidateAnnotations("first")
        const snapshot = workspace.annotations("first")
        const eventCount = events.length
        pending.resolve()
        expect((await saving).ok).toBe(false)
        expect(workspace.annotations("first")).toBe(snapshot)
        expect(events).toHaveLength(eventCount)
        expect(errors).toEqual([])
        await workspace.dispose()
    })

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
