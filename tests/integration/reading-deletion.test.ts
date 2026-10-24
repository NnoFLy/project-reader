// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest"
import { flushSync, mount, unmount, type Component } from "svelte"
import { createExtensionStorage, MemoryStorageBackend } from "$lib/core/storage"
import { createBuiltinHost } from "$lib/extensions/builtin"
import { viewerStore } from "$lib/extensions/builtin/viewer/stores/viewerStore.svelte"
import { libraryStore } from "$lib/extensions/builtin/library/state/libraryStore.svelte"
import { DocumentService } from "$lib/core/documents"
import { createFakeDocumentAdapter } from "$lib/core/documents/fake-document-adapter"
import { DocumentSourceLimitError } from "$lib/core/files"
import { ReadingStorage } from "$lib/extensions/builtin/viewer/readingStorage"

vi.hoisted(() => {
    window.matchMedia = (() => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
    })) as unknown as typeof window.matchMedia
})
vi.mock("$app/state", () => ({ page: { url: new URL("http://localhost/viewer") } }))
vi.mock("$app/navigation", () => ({
    goto: vi.fn(async () => undefined),
    pushState: vi.fn(),
    replaceState: vi.fn(),
}))
afterEach(() => vi.unstubAllGlobals())

async function seed(backend: MemoryStorageBackend) {
    const library = createExtensionStorage(backend, "builtin.library").namespace("library")
    for (const id of ["a", "b"]) {
        await library.set(`books.${id}`, {
            id,
            name: `${id}.fake`,
            type: "file",
            parentId: null,
            createdAt: 1,
            updatedAt: 1,
            isPinned: false,
            metadata: {},
            size: 1,
        })
        await library.set(`fileContents.${id}`, { id, file: new Blob([id]) })
    }
    return library
}

it("commits recoverable reading cleanup with Library source deletion, retaining a failed source's drafts", async () => {
    const backend = new MemoryStorageBackend()
    await seed(backend)
    const host = createBuiltinHost({ storage: backend })
    const reading = new ReadingStorage(
        createExtensionStorage(backend, "builtin.viewer").namespace("viewer"),
    )
    const remove = backend.delete.bind(backend)
    try {
        await host.start()
        await viewerStore.workspace.open("a")
        expect(
            (
                await viewerStore.workspace.createDraft("a", {
                    pageNumber: 1,
                    start: 0,
                    end: 3,
                    text: "text",
                    noteContent: "draft",
                    color: "yellow",
                    association: { contentHash: null, verification: "unverified" },
                })
            ).ok,
        ).toBe(true)
        backend.delete = async (key) => {
            if (key.endsWith(":books.a")) throw new Error("injected source failure")
            await remove(key)
        }
        await expect(libraryStore.deleteNode("a")).rejects.toThrow()
        expect((await reading.readAnnotations("a")).drafts).toHaveLength(1)
        expect(viewerStore.workspace.snapshot.documentId).toBe("a")
        backend.delete = remove
        await libraryStore.deleteNode("a")
        expect((await reading.readAnnotations("a")).drafts).toHaveLength(0)
        expect(viewerStore.workspace.snapshot.documentId).toBeNull()
        expect(await reading.readCurrent()).toBeNull()
    } finally {
        backend.delete = remove
        await host.dispose()
    }
})

it("resumes committed cleanup after reload, including offscreen documents and duplicate retry", async () => {
    const backend = new MemoryStorageBackend()
    await seed(backend)
    const namespace = createExtensionStorage(backend, "builtin.viewer").namespace("viewer")
    const reading = new ReadingStorage(namespace)
    const first = createBuiltinHost({ storage: backend })
    const remove = backend.delete.bind(backend)
    try {
        await first.start()
        await viewerStore.workspace.open("a")
        expect(
            (
                await viewerStore.workspace.createDraft("a", {
                    pageNumber: 1,
                    start: 0,
                    end: 3,
                    text: "text",
                    noteContent: "recover me",
                    color: "yellow",
                    association: { contentHash: null, verification: "unverified" },
                })
            ).ok,
        ).toBe(true)
        await viewerStore.workspace.open("b")
        await viewerStore.workspace.flush()
        await namespace.set("reading-v0-old", { preserve: true })
        backend.delete = async (key) => {
            if (key.includes(":reading-v1-annotations-"))
                throw new Error("injected cleanup interruption")
            await remove(key)
        }
        await libraryStore.deleteNode("a")
        expect(libraryStore.nodes.a).toBeUndefined()
        expect(libraryStore.readingCleanupPending).toBe(true)
        expect(viewerStore.workspace.snapshot.documentId).toBe("b")
        expect((await reading.readAnnotations("a")).drafts).toHaveLength(1)
    } finally {
        await first.dispose()
        backend.delete = remove
    }
    const next = createBuiltinHost({ storage: backend })
    try {
        await next.start()
        expect(viewerStore.workspace.snapshot.documentId).toBe("b")
        expect(await viewerStore.workspace.open("a")).toBe(false)
        await vi.waitFor(async () =>
            expect((await reading.readAnnotations("a")).drafts).toEqual([]),
        )
        expect(await libraryStore.resumeReadingDeletions()).toBe(true)
        expect(await libraryStore.resumeReadingDeletions()).toBe(true)
        expect(await reading.readCurrent()).toBe("b")
        expect(await namespace.get("reading-v0-old")).toEqual({ preserve: true })
    } finally {
        await next.dispose()
    }
})

