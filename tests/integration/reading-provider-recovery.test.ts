// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mount, unmount, type Component } from "svelte"
import * as m from "$lib/paraglide/messages"
import { Blob as NodeBlob } from "node:buffer"
import { URL as NodeURL } from "node:url"
import { createExtensionStorage, MemoryStorageBackend } from "$lib/core/storage"
import { createBuiltinHost } from "$lib/extensions/builtin"
import { ReadingStorage } from "$lib/extensions/builtin/viewer/readingStorage"
import { viewerStore } from "$lib/extensions/builtin/viewer/stores/viewerStore.svelte"

vi.hoisted(() => {
    window.matchMedia = (() => ({
        matches: false,
        addEventListener() {},
        removeEventListener() {},
    })) as unknown as typeof window.matchMedia
})
vi.mock("$app/navigation", async (original) => ({
    ...(await original<typeof import("$app/navigation")>()),
    pushState: vi.fn(),
    goto: vi.fn(),
    replaceState: vi.fn(),
}))
vi.mock("$app/state", () => ({ page: { url: new URL("http://localhost/viewer"), state: {} } }))
// Format parsing is an external adapter boundary; lifecycle and managed cleanup remain real.
vi.mock("$lib/extensions/builtin/pdf", () => ({
    pdfDocumentAdapter: { probe: async () => ({ supported: false }) },
}))
const originalAnimate = Element.prototype.animate
beforeEach(() => {
    Element.prototype.animate = vi.fn(() => ({
        cancel() {},
        pause() {},
        play() {},
        finished: Promise.resolve(),
        effect: { getComputedTiming: () => ({ progress: 1 }) },
    })) as unknown as typeof Element.prototype.animate
})
afterEach(() => {
    Element.prototype.animate = originalAnimate
    vi.unstubAllGlobals()
})

