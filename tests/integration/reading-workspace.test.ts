// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from "vitest"
import { Blob as NodeBlob } from "node:buffer"
import { URL as NodeURL } from "node:url"
import { createExtensionStorage, MemoryStorageBackend } from "$lib/core/storage"
import { createBuiltinHost } from "$lib/extensions/builtin"
import { viewerStore } from "$lib/extensions/builtin/viewer/stores/viewerStore.svelte"
import { notesStore } from "$lib/extensions/builtin/viewer/stores/notesStore.svelte"
import { bookmarksStore } from "$lib/extensions/builtin/viewer/stores/bookmarksStore.svelte"
import { searchStore } from "$lib/extensions/builtin/viewer/stores/searchStore.svelte"
import {
    setViewerRuntimeContext,
    type ViewerRuntime,
} from "$lib/extensions/builtin/viewer/viewerRuntime"
import PageView from "$lib/extensions/builtin/viewer/components/PageView.svelte"
import PromptBookPreview from "$lib/extensions/builtin/viewer/components/PromptBookPreview.svelte"
import { mount, unmount, type Component } from "svelte"
import type { ViewerPagedDocument } from "$lib/extensions/builtin/viewer/viewerDocument"

vi.hoisted(() => {
    window.matchMedia = (() => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
    })) as unknown as typeof window.matchMedia
})

vi.mock("$app/navigation", async (importOriginal) => ({
    ...(await importOriginal<typeof import("$app/navigation")>()),
    pushState: vi.fn(),
}))

afterEach(() => vi.unstubAllGlobals())