it("never treats an uncompensated failed source transaction as committed cleanup authority", async () => {
    const backend = new MemoryStorageBackend()
    await seed(backend)
    const host = createBuiltinHost({ storage: backend })
    const reading = new ReadingStorage(
        createExtensionStorage(backend, "builtin.viewer").namespace("viewer"),
    )
    const remove = backend.delete.bind(backend)
    const set = backend.set.bind(backend)
    try {
        await host.start()
        await viewerStore.workspace.open("a")
        expect(
            (
                await viewerStore.workspace.createDraft("a", {
                    pageNumber: 1,
                    start: 0,
                    end: 3,
                    text: "text",
                    noteContent: "preserve",
                    color: "yellow",
                    association: { contentHash: null, verification: "unverified" },
                })
            ).ok,
        ).toBe(true)
        backend.delete = async (key) => {
            await remove(key)
            if (key.endsWith(":books.a")) throw new Error("source operation interrupted")
        }
        backend.set = async (key, value) => {
            if (key.endsWith(":books.a")) throw new Error("compensation temporarily unavailable")
            await set(key, value)
        }
        await expect(libraryStore.deleteNode("a")).rejects.toThrow()
        backend.set = set
        backend.delete = remove
        await libraryStore.resumeReadingDeletions()
        expect((await reading.readAnnotations("a")).drafts).toHaveLength(1)
        expect(viewerStore.workspace.snapshot.documentId).toBe("a")
        expect(await viewerStore.workspace.open("a")).toBe(true)
    } finally {
        backend.set = set
        backend.delete = remove
        await host.dispose()
    }
})

it("cascades the persisted containing folder but preserves its moved-out child", async () => {
    const backend = new MemoryStorageBackend()
    const library = await seed(backend)
    const a = await library.get<Record<string, unknown>>("books.a")
    await library.set("books.a", { ...a, parentId: "folder" })
    await library.set("folders.folder", {
        id: "folder",
        name: "Folder",
        type: "folder",
        parentId: null,
        createdAt: 1,
        updatedAt: 1,
        isPinned: false,
        childrenIds: ["a", "b"],
    })
    const host = createBuiltinHost({ storage: backend })
    const reading = new ReadingStorage(
        createExtensionStorage(backend, "builtin.viewer").namespace("viewer"),
    )
    try {
        await host.start()
        await viewerStore.workspace.open("a")
        expect(
            (
                await viewerStore.workspace.createBookmark("a", {
                    pageNumber: 1,
                    name: "Remove",
                    association: { contentHash: null, verification: "unverified" },
                })
            ).ok,
        ).toBe(true)
        await viewerStore.workspace.open("b")
        expect(
            (
                await viewerStore.workspace.createBookmark("b", {
                    pageNumber: 1,
                    name: "Keep",
                    association: { contentHash: null, verification: "unverified" },
                })
            ).ok,
        ).toBe(true)
        await libraryStore.deleteNode("folder")
        expect(libraryStore.nodes.folder).toBeUndefined()
        expect(libraryStore.nodes.a).toBeUndefined()
        expect(libraryStore.nodes.b).toBeDefined()
        expect((await reading.readAnnotations("a")).bookmarks).toEqual([])
        expect((await reading.readAnnotations("b")).bookmarks).toMatchObject([{ name: "Keep" }])
        expect(viewerStore.workspace.snapshot.documentId).toBe("b")
    } finally {
        await host.dispose()
    }
})

