import type { RenderedPage } from "$lib/document-model"
import { afterEach, expect, it, vi } from "vitest"
import { createExtensionStorage, MemoryStorageBackend } from "$lib/core/storage"
import { DocumentService } from "$lib/core/documents"
import { ReadingStorage } from "./readingStorage"
import { ReadingWorkspace } from "./readingWorkspace"
import { createServiceLoader } from "./viewerDocument"
import type { Book } from "./stores/viewerStore.types"
import type { ViewerFileCapability } from "./viewerHost"

function fixture(
    render?: (pageNumber: number) => Promise<RenderedPage>,
    writeSignal?: AbortSignal,
) {
    let bytes = "original"
    let generation = 0
    let book: Book | null = null
    const service = new DocumentService()
    service.adapters.register({
        id: "viewer.review.fixture",
        extensions: [],
        mimeTypes: [],
        probe: async () => ({ supported: true }),
        open: async (source) => ({
            kind: "paged",
            metadata: { title: source.name, author: null },
            capabilities: new Set(),
            pageCount: source.size === 8 ? 10 : 3,
            getPage: async (pageNumber) => ({ pageNumber, width: 100, height: 100 }),
            renderPage:
                render ??
                (async (pageNumber) => ({
                    pageNumber,
                    width: 100,
                    height: 100,
                    url: "blob:render",
                    mimeType: "image/png",
                })),
            close: async () => undefined,
        }),
    })
    vi.stubGlobal("fetch", async () => new Response(new Blob([bytes])))
    const files: ViewerFileCapability = {
        nodes: {
            first: { id: "first", name: "same.pdf", type: "file", updatedAt: 1, metadata: {} },
            second: { id: "second", name: "other.pdf", type: "file", updatedAt: 1, metadata: {} },
        },
        isLockedMap: {},
        getFileUrl: async (id) => `blob:${id}-${generation}`,
        restoreFileAccess: async () => undefined,
        requestRelink: () => undefined,
        waitForRelink: async () => undefined,
        releaseFileUrl: () => true,
        getContentGeneration: () => generation,
        isCurrentContent: (_id, value) => value === generation,
        isCurrentFileUrl: (_id, url) => url.endsWith(`-${generation}`),
        clearForwardHistory: () => undefined,
    }
    const namespace = createExtensionStorage(
        new MemoryStorageBackend(),
        "builtin.viewer",
    ).namespace("review")
    const storage = new ReadingStorage(namespace)
    const make = () =>
        new ReadingWorkspace({
            files,
            storage,
            writeSignal,
            loader: createServiceLoader(service),
            getCurrentBook: () => book,
            publish: (value) => {
                book = value
            },
        })
    const workspace = make()
    return {
        workspace,
        make,
        storage,
        namespace,
        replace: async (value: string) => {
            workspace.invalidateAnnotations("first")
            bytes = value
            generation++
            workspace.resumeAnnotations("first")
            await workspace.synchronize(true)
            await workspace.loadDocument()
        },
    }
}
const input = {
    pageNumber: 8,
    start: 1,
    end: 5,
    text: "<script>preserved</script>",
    noteContent: "Private note",
    color: "yellow" as const,
    association: { contentHash: null, verification: "unverified" as const },
}
afterEach(() => vi.unstubAllGlobals())

it("same-source rollback reacquires a usable reader while the invalidated view remains fenced", async () => {
    const { workspace } = fixture()
    await workspace.open("first")
    const original = await workspace.loadDocument()
    if (original?.kind !== "paged") throw new Error("Expected paged document")
    await expect(original.renderPage(1)).resolves.toMatchObject({ pageNumber: 1 })
    workspace.invalidateAnnotations("first")
    workspace.resumeAnnotations("first")
    await workspace.synchronize(true)
    const recovered = await workspace.loadDocument()
    if (recovered?.kind !== "paged") throw new Error("Expected recovered paged document")
    await expect(recovered.renderPage(1)).resolves.toMatchObject({ pageNumber: 1 })
    await expect(original.renderPage(1)).rejects.toMatchObject({ name: "AbortError" })
    expect(workspace.snapshot.status).toBe("ready")
    await workspace.dispose()
})

it("identical source bytes retain ordinary annotations and reading state after relink", async () => {
    const { workspace, replace } = fixture()
    await workspace.open("first")
    await workspace.loadDocument()
    workspace.setPosition(8, 25)
    const note = await workspace.createNote("first", input)
    expect(note.ok).toBe(true)
    await workspace.createDraft("first", input)
    await workspace.createBookmark("first", {
        pageNumber: 8,
        name: "Original place",
        association: input.association,
    })
    await replace("original")
    expect(workspace.anchoredAnnotations("first").notes).toHaveLength(1)
    expect(workspace.needsReview("first")).toEqual([])
    expect(workspace.anchoredAnnotations("first").drafts).toHaveLength(1)
    expect(workspace.anchoredAnnotations("first").bookmarks).toHaveLength(1)
    expect(workspace.snapshot.state).toMatchObject({ pageNumber: 8, scrollPosition: 25 })
    await workspace.dispose()
})

