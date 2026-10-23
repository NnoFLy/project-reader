// @vitest-environment jsdom
import { ViewerCloseController } from "../../src/lib/extensions/builtin/viewer/viewerClose.svelte"

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
    getViewerRuntimeContext,
    type ViewerRuntime,
} from "$lib/extensions/builtin/viewer/viewerRuntime"
import PageView from "$lib/extensions/builtin/viewer/components/PageView.svelte"
import PromptBookPreview from "$lib/extensions/builtin/viewer/components/PromptBookPreview.svelte"
import ScrollPage from "$lib/extensions/builtin/viewer/components/ScrollPage.svelte"
import { mountViewerUI } from "$lib/extensions/builtin/viewer/state/viewerUI.svelte"
import SettingsSidebar from "$lib/extensions/builtin/viewer/components/SettingsSidebar.svelte"
import ViewerPage from "$lib/extensions/builtin/viewer/ViewerPage.svelte"
import { ReadingStorage } from "$lib/extensions/builtin/viewer/readingStorage"
import { commandsStore, useCommands } from "$lib/core/commands"
import { createViewerSettingsCommands } from "$lib/extensions/builtin/viewer/commands/viewerSettingsCommands"
import { mount, unmount, type Component } from "svelte"
import { goto } from "$app/navigation"
import type { ViewerPagedDocument } from "$lib/extensions/builtin/viewer/viewerDocument"
import * as m from "$lib/paraglide/messages"

const media = vi.hoisted(() => {
    const colorSchemeListeners = new Set<() => void>()
    window.matchMedia = ((query: string) => ({
        matches: false,
        addEventListener(_type: string, listener: () => void) {
            if (query === "(prefers-color-scheme: dark)") colorSchemeListeners.add(listener)
        },
        removeEventListener(_type: string, listener: () => void) {
            if (query === "(prefers-color-scheme: dark)") colorSchemeListeners.delete(listener)
        },
    })) as unknown as typeof window.matchMedia
    return { colorSchemeListeners }
})

vi.mock("$app/state", () => ({
    page: { url: new URL("http://localhost:3000/viewer?display=1#position") },
}))

vi.mock("$app/navigation", async (importOriginal) => ({
    ...(await importOriginal<typeof import("$app/navigation")>()),
    pushState: vi.fn(),
    goto: vi.fn(async () => undefined),
    replaceState: vi.fn(),
}))

afterEach(() => vi.unstubAllGlobals())