it("ignores unsupported or mismatched deletion intents and preserves old reading envelopes", async () => {
    const backend = new MemoryStorageBackend()
    const library = await seed(backend)
    const namespace = createExtensionStorage(backend, "builtin.viewer").namespace("viewer")
    const reading = new ReadingStorage(namespace)
    await reading.writeAnnotations("orphan", {
        notes: [],
        bookmarks: [],
        drafts: [
            {
                id: "draft",
                bookId: "orphan",
                createdAt: 1,
                pageNumber: 1,
                start: 0,
                end: 1,
                text: "x",
                noteContent: "untouched",
                color: "yellow",
                association: { contentHash: null, verification: "unverified" },
            },
        ],
    })
    await library.set("readingDeletions.wrong-key", { id: "orphan", version: 1, phase: "pending" })
    await library.set("readingDeletions.orphan", { id: "orphan", version: 2, phase: "pending" })
    await library.set("readingDeletions.a", { id: "a", version: 1, phase: "pending" })
    const unsupportedKey = "reading-v1-document-0061"
    await namespace.set(unsupportedKey, { version: 2, documentId: "a", private: "preserve" })
    const host = createBuiltinHost({ storage: backend })
    try {
        await host.start()
        expect((await reading.readAnnotations("orphan")).drafts).toMatchObject([
            { noteContent: "untouched" },
        ])
        expect(libraryStore.nodes.a).toBeDefined()
        await libraryStore.deleteNode("a")
        expect(await namespace.get(unsupportedKey)).toEqual({
            version: 2,
            documentId: "a",
            private: "preserve",
        })
    } finally {
        await host.dispose()
    }
})

it("preserves annotations when delayed internal resource rollback removes an unconfirmed import", async () => {
    const backend = new MemoryStorageBackend()
    const documents = new DocumentService()
    const fake = createFakeDocumentAdapter()
    let enter!: (id: string) => void
    let release!: () => void
    const entered = new Promise<string>((resolve) => {
        enter = resolve
    })
    const released = new Promise<void>((resolve) => {
        release = resolve
    })
    let opens = 0
    documents.adapters.register({
        id: fake.id,
        extensions: fake.extensions,
        mimeTypes: fake.mimeTypes,
        probe: fake.probe.bind(fake),
        open: async (source, signal) => {
            const document = await fake.open(source, signal)
            if (++opens === 2)
                return Object.assign(document, {
                    validateRenderBounds: async () => {
                        enter(source.id)
                        await released
                        throw new DocumentSourceLimitError("injected resource limit")
                    },
                })
            return document
        },
    })
    const host = createBuiltinHost({ storage: backend, documentService: documents })
    const reading = new ReadingStorage(
        createExtensionStorage(backend, "builtin.viewer").namespace("viewer"),
    )
    try {
        await host.start()
        const importing = libraryStore.importFiles(
            [
                {
                    name: "rollback.fake",
                    source: new File(["safe fixture"], "rollback.fake", {
                        type: "application/x-fake-document",
                    }),
                },
            ],
            null,
        )
        const id = await entered
        expect(libraryStore.nodes[id]).toBeDefined()
        expect(
            (
                await viewerStore.workspace.createDraft(id, {
                    pageNumber: 1,
                    start: 0,
                    end: 1,
                    text: "x",
                    noteContent: "Keep rollback draft",
                    color: "yellow",
                    association: { contentHash: null, verification: "unverified" },
                })
            ).ok,
        ).toBe(true)
        release()
        expect((await importing)[0].status).toBe("failed")
        expect(libraryStore.nodes[id]).toBeUndefined()
        expect((await reading.readAnnotations(id)).drafts).toMatchObject([
            { noteContent: "Keep rollback draft" },
        ])
        expect(await libraryStore.resumeReadingDeletions()).toBe(true)
        expect((await reading.readAnnotations(id)).drafts).toHaveLength(1)
    } finally {
        release()
        await host.dispose()
    }
})