async function application(extension = "fake") {
    vi.stubGlobal("Blob", NodeBlob)
    vi.stubGlobal("URL", NodeURL)
    const backend = new MemoryStorageBackend()
    const library = createExtensionStorage(backend, "builtin.library").namespace("library")
    for (const id of ["a", "b"]) {
        await library.set(`books.${id}`, {
            id,
            name: `${id}.${extension}`,
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
    const host = createBuiltinHost({ storage: backend })
    await host.start()
    return { host, backend }
}
const input = {
    pageNumber: 2,
    start: 0,
    end: 1,
    text: "passage",
    noteContent: "unfinished",
    color: "yellow" as const,
    association: { contentHash: null, verification: "unverified" as const },
}

describe("Reading provider recovery through the real host", () => {
    it("does not fence Reading when unrelated Prompt and Settings providers disappear", async () => {
        const { host } = await application()
        try {
            const workspace = viewerStore.workspace
            await workspace.open("a")
            const book = viewerStore.getCurrentBook()
            await host.disable("builtin.prompt")
            await host.disable("builtin.settings")
            expect(workspace.snapshot.status).toBe("ready")
            expect(viewerStore.getCurrentBook()).toBe(book)
        } finally {
            await host.dispose()
        }
    })

    it("isolates data-only recovery intent between distinct real hosts", async () => {
        const first = await application()
        let second: Awaited<ReturnType<typeof application>> | undefined
        try {
            await viewerStore.workspace.open("a")
            viewerStore.workspace.setPosition(7, 0.4)
            await first.host.disable("builtin.viewer")
            second = await application()
            expect(second.host.readingRecovery?.documentId).toBeNull()
            await viewerStore.workspace.open("b")
            viewerStore.workspace.setPosition(3, 0.2)
            await second.host.disable("builtin.viewer")
            await first.host.enable("builtin.viewer")
            await first.host.activate("builtin.viewer")
            expect(viewerStore.workspace.snapshot).toMatchObject({
                documentId: "a",
                status: "provider-unavailable",
                state: { pageNumber: 7 },
            })
            expect(await first.host.readingRecovery?.retry()).toBe(true)
            await first.host.disable("builtin.viewer")
            await second.host.enable("builtin.viewer")
            await second.host.activate("builtin.viewer")
            expect(viewerStore.workspace.snapshot).toMatchObject({
                documentId: "b",
                status: "provider-unavailable",
                state: { pageNumber: 3 },
            })
            expect(await second.host.readingRecovery?.retry()).toBe(true)
        } finally {
            await second?.host.dispose()
            await first.host.dispose()
        }
    })

    it("shows safe provider feedback, keeps retry focus and recovers the retained draft in one reader", async () => {
        const { host } = await application()
        const target = document.createElement("div")
        document.body.append(target)
        let view: ReturnType<typeof mount> | undefined
        host.documentService.adapters.register({
            id: "integration.feedback",
            extensions: ["fake"],
            mimeTypes: [],
            probe: async () => ({ supported: true }),
            open: async () => ({
                kind: "reflowable",
                metadata: { title: "Test", author: null },
                capabilities: new Set(),
                getSections: async () => [{ id: "section", content: "Hello" }],
                close: async () => undefined,
            }),
        })
        try {
            const workspace = viewerStore.workspace
            await workspace.open("a")
            await workspace.createDraft("a", input)
            await host.disable("builtin.library")
            const component = host.contributions
                .forExtension("builtin.viewer")
                .views.get("viewer.reader")!.component as Component
            view = mount(component, { target })
            await vi.waitFor(() =>
                expect(
                    target.querySelector('[data-reading-state="provider-unavailable"]')
                        ?.textContent,
                ).toContain(m.viewer_provider_unavailable_title()),
            )
            expect(target.querySelector('[role="status"]')).not.toBeNull()
            expect(target.textContent).not.toContain("private")
            const retry = [...target.querySelectorAll<HTMLButtonElement>("button")].find(
                (button) => button.textContent?.trim() === m.viewer_provider_retry(),
            )!
            retry.focus()
            retry.click()
            await vi.waitFor(() => expect(retry.getAttribute("aria-disabled")).toBe("false"))
            expect(document.activeElement).toBe(retry)
            await host.enable("builtin.library")
            await host.activate("builtin.library")
            expect(workspace.snapshot.status).toBe("provider-unavailable")
            retry.click()
            await vi.waitFor(() =>
                expect(target.querySelectorAll(".fullscreen-viewer")).toHaveLength(1),
            )
            expect(workspace.annotations("a").drafts[0]?.noteContent).toBe("unfinished")
            expect(workspace.snapshot.status).toBe("ready")
        } finally {
            if (view) await unmount(view)
            target.remove()
            await host.dispose()
        }
    })

    it.each(["builtin.pdf", "builtin.library"])(
        "fences a pending format operation on %s loss and preserves state until explicit retry",
        async (providerId) => {
            const { host } = await application("pdf")
            let complete!: () => void
            const pending = new Promise<void>((resolve) => {
                complete = resolve
            })
            const close = vi.fn(async () => undefined)
            host.documentService.adapters.register({
                id: "integration.recovery",
                extensions: ["pdf"],
                mimeTypes: [],
                probe: async () => ({ supported: true, confidence: 1 }),
                open: async () => ({
                    kind: "reflowable",
                    metadata: { title: "Test", author: null },
                    capabilities: new Set(),
                    getSections: async () => {
                        await pending
                        return [{ id: "section", content: "private content" }]
                    },
                    close,
                }),
            })
            try {
                const workspace = viewerStore.workspace
                await workspace.open("a")
                workspace.setPosition(6, 0.7)
                await workspace.createDraft("a", input)
                const document = await workspace.loadDocument()
                if (document?.kind !== "reflowable") throw new Error("Expected test document")
                const loading = document.getSections()
                const observed = expect(loading).rejects.toMatchObject({ name: "AbortError" })
                await host.disable(providerId)
                expect(workspace.snapshot).toMatchObject({
                    documentId: "a",
                    status: "provider-unavailable",
                    state: { pageNumber: 6 },
                })
                await observed
                await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1))
                complete()
                await host.enable(providerId)
                await host.activate(providerId)
                expect(workspace.snapshot.status).toBe("provider-unavailable")
                expect(await workspace.retry()).toBe(true)
                expect(workspace.annotations("a").drafts).toHaveLength(1)
                expect((await workspace.loadDocument())?.kind).toBe("reflowable")
            } finally {
                complete()
                await host.dispose()
            }
        },
    )

    it.each([false, true])(
        "reconciles a pending explicit draft promotion (dirty=%s) after physical drain",
        async (dirty) => {
            for (const succeeds of [false, true]) {
                const { host, backend } = await application()
                let release!: () => void
                const pending = new Promise<void>((resolve) => {
                    release = resolve
                })
                let entered!: () => void
                const writing = new Promise<void>((resolve) => {
                    entered = resolve
                })
                try {
                    const old = viewerStore.workspace
                    await old.open("a")
                    const draft = await old.createDraft("a", input)
                    if (!draft.ok) throw new Error("Expected draft")
                    const set = backend.set.bind(backend)
                    if (dirty) {
                        backend.set = async () => {
                            throw new Error("private write error")
                        }
                        await old.updateDraft("a", draft.value.id, {
                            noteContent: "accepted dirty edit",
                            color: "pink",
                        })
                    }
                    backend.set = async (key, value) => {
                        if (key.includes("reading-v1-annotations")) {
                            entered()
                            await pending
                            if (!succeeds) throw new Error("private promotion error")
                        }
                        await set(key, value)
                    }
                    const saving = old.saveDraft("a", draft.value.id)
                    await writing
                    await host.disable("builtin.viewer")
                    release()
                    await saving
                    backend.set = set
                    await host.enable("builtin.viewer")
                    await host.activate("builtin.viewer")
                    const recovered = viewerStore.workspace
                    await recovered.loadDrafts("a")
                    const records = recovered.annotations("a")
                    expect(records.notes).toHaveLength(succeeds ? 1 : 0)
                    expect(records.drafts).toHaveLength(succeeds ? 0 : 1)
                    expect((succeeds ? records.notes : records.drafts)[0]?.noteContent).toBe(
                        dirty ? "accepted dirty edit" : "unfinished",
                    )
                    expect(await recovered.retry()).toBe(true)
                    await recovered.flush()
                } finally {
                    release()
                    await host.dispose()
                }
            }
        },
    )

    it("retains a newer edit conflicting with a terminal promotion without automatic overwrite", async () => {
        const { host, backend } = await application()
        let release!: () => void
        const pending = new Promise<void>((resolve) => {
            release = resolve
        })
        let entered!: () => void
        const writing = new Promise<void>((resolve) => {
            entered = resolve
        })
        try {
            const old = viewerStore.workspace
            await old.open("a")
            const draft = await old.createDraft("a", input)
            if (!draft.ok) throw new Error("Expected draft")
            const set = backend.set.bind(backend)
            backend.set = async (key, value) => {
                if (key.includes("reading-v1-annotations")) {
                    entered()
                    await pending
                }
                await set(key, value)
            }
            const saving = old.saveDraft("a", draft.value.id)
            await writing
            const editing = old.updateDraft("a", draft.value.id, {
                noteContent: "newer retained edit",
                color: "pink",
            })
            await host.disable("builtin.viewer")
            release()
            await Promise.all([saving, editing])
            backend.set = set
            await host.enable("builtin.viewer")
            await host.activate("builtin.viewer")
            const recovered = viewerStore.workspace
            expect(recovered.annotations("a").drafts[0]?.noteContent).toBe("newer retained edit")
            expect(await recovered.retry()).toBe(false)
            expect((await recovered.persistDrafts("a")).ok).toBe(false)
            const durable = new ReadingStorage(
                createExtensionStorage(backend, "builtin.viewer").namespace("viewer"),
            )
            expect((await durable.readAnnotations("a")).notes[0]?.noteContent).toBe("unfinished")
            expect((await recovered.saveDraft("a", draft.value.id)).ok).toBe(true)
            expect(await recovered.retry()).toBe(true)
            expect(recovered.annotations("a").drafts).toHaveLength(0)
            expect(recovered.annotations("a").notes[0]?.noteContent).toBe("newer retained edit")
        } finally {
            release()
            await host.dispose()
        }
    })

    it("retains pending A to B intent across Viewer restart, not the last published A", async () => {
        const { host, backend } = await application()
        let release!: () => void
        const pending = new Promise<void>((resolve) => {
            release = resolve
        })
        let entered!: () => void
        const reading = new Promise<void>((resolve) => {
            entered = resolve
        })
        try {
            const old = viewerStore.workspace
            await old.open("a")
            await old.flush()
            const saved = new ReadingStorage(
                createExtensionStorage(backend, "builtin.viewer").namespace("viewer"),
            )
            await saved.writeDocument("b", {
                pageNumber: 12,
                scrollPosition: 0.8,
                scale: 1.75,
                layout: "single",
            })
            const get = backend.get.bind(backend)
            backend.get = async (key) => {
                if (key.endsWith("reading-v1-document-0062")) {
                    entered()
                    await pending
                }
                return get(key)
            }
            const opening = old.open("b")
            await reading
            await host.disable("builtin.viewer")
            release()
            expect(await opening).toBe(false)
            await host.enable("builtin.viewer")
            await host.activate("builtin.viewer")
            const recovered = viewerStore.workspace
            expect(recovered.snapshot).toMatchObject({
                documentId: "b",
                status: "provider-unavailable",
            })
            expect(await recovered.retry()).toBe(true)
            expect(recovered.snapshot).toMatchObject({
                documentId: "b",
                state: { pageNumber: 12, scrollPosition: 0.8, scale: 1.75, layout: "single" },
            })
            await recovered.open("a")
            expect(recovered.snapshot.documentId).toBe("a")
        } finally {
            release()
            await host.dispose()
        }
    })

    it("keeps a replacement Library preview alive after obsolete Viewer cleanup", async () => {
        const { host, backend } = await application()
        try {
            const library = createExtensionStorage(backend, "builtin.library").namespace("library")
            await library.set("previews.a", {
                id: "a",
                data: new Blob(["cover"], { type: "image/png" }),
            })
            const reader = viewerStore
            await reader.workspace.open("a")
            const oldUrl = await reader.library.getPreviewUrl("a")
            await host.disable("builtin.library")
            await host.enable("builtin.library")
            await host.activate("builtin.library")
            expect(await reader.workspace.retry()).toBe(true)
            const newUrl = await reader.library.getPreviewUrl("a")
            expect(newUrl).not.toBe(oldUrl)
            reader.libraryMutations.revokePreviewUrl("a", oldUrl)
            expect(await (await fetch(newUrl)).text()).toBe("cover")
            reader.libraryMutations.revokePreviewUrl("a", newUrl)
        } finally {
            await host.dispose()
        }
    })

    it("hands dirty annotation/draft edits and progress to a fresh Viewer lifetime without obsolete callbacks", async () => {
        const { host, backend } = await application()
        const old = viewerStore.workspace
        try {
            await old.open("a")
            old.setPosition(9, 0.4)
            old.setScale(2)
            const draft = await old.createDraft("a", input)
            const note = await old.createNote("a", input)
            await old.createBookmark("a", {
                pageNumber: 9,
                name: "saved bookmark",
                association: input.association,
            })
            if (!draft.ok || !note.ok) throw new Error("Expected annotations")
            const set = backend.set.bind(backend)
            backend.set = async (key, value) => {
                if (key.includes("reading-v1-annotations")) throw new Error("private draft failure")
                await set(key, value)
            }
            const editing = old.updateDraft("a", draft.value.id, {
                noteContent: "latest dirty edit",
                color: "pink",
            })
            const editingNote = old.updateNote("a", note.value.id, {
                noteContent: "latest annotation edit",
                color: "blue",
            })
            await host.disable("builtin.viewer")
            await Promise.all([editing, editingNote])
            await host.enable("builtin.viewer")
            await host.activate("builtin.viewer")
            const recovered = viewerStore.workspace
            expect(recovered).not.toBe(old)
            expect(recovered.snapshot).toMatchObject({
                documentId: "a",
                status: "provider-unavailable",
                state: { pageNumber: 9, scale: 2 },
            })
            expect(recovered.annotations("a").drafts[0]).toMatchObject({
                noteContent: "latest dirty edit",
                color: "pink",
            })
            expect(recovered.annotations("a").dirty).toBe(true)
            expect(recovered.annotations("a").notes[0]?.noteContent).toBe("latest annotation edit")
            expect(recovered.annotations("a").bookmarks).toHaveLength(1)
            backend.set = set
            expect(await recovered.retry()).toBe(true)
            await recovered.flush()
            expect(recovered.annotations("a").dirty).toBe(false)
            expect(
                (
                    await old.updateDraft("a", draft.value.id, {
                        noteContent: "obsolete",
                        color: "blue",
                    })
                ).ok,
            ).toBe(false)
            expect(recovered.annotations("a").drafts[0]?.noteContent).toBe("latest dirty edit")
        } finally {
            await host.dispose()
        }
    })
})