describe("Reading workspace host lifetime", () => {
    it.each(["older", "newer"] as const)(
        "disposing the %s host leaves the other Reading workspace usable",
        async (which) => {
            vi.stubGlobal("Blob", NodeBlob)
            vi.stubGlobal("URL", NodeURL)
            const highlights = new Map<string, Set<Range>>()
            vi.stubGlobal("CSS", { highlights })
            vi.stubGlobal(
                "Highlight",
                class extends Set<Range> {
                    constructor(...ranges: Range[]) {
                        super(ranges)
                    }
                },
            )
            async function startReader(title: string) {
                const storage = new MemoryStorageBackend()
                const library = createExtensionStorage(storage, "builtin.library").namespace(
                    "library",
                )
                await library.set("books.book", {
                    id: "book",
                    name: `${title}.fake`,
                    type: "file",
                    parentId: null,
                    createdAt: 1,
                    updatedAt: 1,
                    isPinned: false,
                    size: 4,
                    metadata: { pageNumber: 1 },
                })
                await library.set("fileContents.book", { id: "book", file: new Blob([title]) })
                await library.set("previews.book", {
                    id: "book",
                    data: new Blob([`cover-${title}`], { type: "image/png" }),
                })
                const host = createBuiltinHost({ storage })
                const closed: string[] = []
                host.documentService.adapters.register({
                    id: "integration.reader",
                    extensions: ["fake"],
                    mimeTypes: [],
                    probe: async () => ({ supported: true }),
                    open: async (source) => ({
                        kind: "reflowable",
                        metadata: { title: source.name, author: null },
                        capabilities: new Set(),
                        getSections: async () => [
                            { id: "text", content: new TextDecoder().decode(await source.read()) },
                        ],
                        close: async () => {
                            closed.push(source.name)
                            await source.close?.()
                        },
                    }),
                })
                await host.start()
                const store = viewerStore
                await expect(store.workspace.open("book")).resolves.toBe(true)
                const document = await store.workspace.loadDocument()
                if (document?.kind !== "reflowable") throw new Error("Expected a reflowable reader")
                const notes = notesStore
                notes.openEditor({
                    isNew: true,
                    bookId: "book",
                    pageNumber: 1,
                    start: 0,
                    end: 1,
                    text: title,
                    color: "yellow",
                    noteContent: title,
                })
                const runtime: ViewerRuntime = {
                    store,
                    notes,
                    bookmarks: bookmarksStore,
                    search: searchStore,
                    executeCommand: (id, payload) => host.commands.execute(id, payload),
                }
                return { host, store, document, closed, notes, runtime }
            }
            const first = await startReader("first")
            const second = await startReader("second")
            const stopped = which === "older" ? first : second
            const survivor = which === "older" ? second : first
            try {
                expect(first.notes.editors[0]?.note.noteContent).toBe("first")
                expect(second.notes.editors[0]?.note.noteContent).toBe("second")
                const ranges = [first, second].map((reader) => {
                    const text = globalThis.document.createTextNode(
                        reader === first ? "first" : "second",
                    )
                    globalThis.document.body.append(text)
                    const range = globalThis.document.createRange()
                    range.selectNodeContents(text)
                    reader.notes.registerPageRanges(99, [
                        { noteId: "note", range, color: "yellow" },
                    ])
                    reader.runtime.search.registerPageRanges(99, [range])
                    return { text, range }
                })
                await vi.waitFor(() => {
                    expect(highlights.get("user-note-yellow")?.size).toBe(2)
                    expect(highlights.get("search-match")?.size).toBe(2)
                })
                await stopped.host.dispose()
                expect(highlights.get("user-note-yellow")?.size).toBe(1)
                expect(highlights.get("search-match")?.size).toBe(1)
                for (const { text } of ranges) text.remove()
                expect(survivor.notes.editors).toHaveLength(1)
                expect(stopped.closed).toEqual([`${which === "older" ? "first" : "second"}.fake`])
                expect(survivor.closed).toEqual([])
                const target = globalThis.document.createElement("div")
                globalThis.document.body.append(target)
                const ReaderPage: Component<Parameters<typeof PageView>[1]> = (anchor, props) => {
                    setViewerRuntimeContext(() => survivor.runtime)
                    return PageView(anchor, props)
                }
                const pdf: ViewerPagedDocument = {
                    kind: "paged",
                    metadata: { title: "Links", author: null },
                    capabilities: new Set(),
                    pageCount: 5,
                    getPage: async (pageNumber) => ({ pageNumber, width: 600, height: 800 }),
                    renderPage: async (pageNumber) => ({
                        pageNumber,
                        width: 600,
                        height: 800,
                        url: "",
                        mimeType: "image/png",
                    }),
                    getAnnotations: async () => [
                        {
                            type: "link",
                            rect: { x: 0, y: 0, width: 10, height: 10 },
                            pageNumber: 2,
                        },
                    ],
                    close: async () => undefined,
                }
                const page = mount(ReaderPage, {
                    target,
                    props: {
                        pdf,
                        pageNumber: 1,
                        image: "data:image/png;base64,",
                        width: 600,
                        height: 800,
                        scale: 1,
                    },
                })
                try {
                    await vi.waitFor(() =>
                        expect(target.querySelector("a[role=link]")).not.toBeNull(),
                    )
                    target.querySelector<HTMLAnchorElement>("a[role=link]")!.click()
                    expect(survivor.store.currentPage).toBe(2)
                    expect(stopped.store.currentPage).toBe(1)
                } finally {
                    await unmount(page)
                    target.remove()
                }
                const previewTarget = globalThis.document.createElement("div")
                globalThis.document.body.append(previewTarget)
                const preview = mount(PromptBookPreview, {
                    target: previewTarget,
                    props: {
                        bookId: "book",
                        preview: {
                            getPreviewUrl: (id: string) => survivor.store.library.getPreviewUrl(id),
                            onNodeInvalidated: (listener: (id: string) => void) =>
                                survivor.store.library.onNodeInvalidated(listener),
                            revokePreviewUrl: (id: string) =>
                                survivor.store.libraryMutations.revokePreviewUrl(id),
                        },
                    },
                })
                try {
                    await vi.waitFor(() =>
                        expect(previewTarget.querySelector("img")).not.toBeNull(),
                    )
                    const cover = await fetch(previewTarget.querySelector("img")!.src)
                    expect(await cover.text()).toBe(
                        which === "older" ? "cover-second" : "cover-first",
                    )
                } finally {
                    await unmount(preview)
                    previewTarget.remove()
                }
                expect(await survivor.document.getSections()).toEqual([
                    { id: "text", content: which === "older" ? "second" : "first" },
                ])
                await expect(survivor.store.workspace.open("book")).resolves.toBe(true)
                await survivor.store.workspace.close()
                await survivor.document.close()
                expect(survivor.closed).toHaveLength(1)
            } finally {
                await Promise.all([first.host.dispose(), second.host.dispose()])
            }
        },
    )
})