it.each(["annotations", "document", "current", "acknowledgement", "commit-retirement"])(
    "recovers deletion after an interrupted %s write",
    async (failure) => {
        const backend = new MemoryStorageBackend()
        await seed(backend)
        const namespace = createExtensionStorage(backend, "builtin.viewer").namespace("viewer")
        const reading = new ReadingStorage(namespace)
        let host = createBuiltinHost({ storage: backend })
        const remove = backend.delete.bind(backend)
        const write = backend.set.bind(backend)
        let interruptions = 0
        try {
            await host.start()
            await viewerStore.workspace.open("a")
            await viewerStore.workspace.createDraft("a", {
                pageNumber: 1,
                start: 0,
                end: 1,
                text: "x",
                noteContent: "Recovery",
                color: "yellow",
                association: { contentHash: null, verification: "unverified" },
            })
            await viewerStore.workspace.flush()
            backend.delete = async (key) => {
                const suffix =
                    failure === "commit-retirement"
                        ? "library-transaction-journal"
                        : failure === "current"
                          ? "reading-v1-current"
                          : `reading-v1-${failure}-0061`
                if (failure !== "acknowledgement" && key.endsWith(`:${suffix}`)) {
                    interruptions++
                    throw new Error("injected interruption")
                }
                await remove(key)
            }
            backend.set = async (key, value) => {
                if (
                    failure === "acknowledgement" &&
                    key.endsWith(":readingDeletions.a") &&
                    (value as { phase?: string }).phase === "complete"
                ) {
                    interruptions++
                    throw new Error("injected acknowledgement interruption")
                }
                await write(key, value)
            }
            await libraryStore.deleteNode("a")
            expect(interruptions).toBeGreaterThan(0)
            expect(libraryStore.nodes.a).toBeUndefined()
            expect(libraryStore.readingCleanupPending).toBe(failure !== "commit-retirement")
            backend.delete = remove
            backend.set = write
            await host.dispose()
            host = createBuiltinHost({ storage: backend })
            await host.start()
            expect(libraryStore.nodes.a).toBeUndefined()
            await vi.waitFor(() => expect(libraryStore.readingCleanupPending).toBe(false))
            expect(await reading.readDocument("a")).toBeNull()
            expect(await reading.readAnnotations("a")).toMatchObject({
                notes: [],
                bookmarks: [],
                drafts: [],
            })
            expect(await reading.readCurrent()).toBeNull()
            expect(await libraryStore.resumeReadingDeletions()).toBe(true)
        } finally {
            backend.delete = remove
            backend.set = write
            await host.dispose()
        }
    },
)

it("retains deletion intent without Viewer and fences its stale provider recovery handoff", async () => {
    const backend = new MemoryStorageBackend()
    await seed(backend)
    const host = createBuiltinHost({ storage: backend })
    const reading = new ReadingStorage(
        createExtensionStorage(backend, "builtin.viewer").namespace("viewer"),
    )
    try {
        await host.start()
        await viewerStore.workspace.open("a")
        const oldWorkspace = viewerStore.workspace
        expect(
            (
                await oldWorkspace.createDraft("a", {
                    pageNumber: 1,
                    start: 0,
                    end: 1,
                    text: "x",
                    noteContent: "Disabled provider draft",
                    color: "yellow",
                    association: { contentHash: null, verification: "unverified" },
                })
            ).ok,
        ).toBe(true)
        await host.disable("builtin.viewer")
        await libraryStore.deleteNode("a")
        expect(libraryStore.readingCleanupPending).toBe(true)
        expect((await reading.readAnnotations("a")).drafts).toHaveLength(1)
        await host.enable("builtin.viewer")
        await host.activate("builtin.viewer")
        await vi.waitFor(() => expect(libraryStore.readingCleanupPending).toBe(false))
        expect(viewerStore.workspace.snapshot.documentId).toBeNull()
        expect(viewerStore.workspace.annotations("a").drafts).toEqual([])
        expect((await reading.readAnnotations("a")).drafts).toEqual([])
        expect(await viewerStore.workspace.open("a")).toBe(false)
        expect(
            await oldWorkspace.updateDraft("a", "old", { noteContent: "late", color: "yellow" }),
        ).toMatchObject({
            ok: false,
        })
    } finally {
        await host.dispose()
    }
})