describe("Reading workspace host lifetime", () => {
    it("keeps the live host presentation on OS theme changes and releases only owned listeners", async () => {
        const storage = new MemoryStorageBackend()
        const defaults = createExtensionStorage(storage, "builtin.settings")
        await defaults.set("settings.theme", "dark")
        await defaults.set("settings.language", "en")
        const first = createBuiltinHost({ storage })
        const second = createBuiltinHost({ storage })
        try {
            await first.start()
            for (const listener of media.colorSchemeListeners) listener()
            expect(document.documentElement.classList.contains("dark")).toBe(true)
            expect(document.documentElement.lang).toBe("en")
            expect(media.colorSchemeListeners.size).toBe(1)
            await second.start()
            expect(media.colorSchemeListeners.size).toBe(2)
            await first.dispose()
            expect(media.colorSchemeListeners.size).toBe(1)
            for (const listener of media.colorSchemeListeners) listener()
            expect(document.documentElement.classList.contains("dark")).toBe(true)
            expect(document.documentElement.lang).toBe("en")
        } finally {
            await Promise.all([first.dispose(), second.dispose()])
        }
        expect(media.colorSchemeListeners.size).toBe(0)
    })

    it("keeps application preference commands with their owner through disposal and reconstruction", async () => {
        const firstStorage = new MemoryStorageBackend()
        const secondStorage = new MemoryStorageBackend()
        for (const [storage, quality] of [
            [firstStorage, 1],
            [secondStorage, 2],
        ] as const) {
            const defaults = createExtensionStorage(storage, "builtin.settings")
            await defaults.set("settings.quality", quality)
            await defaults.set("settings.prefer-pdf-title", true)
            await defaults.set("settings.theme", "light")
            await defaults.set("settings.language", "ru")
        }
        const first = createBuiltinHost({ storage: firstStorage })
        const second = createBuiltinHost({ storage: secondStorage })
        try {
            await first.start()
            await second.start()
            const firstSettings = first.contributions.forExtension("builtin.settings").settings
            const secondSettings = second.contributions.forExtension("builtin.settings").settings
            await first.commands.execute("settings.quality.in")
            await first.commands.execute("settings.pdf-title.toggle")
            expect(await firstSettings.getValue("settings.quality")).toBe(2)
            expect(await firstSettings.getValue("settings.prefer-pdf-title")).toBe(false)
            expect(await secondSettings.getValue("settings.quality")).toBe(2)
            expect(await secondSettings.getValue("settings.prefer-pdf-title")).toBe(true)
            await second.dispose()
            await first.commands.execute("settings.quality.in")
            await first.commands.execute("settings.pdf-title.toggle")
            await first.commands.execute("settings.theme", { value: "dark" })
            await first.commands.execute("settings.language", { value: "en" })
            expect(await firstSettings.getValue("settings.quality")).toBe(3)
            expect(await firstSettings.getValue("settings.prefer-pdf-title")).toBe(true)
            await vi.waitFor(async () => {
                const defaults = createExtensionStorage(firstStorage, "builtin.settings")
                expect(await defaults.get("settings.quality")).toBe(3)
                expect(await defaults.get("settings.language")).toBe("en")
            })
        } finally {
            await Promise.all([first.dispose(), second.dispose()])
        }
        for (const [storage, quality, theme, language] of [
            [firstStorage, 3, "dark", "en"],
            [secondStorage, 2, "light", "ru"],
        ] as const) {
            const restored = createBuiltinHost({ storage })
            try {
                await restored.start()
                const settings = restored.contributions.forExtension("builtin.settings").settings
                expect(await settings.getValue("settings.quality")).toBe(quality)
                expect(await settings.getValue("settings.prefer-pdf-title")).toBe(true)
                expect(await settings.getValue("settings.theme")).toBe(theme)
                expect(await settings.getValue("settings.language")).toBe(language)
            } finally {
                await restored.dispose()
            }
        }
    })

    it("presents and renders the owning application's quality while another host is installed", async () => {
        vi.stubGlobal("Blob", NodeBlob)
        vi.stubGlobal("URL", NodeURL)
        const firstStorage = new MemoryStorageBackend()
        const secondStorage = new MemoryStorageBackend()
        for (const [storage, quality] of [
            [firstStorage, 1],
            [secondStorage, 3],
        ] as const) {
            const defaults = createExtensionStorage(storage, "builtin.settings")
            await defaults.set("settings.quality", quality)
            await defaults.set("settings.layout", "single")
            await defaults.set("settings.animations", false)
        }
        const library = createExtensionStorage(firstStorage, "builtin.library").namespace("library")
        await library.set("books.book", {
            id: "book",
            name: "book.fake",
            type: "file",
            parentId: null,
            createdAt: 1,
            updatedAt: 1,
            isPinned: false,
            metadata: { author: null, totalPages: 1 },
            size: 1,
        })
        await library.set("fileContents.book", { id: "book", file: new Blob(["a"]) })
        const first = createBuiltinHost({ storage: firstStorage })
        const second = createBuiltinHost({ storage: secondStorage })
        const renderedQualities: number[] = []
        first.documentService.adapters.register({
            id: "integration.quality",
            extensions: ["fake"],
            mimeTypes: [],
            probe: async () => ({ supported: true }),
            open: async () => ({
                kind: "paged",
                metadata: { title: "Quality", author: null },
                capabilities: new Set(),
                pageCount: 1,
                getPage: async (pageNumber) => ({ pageNumber, width: 600, height: 800 }),
                renderPage: async (pageNumber, options) => {
                    renderedQualities.push(options?.quality ?? -1)
                    return {
                        pageNumber,
                        width: 600,
                        height: 800,
                        url: "data:image/png;base64,",
                        mimeType: "image/png",
                    }
                },
                close: async () => undefined,
            }),
        })
        const target = document.createElement("div")
        document.body.append(target)
        let reader: ReturnType<typeof mount> | undefined
        try {
            await first.start()
            const store = viewerStore
            await store.workspace.open("book")
            const pdf = await store.workspace.loadDocument()
            if (pdf?.kind !== "paged") throw new Error("Expected a paged reader")
            await second.start()
            const view = first.contributions
                .forExtension("builtin.viewer")
                .views.get("viewer.status")!
            const Status = view.component as Component
            let runtime!: ViewerRuntime
            // The native contribution supplies its activation's runtime without canvas geometry.
            const ReaderSettings: Component = (anchor, props) => {
                Status(anchor, {
                    contextualStatus: first.contextualStatus.forExtension("builtin.viewer"),
                })
                runtime = getViewerRuntimeContext()()
                mountViewerUI()
                const result = SettingsSidebar(anchor, props)
                ScrollPage(anchor, {
                    pdf,
                    pageNumber: 1,
                    scale: 1,
                    offsetY: 0,
                    width: 600,
                    height: 800,
                })
                return result
            }
            reader = mount(ReaderSettings, { target })
            await vi.waitFor(() =>
                expect(target.querySelector(".quality-value")?.textContent?.trim()).toBe("1"),
            )
            await vi.waitFor(() => expect(renderedQualities).toContain(1))
            const createOwnedCommands = () =>
                createViewerSettingsCommands(
                    runtime.store,
                    runtime.executeCommand,
                    runtime.settings,
                )
            const commands = createOwnedCommands()
            expect(commands.qualityIn.subtitle?.()).toBe(`${m.quality()}: 1`)
            expect(commands.qualityOut.subtitle?.()).toBe(`${m.quality()}: 1`)
            await commands.qualityIn.run()
            await vi.waitFor(() => {
                expect(target.querySelector(".quality-value")?.textContent?.trim()).toBe("2")
                expect(renderedQualities.at(-1)).toBe(2)
            })
            const secondSettings = second.contributions.forExtension("builtin.settings").settings
            expect(await secondSettings.getValue("settings.quality")).toBe(3)
            await second.dispose()
            const increase = target.querySelector<HTMLButtonElement>(".quality-value + button")!
            increase.click()
            await vi.waitFor(() => {
                expect(target.querySelector(".quality-value")?.textContent?.trim()).toBe("3")
                expect(renderedQualities.at(-1)).toBe(3)
            })
            const recreatedCommands = createOwnedCommands()
            expect(recreatedCommands.qualityOut.subtitle?.()).toBe(`${m.quality()}: 3`)
            await recreatedCommands.qualityOut.run()
            await vi.waitFor(() => {
                expect(target.querySelector(".quality-value")?.textContent?.trim()).toBe("2")
                expect(renderedQualities.at(-1)).toBe(2)
            })
            expect(
                await createExtensionStorage(secondStorage, "builtin.settings").get(
                    "settings.quality",
                ),
            ).toBe(3)
            await store.workspace.flush()
            const reading = new ReadingStorage(
                createExtensionStorage(firstStorage, "builtin.viewer").namespace("viewer"),
            )
            const documentState = await reading.readDocument("book")
            expect(documentState).toMatchObject({ pageNumber: 1, layout: "single" })
            expect(documentState).not.toHaveProperty("quality")
        } finally {
            if (reader) await unmount(reader)
            target.remove()
            await Promise.all([first.dispose(), second.dispose()])
        }
    })

    it("routes SettingsSidebar controls to their owner while another reader has global command scope and reconstructs preferences", async () => {
        vi.stubGlobal("Blob", NodeBlob)
        vi.stubGlobal("URL", NodeURL)
        const storage = new MemoryStorageBackend()
        const library = createExtensionStorage(storage, "builtin.library").namespace("library")
        for (const id of ["a", "b"]) {
            await library.set(`books.${id}`, {
                id,
                name: `${id}.fake`,
                type: "file",
                parentId: null,
                createdAt: 1,
                updatedAt: 1,
                isPinned: false,
                metadata: { pageNumber: 99 },
                size: 1,
            })
            await library.set(`fileContents.${id}`, { id, file: new Blob([id]) })
        }
        const defaults = createExtensionStorage(storage, "builtin.settings")
        await defaults.set("settings.scale", 1.25)
        await defaults.set("settings.layout", "scroll")
        const first = createBuiltinHost({ storage })
        await first.start()
        const store = viewerStore
        try {
            await store.workspace.open("a")
            expect(store.currentPage).toBe(1)
            expect(store.scale).toBe(1.25)
            expect(store.layout).toBe("scroll")
            const runtime: ViewerRuntime = {
                closing: new ViewerCloseController(store),
                store,
                notes: notesStore,
                bookmarks: bookmarksStore,
                search: searchStore,
                executeCommand: (id, payload) => first.commands.execute(id, payload),
            }
            const settingsFor =
                (owner: ViewerRuntime): Component =>
                (anchor, props) => {
                    setViewerRuntimeContext(() => owner)
                    const commands = createViewerSettingsCommands(owner.store, owner.executeCommand)
                    useCommands([commands.layout, commands.zoomIn, commands.zoomOut])
                    return SettingsSidebar(anchor, props)
                }
            const Settings = settingsFor(runtime)
            const target = document.createElement("div")
            document.body.append(target)
            const settings = mount(Settings, { target })
            try {
                await vi.waitFor(() =>
                    expect(
                        target.querySelector<HTMLInputElement>('input[type="number"]')?.value,
                    ).toBe("125"),
                )
                await first.commands.execute("settings.zoom.in", { value: 2 })
                await first.commands.execute("settings.layout", { value: "split" })
                await vi.waitFor(() => {
                    expect(
                        target.querySelector<HTMLInputElement>('input[type="number"]')?.value,
                    ).toBe("200")
                    const options = target.querySelectorAll("[aria-pressed]")
                    expect(options[0]?.getAttribute("aria-pressed")).toBe("false")
                    expect(options[1]?.getAttribute("aria-pressed")).toBe("true")
                })
                const languageLinks = [
                    ...target.querySelectorAll<HTMLAnchorElement>(".language-options a"),
                ].map((link) => new URL(link.href))
                expect(languageLinks).toHaveLength(2)
                for (const link of languageLinks) {
                    expect(link.origin).toBe("http://localhost:3000")
                    expect(link.pathname).toMatch(/\/(?:en\/|ru\/)?viewer$/)
                    expect(link.search).toBe("?display=1")
                    expect(link.hash).toBe("#position")
                }
                const otherStorage = new MemoryStorageBackend()
                const otherLibrary = createExtensionStorage(
                    otherStorage,
                    "builtin.library",
                ).namespace("library")
                for (const id of ["a", "b"]) {
                    await otherLibrary.set(`books.${id}`, await library.get(`books.${id}`))
                    await otherLibrary.set(
                        `fileContents.${id}`,
                        await library.get(`fileContents.${id}`),
                    )
                }
                const otherDefaults = createExtensionStorage(otherStorage, "builtin.settings")
                await otherDefaults.set("settings.scale", 0.85)
                await otherDefaults.set("settings.layout", "single")
                const otherHost = createBuiltinHost({ storage: otherStorage })
                const otherTarget = document.createElement("div")
                document.body.append(otherTarget)
                let otherSettings: ReturnType<typeof mount> | undefined
                try {
                    await otherHost.start()
                    const otherStore = viewerStore
                    await otherStore.workspace.open("a")
                    otherSettings = mount(
                        settingsFor({
                            closing: new ViewerCloseController(otherStore),
                            store: otherStore,
                            notes: notesStore,
                            bookmarks: bookmarksStore,
                            search: searchStore,
                            executeCommand: (id, payload) =>
                                otherHost.commands.execute(id, payload),
                        }),
                        { target: otherTarget },
                    )
                    await vi.waitFor(() =>
                        expect(
                            otherTarget.querySelector<HTMLInputElement>('input[type="number"]')
                                ?.value,
                        ).toBe("85"),
                    )
                    // Prove the globally active command scope now belongs to the second reader.
                    await commandsStore.execute("settings.zoom.in", { value: 0.9 })
                    await commandsStore.execute("settings.layout", { value: "scroll" })
                    expect(otherStore.scale).toBe(0.9)
                    expect(otherStore.layout).toBe("scroll")
                    expect(store.scale).toBe(2)
                    expect(store.layout).toBe("split")

                    target.querySelector<HTMLButtonElement>(".layout-options button")!.click()
                    const scale = target.querySelector<HTMLInputElement>('input[type="number"]')!
                    scale.value = "175"
                    scale.dispatchEvent(new Event("change", { bubbles: true }))
                    await vi.waitFor(() => {
                        expect(store.scale).toBe(1.75)
                        expect(store.layout).toBe("single")
                    })
                    target
                        .querySelector<HTMLButtonElement>(".zoom-controls button:last-child")!
                        .click()
                    await vi.waitFor(() => expect(store.scale).toBe(1.9))
                    target
                        .querySelector<HTMLButtonElement>(".zoom-controls button:first-child")!
                        .click()
                    await vi.waitFor(() => expect(store.scale).toBe(1.8))
                    const slider = target.querySelector<HTMLInputElement>('input[type="range"]')!
                    slider.value = "150"
                    slider.dispatchEvent(new Event("input", { bubbles: true }))
                    await vi.waitFor(() => expect(store.scale).toBe(1.5))
                    expect(otherStore.scale).toBe(0.9)
                    expect(otherStore.layout).toBe("scroll")
                    expect(otherStore.currentPage).toBe(1)
                    expect(await defaults.get("settings.scale")).toBe(1.25)
                    expect(await defaults.get("settings.layout")).toBe("scroll")
                    await otherStore.workspace.open("b")
                    expect(otherStore.scale).toBe(0.85)
                    expect(otherStore.layout).toBe("single")
                    expect(await otherDefaults.get("settings.scale")).toBe(0.85)
                    expect(await otherDefaults.get("settings.layout")).toBe("single")
                } finally {
                    if (otherSettings) await unmount(otherSettings)
                    otherTarget.remove()
                    await otherHost.dispose()
                }
                await first.commands.execute("settings.zoom.in", { value: 2 })
                await first.commands.execute("settings.layout", { value: "split" })
            } finally {
                await unmount(settings)
                target.remove()
            }
            store.goToPage(7, { scrollPosition: 0.3 })
            expect(store.scale).toBe(2)
            expect(store.layout).toBe("split")
            await store.workspace.open("b")
            expect(store.scale).toBe(1.25)
            expect(store.layout).toBe("scroll")
            expect(await defaults.get("settings.scale")).toBe(1.25)
            expect(await defaults.get("settings.layout")).toBe("scroll")
            await first.commands.execute("settings.zoom.out", { value: 0.75 })
            await first.commands.execute("settings.layout", { value: "single" })
            await store.workspace.flush()
        } finally {
            await first.dispose()
        }
        const second = createBuiltinHost({ storage })
        await second.start()
        try {
            const restored = viewerStore
            expect(restored.workspace.snapshot).toMatchObject({
                documentId: "b",
                state: { scale: 0.75, layout: "single", pageNumber: 1 },
            })
            await restored.workspace.open("a")
            expect(restored.workspace.snapshot).toMatchObject({
                documentId: "a",
                state: { scale: 2, layout: "split", pageNumber: 7, scrollPosition: 0.3 },
            })
        } finally {
            await second.dispose()
        }
    })

    it("does not let a late metadata save overwrite newer reading progress through host reconstruction", async () => {
        vi.stubGlobal("Blob", NodeBlob)
        vi.stubGlobal("URL", NodeURL)
        const backend = new MemoryStorageBackend()
        const library = createExtensionStorage(backend, "builtin.library").namespace("library")
        await library.set("books.book", {
            id: "book",
            name: "Book.fake",
            type: "file",
            parentId: null,
            createdAt: 1,
            updatedAt: 1,
            isPinned: false,
            metadata: {},
            size: 1,
        })
        await library.set("fileContents.book", { id: "book", file: new Blob(["book"]) })
        const host = createBuiltinHost({ storage: backend })
        let release!: () => void
        let entered!: () => void
        const pending = new Promise<void>((resolve) => {
            release = resolve
        })
        const writing = new Promise<void>((resolve) => {
            entered = resolve
        })
        const set = backend.set.bind(backend)
        let blocked = false
        try {
            await host.start()
            const store = viewerStore
            await store.workspace.open("book")
            store.goToPage(3, { scrollPosition: 0.2 })
            backend.set = async (key, value) => {
                if (!blocked && key.endsWith(":books.book")) {
                    blocked = true
                    entered()
                    await pending
                }
                await set(key, value)
            }
            const updating = store.updateBook({ ...store.getCurrentBook()!, author: "Author" })
            await writing
            store.goToPage(8, { scrollPosition: 0.7 })
            release()
            await updating
            expect(store.getCurrentBook()).toMatchObject({
                author: "Author",
                pageNumber: 8,
                scrollPosition: 0.7,
            })
            expect(store.workspace.snapshot.state).toMatchObject({
                pageNumber: 8,
                scrollPosition: 0.7,
            })
            await store.workspace.flush()
        } finally {
            release()
            await host.dispose()
        }
        const restoredHost = createBuiltinHost({ storage: backend })
        try {
            await restoredHost.start()
            expect(viewerStore.getCurrentBook()).toMatchObject({
                id: "book",
                author: "Author",
                pageNumber: 8,
                scrollPosition: 0.7,
            })
        } finally {
            await restoredHost.dispose()
        }
    })

    it("keeps default commands local without an active reading document after the newer host is disposed", async () => {
        const firstStorage = new MemoryStorageBackend()
        const secondStorage = new MemoryStorageBackend()
        const firstDefaults = createExtensionStorage(firstStorage, "builtin.settings")
        const secondDefaults = createExtensionStorage(secondStorage, "builtin.settings")
        await firstDefaults.set("settings.scale", 1.25)
        await secondDefaults.set("settings.scale", 0.85)
        const first = createBuiltinHost({ storage: firstStorage })
        const second = createBuiltinHost({ storage: secondStorage })
        try {
            await first.start()
            await second.start()
            await first.commands.execute("settings.zoom.in", { value: 2 })
            await first.commands.execute("settings.layout", { value: "split" })
            await second.commands.execute("settings.zoom.out", { value: 0.75 })
            await second.commands.execute("settings.layout", { value: "single" })
            await vi.waitFor(async () => {
                expect(await firstDefaults.get("settings.scale")).toBe(2)
                expect(await firstDefaults.get("settings.layout")).toBe("split")
                expect(await secondDefaults.get("settings.scale")).toBe(0.75)
                expect(await secondDefaults.get("settings.layout")).toBe("single")
            })
            await second.dispose()
            await first.commands.execute("settings.zoom.in")
            await first.commands.execute("settings.layout")
            await vi.waitFor(async () => {
                expect(await firstDefaults.get("settings.scale")).toBe(2.1)
                expect(await firstDefaults.get("settings.layout")).toBe("scroll")
            })
        } finally {
            await Promise.all([first.dispose(), second.dispose()])
        }
    })

    it("does not let stuck restoration hold host activation/disposal or publish after disposal", async () => {
        vi.useFakeTimers()
        const backend = new MemoryStorageBackend()
        const storage = new ReadingStorage(
            createExtensionStorage(backend, "builtin.viewer").namespace("viewer"),
        )
        await storage.writeCurrent("missing")
        let release!: () => void
        let entered!: () => void
        const pending = new Promise<void>((resolve) => {
            release = resolve
        })
        const reading = new Promise<void>((resolve) => {
            entered = resolve
        })
        const get = backend.get.bind(backend)
        let blocked = false
        backend.get = async (key) => {
            const value = await get(key)
            if (!blocked && key.endsWith(":reading-v1-current")) {
                blocked = true
                entered()
                await pending
            }
            return value
        }
        const host = createBuiltinHost({ storage: backend })
        try {
            const starting = host.start()
            await reading
            await vi.advanceTimersByTimeAsync(250)
            await starting
            const store = viewerStore
            expect(store.reading.documentId).toBeNull()
            await host.dispose()
            release()
            await vi.advanceTimersByTimeAsync(0)
            expect(store.reading.documentId).toBeNull()
            const restoredHost = createBuiltinHost({ storage: backend })
            try {
                await restoredHost.start()
                expect(viewerStore.workspace.snapshot).toMatchObject({
                    documentId: "missing",
                    status: "missing",
                })
            } finally {
                await restoredHost.dispose()
            }
        } finally {
            release()
            vi.useRealTimers()
            await host.dispose()
        }
    })

    it("bounds settings readiness without applying late defaults over an edited document", async () => {
        vi.useFakeTimers()
        vi.stubGlobal("Blob", NodeBlob)
        vi.stubGlobal("URL", NodeURL)
        const backend = new MemoryStorageBackend()
        const defaults = createExtensionStorage(backend, "builtin.settings")
        await defaults.set("settings.scale", 2.5)
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
        let release!: () => void
        let entered!: () => void
        const pending = new Promise<void>((resolve) => {
            release = resolve
        })
        const reading = new Promise<void>((resolve) => {
            entered = resolve
        })
        const get = backend.get.bind(backend)
        let blocked = false
        backend.get = async (key) => {
            const value = await get(key)
            if (!blocked && key.endsWith(":settings.scale")) {
                blocked = true
                entered()
                await pending
            }
            return value
        }
        const host = createBuiltinHost({ storage: backend })
        try {
            const starting = host.start()
            await reading
            await vi.advanceTimersByTimeAsync(250)
            await starting
            const store = viewerStore
            await store.workspace.open("a")
            await host.commands.execute("settings.zoom.in", { value: 1.75 })
            await host.commands.execute("settings.layout", { value: "split" })
            release()
            await vi.advanceTimersByTimeAsync(0)
            expect(store.scale).toBe(1.75)
            expect(store.layout).toBe("split")
            await store.workspace.open("b")
            expect(store.scale).toBe(2.5)
            expect(store.layout).toBe("scroll")
            await store.workspace.flush()
        } finally {
            release()
            vi.useRealTimers()
            await host.dispose()
        }
    })

    it("renders safe missing-reference recovery feedback while retaining the intended identity", async () => {
        const backend = new MemoryStorageBackend()
        const storage = new ReadingStorage(
            createExtensionStorage(backend, "builtin.viewer").namespace("viewer"),
        )
        const id = '<img src=x onerror="alert(1)">'
        await storage.writeCurrent(id)
        const host = createBuiltinHost({ storage: backend })
        await host.start()
        const runtime: ViewerRuntime = {
            closing: new ViewerCloseController(viewerStore),
            store: viewerStore,
            notes: notesStore,
            bookmarks: bookmarksStore,
            search: searchStore,
            executeCommand: (command, payload) => host.commands.execute(command, payload),
        }
        const target = document.createElement("div")
        document.body.append(target)
        vi.mocked(goto).mockClear()
        const viewer = mount(ViewerPage, { target, props: { runtime } })
        try {
            await vi.waitFor(() =>
                expect(target.textContent).toContain("Document no longer in Library"),
            )
            expect(goto).not.toHaveBeenCalled()
            expect(target.querySelector("img")).toBeNull()
            expect(target.textContent).not.toContain(id)
            expect(runtime.store.workspace.snapshot.documentId).toBe(id)
            const close = [...target.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
                button.textContent?.includes(m.close_document()),
            )!
            close.click()
            await vi.waitFor(() => expect(runtime.store.workspace.snapshot.documentId).toBeNull())
            await runtime.store.workspace.flush()
        } finally {
            await unmount(viewer)
            target.remove()
            await host.dispose()
        }
        const restoredHost = createBuiltinHost({ storage: backend })
        try {
            await restoredHost.start()
            expect(viewerStore.workspace.snapshot.documentId).toBeNull()
        } finally {
            await restoredHost.dispose()
        }
    })

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
                await notes.loadNotesForBook("book")
                await notes.openDraft({
                    bookId: "book",
                    pageNumber: 1,
                    start: 0,
                    end: 1,
                    text: title,
                    color: "yellow",
                    noteContent: title,
                })
                const runtime: ViewerRuntime = {
                    closing: new ViewerCloseController(store),
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
                await first.host.commands.execute("settings.zoom.in", { value: 2 })
                await second.host.commands.execute("settings.zoom.out", { value: 0.75 })
                await first.host.commands.execute("settings.layout", { value: "split" })
                await second.host.commands.execute("settings.layout", { value: "single" })
                expect(first.store.scale).toBe(2)
                expect(first.store.layout).toBe("split")
                expect(second.store.scale).toBe(0.75)
                expect(second.store.layout).toBe("single")
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