it("changed bytes preserve notes, drafts and bookmarks for review, withhold anchors and clamp position", async () => {
    const { workspace, replace } = fixture()
    await workspace.open("first")
    await workspace.loadDocument()
    workspace.setPosition(8, 25)
    await workspace.createNote("first", input)
    await workspace.createDraft("first", { ...input, noteContent: "Unfinished" })
    await workspace.createBookmark("first", {
        pageNumber: 8,
        name: "Old place",
        association: input.association,
    })
    await replace("replacement")
    expect(workspace.needsReview("first").map(({ kind }) => kind)).toEqual([
        "note",
        "draft",
        "bookmark",
    ])
    expect(workspace.anchoredAnnotations("first")).toEqual({ notes: [], drafts: [], bookmarks: [] })
    expect(workspace.annotations("first").drafts[0].noteContent).toBe("Unfinished")
    expect(workspace.annotations("first").bookmarks[0]).toMatchObject({
        name: "Old place",
        pageNumber: 8,
    })
    expect(workspace.snapshot.state).toMatchObject({ pageNumber: 3, scrollPosition: 0 })
    await workspace.dispose()
})

it("unverified recovered evidence stays in review after draft save; explicit discard is durable and isolated", async () => {
    const { workspace, storage, make } = fixture()
    await storage.writeAnnotations("first", {
        notes: [{ ...input, id: "old-note", bookId: "first", createdAt: 1 }],
        drafts: [{ ...input, id: "old-draft", bookId: "first", createdAt: 1 }],
        bookmarks: [
            {
                id: "old-mark",
                bookId: "first",
                createdAt: 1,
                pageNumber: 8,
                name: "Original",
                association: input.association,
            },
        ],
    })
    await workspace.open("first")
    await workspace.loadDocument()
    await workspace.loadAnnotations("first")
    expect(workspace.needsReview("first")).toHaveLength(3)
    expect((await workspace.saveDraft("first", "old-draft")).ok).toBe(true)
    expect(workspace.needsReview("first").map(({ kind }) => kind)).toEqual([
        "note",
        "note",
        "bookmark",
    ])
    expect((await workspace.discardReviewItem("first", "note", "old-note")).ok).toBe(true)
    await workspace.open("second")
    await workspace.createNote("second", input)
    await workspace.flush()
    await workspace.dispose()
    const restored = make()
    await restored.open("first")
    await restored.loadDocument()
    await restored.loadAnnotations("first")
    expect(restored.needsReview("first").map(({ record }) => record.id)).toEqual([
        "old-draft",
        "old-mark",
    ])
    expect(restored.anchoredAnnotations("first").notes).toEqual([])
    await restored.loadAnnotations("second")
    expect(restored.annotations("second").notes).toHaveLength(1)
    expect(restored.snapshot.state.pageNumber).toBe(1)
    await restored.dispose()
})

it("supersession fences a pending old-source draft creation without losing recovered material", async () => {
    const { workspace, namespace, replace } = fixture()
    await workspace.open("first")
    await workspace.loadDocument()
    const read = namespace.get.bind(namespace)
    let release!: () => void
    const blocked = new Promise<void>((resolve) => {
        release = resolve
    })
    namespace.get = async <T>(key: string): Promise<T | undefined> => {
        const records = await read<T>(key)
        if (key.startsWith("reading-v1-annotations-")) await blocked
        return records
    }
    const creating = workspace.createDraft("first", input)
    await replace("replacement")
    release()
    expect((await creating).ok).toBe(false)
    expect(workspace.annotations("first").drafts).toEqual([])
    await workspace.dispose()
})

it("an unavailable identity is never treated as an equality proof", async () => {
    const { workspace, replace } = fixture()
    await workspace.open("first")
    await workspace.loadDocument()
    await workspace.createNote("first", input)
    const randomUUID = crypto.randomUUID.bind(crypto)
    vi.stubGlobal("crypto", {
        randomUUID,
        subtle: {
            digest: async () => {
                throw new Error("Identity unavailable")
            },
        },
    })
    await replace("original")
    expect(workspace.snapshot.status).toBe("ready")
    expect(workspace.anchoredAnnotations("first").notes).toEqual([])
    expect(workspace.needsReview("first")).toMatchObject([
        { kind: "note", record: { text: input.text, noteContent: "Private note" } },
    ])
    await workspace.dispose()
})