it.each([
    "annotations",
    "document",
    "current",
    "acknowledgement",
    "envelope",
    "reference-write",
    "recovery-retirement",
    "reference-retirement",
])(
    "restores durable read-only deletion recovery across a fresh host with persistent %s failure",
    async (failure) => {
        const backend = new MemoryStorageBackend()
        await seed(backend)
        let host = createBuiltinHost({ storage: backend })
        const remove = backend.delete.bind(backend)
        const set = backend.set.bind(backend)
        let faults = 0
        let destructiveMutations = 0
        try {
            await host.start()
            await viewerStore.workspace.open("a")
            viewerStore.workspace.setPosition(7, 0.4)
            const input = {
                pageNumber: 1,
                start: 0,
                end: 1,
                text: "passage",
                noteContent: "Durable private recovery",
                color: "yellow" as const,
                association: { contentHash: null, verification: "unverified" as const },
            }
            await viewerStore.workspace.createDraft("a", input)
            await viewerStore.workspace.createNote("a", { ...input, noteContent: "Saved recovery" })
            await viewerStore.workspace.createBookmark("a", {
                pageNumber: 1,
                name: "Recovery bookmark",
                association: input.association,
            })
            await viewerStore.workspace.flush()
            backend.delete = async (key) => {
                const suffix =
                    failure === "current"
                        ? "reading-v1-current"
                        : failure === "recovery-retirement"
                          ? "reading-v1-deletion-recovery-0061"
                          : failure === "reference-retirement"
                            ? "reading-v1-deletion-current"
                            : `reading-v1-${failure}-0061`
                if (key.includes(":reading-v1-")) destructiveMutations++
                if (key.endsWith(`:${suffix}`)) {
                    faults++
                    throw new Error("persistent deletion failure")
                }
                await remove(key)
            }
            backend.set = async (key, value) => {
                if (
                    (failure === "acknowledgement" &&
                        key.endsWith(":readingDeletions.a") &&
                        (value as { phase?: string }).phase === "complete") ||
                    (failure === "envelope" &&
                        key.endsWith(":reading-v1-deletion-recovery-0061")) ||
                    (failure === "reference-write" && key.endsWith(":reading-v1-deletion-current"))
                ) {
                    faults++
                    throw new Error("persistent recovery acknowledgement failure")
                }
                await set(key, value)
            }
            await libraryStore.deleteNode("a")
            expect(faults).toBeGreaterThan(0)
            if (failure === "envelope" || failure === "reference-write")
                expect(destructiveMutations).toBe(0)
            expect(libraryStore.readingCleanupPending).toBe(true)
            await host.dispose()
            const previousFaults = faults
            host = createBuiltinHost({ storage: backend })
            await host.start()
            await vi.waitFor(() =>
                expect(viewerStore.workspace.snapshot).toMatchObject({
                    documentId: "a",
                    status: "deletion-pending",
                    state: { pageNumber: 7 },
                }),
            )
            expect(viewerStore.workspace.annotations("a")).toMatchObject({
                drafts: [{ noteContent: "Durable private recovery" }],
                notes: [{ noteContent: "Saved recovery" }],
                bookmarks: [{ name: "Recovery bookmark" }],
            })
            expect(await host.commands.execute("library.reading.cleanup.retry")).toBe(false)
            expect(faults).toBeGreaterThan(previousFaults)
            if (failure === "envelope" || failure === "reference-write")
                expect(destructiveMutations).toBe(0)
            expect(viewerStore.workspace.snapshot.status).toBe("deletion-pending")
            expect((await viewerStore.workspace.createDraft("a", input)).ok).toBe(false)
            backend.delete = remove
            backend.set = set
            expect(await host.commands.execute("library.reading.cleanup.retry")).toBe(true)
            expect(viewerStore.workspace.snapshot.documentId).toBeNull()
            expect(viewerStore.workspace.annotations("a").drafts).toEqual([])
        } finally {
            backend.delete = remove
            backend.set = set
            await host.dispose()
        }
    },
)

it.each(["pending", "complete", "retired"] as const)(
    "publishes an unrelated reader before %s tombstone payload replay can hang",
    async (phase) => {
        const backend = new MemoryStorageBackend()
        const library = await seed(backend)
        const reading = new ReadingStorage(
            createExtensionStorage(backend, "builtin.viewer").namespace("viewer"),
        )
        await library.delete("books.a")
        await library.set("readingDeletions.a", { id: "a", version: 1, phase })
        await reading.writeCurrent("b")
        await reading.writeDocument("a", {
            pageNumber: 9,
            scrollPosition: 0,
            scale: 1,
            layout: "scroll",
        })
        const get = backend.get.bind(backend)
        let release!: () => void
        const stalled = new Promise<void>((resolve) => {
            release = resolve
        })
        const payloadReads: string[] = []
        backend.get = async (key) => {
            if (/reading-v1-(?:document|annotations|deletion-recovery)-0061$/.test(key)) {
                payloadReads.push(key)
                await stalled
            }
            return get(key)
        }
        const host = createBuiltinHost({ storage: backend })
        try {
            const started = host.start().then(() => true)
            expect(
                await Promise.race([
                    started,
                    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 750)),
                ]),
            ).toBe(true)
            expect(viewerStore.workspace.snapshot.documentId).toBe("b")
            expect(await viewerStore.workspace.open("a")).toBe(false)
            if (phase === "retired") expect(payloadReads).toEqual([])
            else {
                await vi.waitFor(() => expect(payloadReads.length).toBeGreaterThan(0))
                await vi.waitFor(() => expect(libraryStore.readingCleanupBusy).toBe(false), {
                    timeout: 3500,
                })
                expect(libraryStore.readingCleanupPending).toBe(true)
                expect(
                    payloadReads.every(
                        (key) => !/reading-v1-(?:document|annotations)-/.test(key),
                    ) || phase === "pending",
                ).toBe(true)
            }
            release()
            await libraryStore.resumeReadingDeletions()
            expect(viewerStore.workspace.snapshot.documentId).toBe("b")
            expect(await reading.readCurrent()).toBe("b")
        } finally {
            release()
            backend.get = get
            await host.dispose()
        }
    },
)

it.each(["reading-v1-deletion-current", "reading-v1-deletion-recovery-0061"])(
    "preserves unsupported recovery at %s without destructive cleanup",
    async (key) => {
        const backend = new MemoryStorageBackend()
        await seed(backend)
        const namespace = createExtensionStorage(backend, "builtin.viewer").namespace("viewer")
        const host = createBuiltinHost({ storage: backend })
        const remove = backend.delete.bind(backend)
        let mutations = 0
        const unsupported = { version: 99, documentId: "a", private: "unsupported recovery" }
        try {
            await host.start()
            await viewerStore.workspace.open("a")
            await viewerStore.workspace.flush()
            await namespace.set(key, unsupported)
            backend.delete = async (id) => {
                if (id.includes(":reading-v1-")) mutations++
                await remove(id)
            }
            await libraryStore.deleteNode("a")
            expect(libraryStore.readingCleanupPending).toBe(true)
            expect(mutations).toBe(0)
            expect(await namespace.get(key)).toEqual(unsupported)
            expect(await host.commands.execute("library.reading.cleanup.retry")).toBe(false)
            expect(await namespace.get(key)).toEqual(unsupported)
        } finally {
            backend.delete = remove
            await host.dispose()
        }
    },
)

it("replays a failed retired-tombstone acknowledgement without rereading historical reading payloads", async () => {
    const backend = new MemoryStorageBackend()
    await seed(backend)
    let host = createBuiltinHost({ storage: backend })
    const set = backend.set.bind(backend)
    const get = backend.get.bind(backend)
    let faults = 0
    try {
        await host.start()
        await viewerStore.workspace.open("a")
        backend.set = async (key, value) => {
            if (
                key.endsWith(":readingDeletions.a") &&
                (value as { phase?: string }).phase === "retired"
            ) {
                faults++
                throw new Error("retired tombstone acknowledgement interrupted")
            }
            await set(key, value)
        }
        await libraryStore.deleteNode("a")
        expect(faults).toBeGreaterThan(0)
        expect(viewerStore.workspace.snapshot.documentId).toBeNull()
        await viewerStore.workspace.open("b")
        await viewerStore.workspace.flush()
        await host.dispose()
        const payloadReads: string[] = []
        backend.get = async (key) => {
            if (/reading-v1-(?:document|annotations)-0061$/.test(key)) payloadReads.push(key)
            return get(key)
        }
        host = createBuiltinHost({ storage: backend })
        await host.start()
        expect(viewerStore.workspace.snapshot.documentId).toBe("b")
        expect(await host.commands.execute("library.reading.cleanup.retry")).toBe(false)
        expect(payloadReads).toEqual([])
        backend.set = set
        expect(await host.commands.execute("library.reading.cleanup.retry")).toBe(true)
        expect(payloadReads).toEqual([])
        expect(viewerStore.workspace.snapshot.documentId).toBe("b")
    } finally {
        backend.set = set
        backend.get = get
        await host.dispose()
    }
})

it.each(["envelope", "acknowledgement"])(
    "keeps a hung %s physically serialized after its deadline without late cleanup or replacing a newer reader",
    async (boundary) => {
        const backend = new MemoryStorageBackend()
        await seed(backend)
        const namespace = createExtensionStorage(backend, "builtin.viewer").namespace("viewer")
        let host = createBuiltinHost({ storage: backend })
        const set = backend.set.bind(backend)
        const remove = backend.delete.bind(backend)
        let mode: "throw" | "hang" | "release" = "throw"
        let release!: () => void
        const stalled = new Promise<void>((resolve) => {
            release = resolve
        })
        let entered = false
        let retirements = 0
        try {
            await host.start()
            await viewerStore.workspace.open("a")
            await viewerStore.workspace.createDraft("a", {
                pageNumber: 1,
                start: 0,
                end: 1,
                text: "passage",
                noteContent: "Recovery",
                color: "yellow",
                association: { contentHash: null, verification: "unverified" },
            })
            await viewerStore.workspace.flush()
            backend.set = async (key, value) => {
                const matches =
                    boundary === "envelope"
                        ? key.endsWith(":reading-v1-deletion-recovery-0061")
                        : key.endsWith(":readingDeletions.a") &&
                          (value as { phase?: string }).phase === "complete"
                if (matches && mode !== "release") {
                    if (mode === "throw") throw new Error("interrupted boundary")
                    entered = true
                    await stalled
                }
                await set(key, value)
            }
            await libraryStore.deleteNode("a")
            expect(libraryStore.readingCleanupPending).toBe(true)
            await host.dispose()
            mode = "hang"
            backend.delete = async (key) => {
                if (key.includes(":reading-v1-deletion-recovery-")) retirements++
                await remove(key)
            }
            host = createBuiltinHost({ storage: backend })
            await host.start()
            expect(viewerStore.workspace.snapshot).toMatchObject({
                documentId: "a",
                status: "deletion-pending",
            })
            await vi.waitFor(() => expect(entered).toBe(true))
            await vi.waitFor(() => expect(libraryStore.readingCleanupBusy).toBe(false), {
                timeout: 3500,
            })
            expect(libraryStore.readingCleanupPending).toBe(true)
            const opening = viewerStore.workspace.open("b")
            // Another bounded retry cannot steal either native physical queue from the hung write.
            expect(await host.commands.execute("library.reading.cleanup.retry")).toBe(false)
            expect(retirements).toBe(0)
            mode = "release"
            release()
            await opening
            await viewerStore.workspace.flush()
            await new Promise((resolve) => setTimeout(resolve, 0))
            expect(retirements).toBe(0)
            expect(await namespace.get("reading-v1-deletion-recovery-0061")).toBeDefined()
            expect(viewerStore.workspace.snapshot.documentId).toBe("b")
            expect(await host.commands.execute("library.reading.cleanup.retry")).toBe(true)
            expect(viewerStore.workspace.snapshot.documentId).toBe("b")
        } finally {
            mode = "release"
            release()
            backend.set = set
            backend.delete = remove
            await host.dispose()
        }
    },
    10_000,
)