it("failed review discard is retained as dirty work and a retry persists only that document", async () => {
    const { workspace, namespace, make, replace } = fixture()
    await workspace.open("first")
    await workspace.loadDocument()
    const note = await workspace.createNote("first", input)
    if (!note.ok) throw new Error("Expected note")
    const draft = await workspace.createDraft("first", input)
    if (!draft.ok) throw new Error("Expected draft")
    const bookmark = await workspace.createBookmark("first", {
        pageNumber: 8,
        name: "Old place",
        association: input.association,
    })
    if (!bookmark.ok) throw new Error("Expected bookmark")
    await replace("replacement")
    const set = namespace.set.bind(namespace)
    namespace.set = async () => {
        throw new Error("Unavailable storage")
    }
    expect((await workspace.discardReviewItem("first", "note", note.value.id)).ok).toBe(false)
    expect(workspace.annotations("first").dirty).toBe(true)
    namespace.set = set
    expect((await workspace.persistDrafts("first")).ok).toBe(true)
    expect((await workspace.discardReviewItem("first", "draft", draft.value.id)).ok).toBe(true)
    expect((await workspace.discardReviewItem("first", "bookmark", bookmark.value.id)).ok).toBe(
        true,
    )
    await workspace.dispose()
    const restored = make()
    await restored.loadDrafts("first")
    expect(restored.needsReview("first")).toEqual([])
    await restored.dispose()
})

it("late old-source render results cannot publish into the replacement", async () => {
    let release!: (page: RenderedPage) => void
    const pending = new Promise<RenderedPage>((resolve) => {
        release = resolve
    })
    const { workspace, replace } = fixture(() => pending)
    await workspace.open("first")
    const original = await workspace.loadDocument()
    if (original?.kind !== "paged") throw new Error("Expected paged document")
    const rendering = expect(original.renderPage(1)).rejects.toMatchObject({ name: "AbortError" })
    await replace("replacement")
    release({
        pageNumber: 1,
        width: 100,
        height: 100,
        url: "blob:obsolete-render",
        mimeType: "image/png",
    })
    await rendering
    expect(workspace.snapshot.status).toBe("ready")
    await workspace.dispose()
})

it("a draft created during pending source identity stays unverified after identity becomes ready", async () => {
    const { workspace, make } = fixture()
    let release!: (response: Response) => void
    vi.stubGlobal(
        "fetch",
        () =>
            new Promise<Response>((resolve) => {
                release = resolve
            }),
    )
    await workspace.open("first")
    const loading = workspace.loadDocument()
    const created = await workspace.createDraft("first", input)
    expect(created.ok).toBe(true)
    release(new Response(new Blob(["original"])))
    await loading
    expect(workspace.anchoredAnnotations("first").drafts).toEqual([])
    expect(workspace.needsReview("first")).toMatchObject([
        { kind: "draft", record: { noteContent: "Private note", association: input.association } },
    ])
    await workspace.dispose()
    const restored = make()
    await restored.loadDrafts("first")
    expect(restored.annotations("first").drafts[0].association).toEqual(input.association)
    await restored.dispose()
})

it("late source acquisition cannot replace the replacement's identity evidence", async () => {
    const { workspace, replace } = fixture()
    let release!: (response: Response) => void
    let reads = 0
    vi.stubGlobal("fetch", async () => {
        if (reads++ === 0)
            return new Promise<Response>((resolve) => {
                release = resolve
            })
        return new Response(new Blob(["replacement"]))
    })
    await workspace.open("first")
    const obsolete = workspace.loadDocument()
    await replace("replacement")
    const created = await workspace.createNote("first", input)
    expect(created.ok).toBe(true)
    release(new Response(new Blob(["original"])))
    expect(await obsolete).toBeUndefined()
    expect(workspace.anchoredAnnotations("first").notes).toHaveLength(1)
    expect(workspace.needsReview("first")).toEqual([])
    await workspace.dispose()
})

it("review discard cannot bypass the revoked host writer lifetime", async () => {
    const lifetime = new AbortController()
    const { workspace, replace } = fixture(undefined, lifetime.signal)
    await workspace.open("first")
    await workspace.loadDocument()
    const created = await workspace.createNote("first", input)
    if (!created.ok) throw new Error("Expected note")
    await replace("replacement")
    lifetime.abort()
    expect((await workspace.discardReviewItem("first", "note", created.value.id)).ok).toBe(false)
    expect(workspace.needsReview("first")).toHaveLength(1)
    await workspace.dispose()
})