it("bounds the first live completion acknowledgement while retaining read-only recovery and the physical queue", async () => {
    const backend = new MemoryStorageBackend()
    await seed(backend)
    const namespace = createExtensionStorage(backend, "builtin.viewer").namespace("viewer")
    const host = createBuiltinHost({ storage: backend })
    const set = backend.set.bind(backend)
    const remove = backend.delete.bind(backend)
    let release!: () => void
    const stalled = new Promise<void>((resolve) => {
        release = resolve
    })
    let acknowledgements = 0
    let retirements = 0
    let deletion: Promise<void> | undefined
    try {
        await host.start()
        await viewerStore.workspace.open("a")
        const draft = await viewerStore.workspace.createDraft("a", {
            pageNumber: 1,
            start: 0,
            end: 1,
            text: "passage",
            noteContent: "Live recovery",
            color: "yellow",
            association: { contentHash: null, verification: "unverified" },
        })
        expect(draft.ok).toBe(true)
        await viewerStore.workspace.flush()
        backend.set = async (key, value) => {
            if (
                key.endsWith(":readingDeletions.a") &&
                (value as { phase?: string }).phase === "complete"
            ) {
                if (++acknowledgements === 1) await stalled
            }
            await set(key, value)
        }
        backend.delete = async (key) => {
            if (key.includes(":reading-v1-deletion-recovery-")) retirements++
            await remove(key)
        }
        deletion = libraryStore.deleteNode("a")
        await vi.waitFor(() => expect(acknowledgements).toBe(1))
        expect(
            await Promise.race([
                deletion.then(() => true),
                new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 2700)),
            ]),
        ).toBe(true)
        expect(libraryStore.nodes.a).toBeUndefined()
        expect(libraryStore.readingCleanupPending).toBe(true)
        expect(libraryStore.readingCleanupBusy).toBe(false)
        expect(viewerStore.workspace.snapshot).toMatchObject({
            documentId: "a",
            status: "deletion-pending",
        })
        expect(viewerStore.workspace.annotations("a").drafts).toMatchObject([
            { noteContent: "Live recovery" },
        ])
        expect(await viewerStore.workspace.open("a")).toBe(false)
        if (draft.ok)
            expect(
                (
                    await viewerStore.workspace.updateDraft("a", draft.value.id, {
                        noteContent: "Must not save",
                        color: "yellow",
                    })
                ).ok,
            ).toBe(false)
        const opening = viewerStore.workspace.open("b")
        expect(await host.commands.execute("library.reading.cleanup.retry")).toBe(false)
        expect(acknowledgements).toBe(1)
        expect(retirements).toBe(0)
        release()
        await opening
        await viewerStore.workspace.flush()
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(retirements).toBe(0)
        expect(await namespace.get("reading-v1-deletion-recovery-0061")).toBeDefined()
        expect(viewerStore.workspace.snapshot.documentId).toBe("b")
        expect(await host.commands.execute("library.reading.cleanup.retry")).toBe(true)
        expect(retirements).toBe(1)
        expect(await namespace.get("reading-v1-deletion-recovery-0061")).toBeUndefined()
        expect(viewerStore.workspace.snapshot.documentId).toBe("b")
    } finally {
        release()
        await deletion?.catch(() => undefined)
        backend.set = set
        backend.delete = remove
        await host.dispose()
    }
}, 10_000)

it("distinguishes committed cleanup feedback from a settled failed cleanup attempt", async () => {
    const backend = new MemoryStorageBackend()
    await seed(backend)
    const host = createBuiltinHost({ storage: backend })
    const get = backend.get.bind(backend)
    const remove = backend.delete.bind(backend)
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    let entered = false
    let faults = 0
    let deleting: Promise<void> | undefined
    try {
        await host.start()
        expect(await viewerStore.workspace.open("a")).toBe(true)
        await viewerStore.workspace.createDraft("a", {
            pageNumber: 1,
            start: 0,
            end: 7,
            text: "passage",
            noteContent: "Private draft",
            color: "purple",
            association: { contentHash: null, verification: "unverified" },
        })
        await viewerStore.workspace.flush()
        backend.get = async (key) => {
            if (
                key.endsWith(":readingDeletions.a") &&
                libraryStore.readingCleanupPending &&
                !libraryStore.nodes.a
            ) {
                entered = true
                await gate
            }
            return get(key)
        }
        backend.delete = async (key) => {
            if (key.includes(":reading-v1-annotations-")) {
                faults++
                throw new Error("injected cleanup failure")
            }
            await remove(key)
        }
        deleting = libraryStore.deleteNode("a")
        await vi.waitFor(() => expect(entered).toBe(true))
        expect(libraryStore.readingCleanupPending).toBe(true)
        // Source commit publishes pending feedback before replay reaches Viewer cleanup.
        expect(viewerStore.workspace.snapshot.status).toBe("ready")
        expect(faults).toBe(0)
        expect(await viewerStore.workspace.open("a")).toBe(false)
        release()
        await deleting
        expect(faults).toBe(1)
        expect(libraryStore.readingCleanupBusy).toBe(false)
        expect(libraryStore.readingCleanupPending).toBe(true)
        expect(viewerStore.workspace.snapshot).toMatchObject({
            documentId: "a",
            status: "deletion-pending",
        })
        expect(viewerStore.workspace.annotations("a").drafts[0].noteContent).toBe("Private draft")
    } finally {
        release()
        await deleting
        backend.get = get
        backend.delete = remove
        await host.dispose()
    }
})

it("renders recovered notes and Note drafts with the same ID through the registered Reading view", async () => {
    const backend = new MemoryStorageBackend()
    await seed(backend)
    const reading = new ReadingStorage(
        createExtensionStorage(backend, "builtin.viewer").namespace("viewer"),
    )
    const record = {
        id: "shared-id",
        bookId: "a",
        createdAt: 1,
        pageNumber: 1,
        start: 0,
        end: 7,
        text: "<img src=x onerror=alert(1)> passage",
        noteContent: "Saved recovery",
        color: "purple" as const,
        association: { contentHash: null, verification: "unverified" as const },
    }
    // Both arrays independently satisfy the supported v1 storage contract.
    await reading.writeAnnotations("a", {
        notes: [record],
        drafts: [{ ...record, noteContent: "Draft recovery" }],
        bookmarks: [],
    })
    const host = createBuiltinHost({ storage: backend })
    const remove = backend.delete.bind(backend)
    const target = document.createElement("div")
    document.body.append(target)
    let view: ReturnType<typeof mount> | undefined
    try {
        await host.start()
        expect(await viewerStore.workspace.open("a")).toBe(true)
        expect(await viewerStore.workspace.loadDrafts("a")).toBe(true)
        backend.delete = async (key) => {
            if (key.includes(":reading-v1-annotations-"))
                throw new Error("injected cleanup failure")
            await remove(key)
        }
        await libraryStore.deleteNode("a")
        expect(viewerStore.workspace.snapshot.status).toBe("deletion-pending")
        const recovery = await reading.readDeletionRecovery("a")
        expect(recovery?.notes[0].id).toBe("shared-id")
        expect(recovery?.drafts[0].id).toBe("shared-id")
        const contribution = host.contributions
            .listViews()
            .find(({ id }) => id === "viewer.reader")!
        view = mount(contribution.component as Component, { target })
        flushSync()
        const region = target.querySelector("[data-reading-state=deletion-pending]")!
        expect(region.textContent).toContain("Saved recovery")
        expect(region.textContent).toContain("Draft recovery")
        expect(region.querySelectorAll("li")).toHaveLength(2)
        expect(region.querySelector("img, textarea, .fullscreen-viewer")).toBeNull()
        expect(await viewerStore.workspace.open("a")).toBe(false)
    } finally {
        if (view) await unmount(view)
        target.remove()
        backend.delete = remove
        await host.dispose()
    }
})
