import { describe, expect, it, vi } from "vitest"
import type {
    AppExtension,
    DocumentAdapter,
    DocumentSource,
    ExtensionContext,
    OpenedDocument,
} from "$lib/extension-api"
import { ExtensionHost } from "$lib/extension-host"
import { MemoryStorageBackend } from "$lib/core/storage"

const deferred = <T = void>() => {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => (resolve = done))
    return { promise, resolve }
}
const extension = (activate: AppExtension["activate"]): AppExtension => ({
    manifest: {
        id: "test.provider",
        name: "Provider",
        version: "1.0.0",
        engine: "*",
        entry: "provider",
        activationEvents: [{ type: "startup" }],
        permissions: ["documents", "storage", "commands"],
    },
    activate,
})

describe("ExtensionHost provider lifetimes", () => {
    it("publishes failure with an aborted lifetime before bounded cleanup and isolates its late callback", async () => {
        const cleanup = deferred()
        let first = true
        let context!: ExtensionContext
        const host = new ExtensionHost({
            cleanupTimeoutMs: 10,
            extensions: [
                extension((value) => {
                    context = value
                    value.host!.readingDisplay = {
                        active: true,
                        scale: first ? 1 : 2,
                        layout: "scroll",
                    }
                    if (first) {
                        first = false
                        value.lifecycle.onDispose(async () => {
                            await cleanup.promise
                            value.host!.readingDisplay = undefined
                            value.host!.contextualStatus?.clear()
                        })
                        throw new Error("private failure")
                    }
                }),
            ],
        })
        const events: string[] = []
        host.providers.onDidChange((provider) => {
            if (provider.state === "failed") {
                expect(provider.signal.aborted).toBe(true)
                events.push(provider.state)
            }
        })
        await expect(host.activate("test.provider")).rejects.toMatchObject({
            code: "extension.activation-failed",
        })
        expect(events).toEqual(["failed"])
        expect(context.host?.readingDisplay).toBeUndefined()
        expect(host.record("test.provider")?.error?.message).not.toContain("private failure")
        await host.enable("test.provider")
        await host.activate("test.provider")
        context.host!.contextualStatus!.publish({
            line1: "Replacement",
            line2: "Available",
            priority: 1,
        })
        cleanup.resolve()
        await Promise.resolve()
        expect(context.host?.readingDisplay?.scale).toBe(2)
        expect(host.contextualStatus.current?.line1).toBe("Replacement")
        await host.dispose()
    })

    it("does not activate or register contributions after an availability listener disables it", async () => {
        const activate = vi.fn((context: ExtensionContext) => {
            context.commands.register({
                id: "test.provider.run",
                label: "Run",
                execute: () => undefined,
            })
        })
        const host = new ExtensionHost({ extensions: [extension(activate)] })
        host.providers.onDidChange((provider) => {
            if (provider.state === "activating") void host.disable(provider.extensionId)
        })
        await host.start()
        expect(activate.mock.calls.length).toBe(0)
        expect(host.contributions.listCommands()).toEqual([])
        expect(host.providers.get("test.provider")?.state).toBe("disabled")
        await host.dispose()
    })

    it("fences rendering and closes only the old managed document on provider loss", async () => {
        const entered = deferred()
        const rendered = deferred<{
            pageNumber: number
            url: string
            width: number
            height: number
            mimeType: string
        }>()
        let renderSignal: AbortSignal | undefined
        const close = vi.fn(async () => {
            throw new Error("cleanup failed")
        })
        const sourceClose = vi.fn(async () => undefined)
        const render = vi.fn((_page, options) => {
            renderSignal = options?.signal
            entered.resolve()
            return rendered.promise
        })
        const host = new ExtensionHost({
            extensions: [
                extension((context) => {
                    context.documents.register({
                        id: "test.provider.format",
                        extensions: ["fake"],
                        mimeTypes: [],
                        probe: async () => ({ supported: true }),
                        open: async () => ({
                            kind: "paged",
                            metadata: { title: null, author: null },
                            capabilities: new Set(),
                            pageCount: 1,
                            getPage: async (pageNumber) => ({ pageNumber, width: 1, height: 1 }),
                            renderPage: render,
                            close,
                        }),
                    })
                }),
            ],
        })
        await host.start()
        const document = await host.documentService.open({
            id: "doc",
            name: "doc.fake",
            size: 0,
            mimeType: undefined,
            read: async () => new ArrayBuffer(0),
            close: sourceClose,
        })
        if (document.kind !== "paged") throw new Error("Expected paged document")
        const rendering = document.renderPage(1).catch((error) => error)
        await entered.promise
        await host.disable("test.provider")
        expect(renderSignal?.aborted).toBe(true)
        expect(await rendering).toMatchObject({ name: "AbortError" })
        await expect(document.close()).rejects.toThrow("cleanup failed")
        expect(close).toHaveBeenCalledOnce()
        expect(sourceClose).toHaveBeenCalledOnce()
        await host.enable("test.provider")
        await host.activate("test.provider")
        rendered.resolve({ pageNumber: 1, url: "old", width: 1, height: 1, mimeType: "image/fake" })
        await expect(document.renderPage(1)).rejects.toMatchObject({ name: "AbortError" })
        expect(render).toHaveBeenCalledOnce()
        expect(host.providers.get("test.provider")?.state).toBe("active")
        await host.dispose()
    })

    it("bounds disposal while aborting a non-cooperative probe and extension cleanup", async () => {
        const entered = deferred()
        const finish = deferred<{ supported: boolean }>()
        const dispose = vi.fn(() => new Promise<void>(() => undefined))
        const open = vi.fn()
        const sourceClose = vi.fn(async () => undefined)
        let probeSignal: AbortSignal | undefined
        const host = new ExtensionHost({
            cleanupTimeoutMs: 10,
            extensions: [
                extension((context) => {
                    context.lifecycle.onDispose(dispose)
                    context.documents.register({
                        id: "test.provider.format",
                        extensions: ["fake"],
                        mimeTypes: [],
                        probe: (_source, signal) => {
                            probeSignal = signal
                            entered.resolve()
                            return finish.promise
                        },
                        open,
                    })
                }),
            ],
        })
        await host.start()
        const opening = host.documentService.open({
            id: "doc",
            name: "doc.fake",
            size: 0,
            mimeType: undefined,
            read: async () => new ArrayBuffer(0),
            close: sourceClose,
        })
        const result = opening.catch((error) => error)
        await entered.promise
        const disposal = host.dispose()
        expect(host.dispose()).toBe(disposal)
        expect(probeSignal?.aborted).toBe(true)
        expect(host.providers.get("test.provider")?.state).toBe("disposed")
        await disposal
        expect(await result).toMatchObject({ name: "AbortError" })
        finish.resolve({ supported: true })
        await Promise.resolve()
        expect(open).not.toHaveBeenCalled()
        expect(sourceClose).toHaveBeenCalledOnce()
        expect(dispose).toHaveBeenCalledOnce()
    })

    it("rejects commands from an obsolete context instead of executing a replacement", async () => {
        let context!: ExtensionContext
        const run = vi.fn()
        const host = new ExtensionHost({
            extensions: [
                extension((value) => {
                    context = value
                    value.commands.register({ id: "test.provider.run", label: "Run", execute: run })
                }),
            ],
        })
        await host.start()
        const old = context
        await host.disable("test.provider")
        await host.enable("test.provider")
        await host.activate("test.provider")
        await expect(
            Promise.resolve().then(() => old.commands.execute("test.provider.run")),
        ).rejects.toThrow("disposed")
        expect(run).not.toHaveBeenCalled()
        await context.commands.execute("test.provider.run")
        expect(run).toHaveBeenCalledOnce()
        await host.dispose()
    })

    it("aborts pending adapter opens and source reads, cleaning late documents only once", async () => {
        const entered = deferred()
        const finish = deferred<OpenedDocument>()
        let openSignal: AbortSignal | undefined
        let ownedSource!: DocumentSource
        const adapter: DocumentAdapter = {
            id: "test.provider.format",
            extensions: ["fake"],
            mimeTypes: [],
            probe: async () => ({ supported: true }),
            open: async (source, signal) => {
                ownedSource = source
                openSignal = signal
                entered.resolve()
                return finish.promise
            },
        }
        const sourceClose = vi.fn(async () => undefined)
        const read = vi.fn(async () => new ArrayBuffer(0))
        const close = vi.fn(async () => ownedSource.close?.())
        const source: DocumentSource = {
            id: "doc",
            name: "doc.fake",
            size: 0,
            mimeType: undefined,
            read,
            close: sourceClose,
        }
        const host = new ExtensionHost({
            extensions: [
                extension((context) => {
                    context.documents.register(adapter)
                }),
            ],
        })
        await host.start()
        const opening = host.documentService.open(source)
        const cancelled = expect(opening).rejects.toMatchObject({ name: "AbortError" })
        await entered.promise
        const disabling = host.disable("test.provider")
        expect(openSignal?.aborted).toBe(true)
        await cancelled
        await disabling
        await expect(ownedSource.read()).rejects.toMatchObject({ name: "AbortError" })
        expect(read).not.toHaveBeenCalled()
        await host.enable("test.provider")
        await host.activate("test.provider")
        finish.resolve({
            kind: "reflowable",
            metadata: { title: null, author: null },
            capabilities: new Set(),
            getSections: async () => [],
            close,
        })
        await vi.waitFor(() => expect(close).toHaveBeenCalledOnce())
        expect(sourceClose).toHaveBeenCalledOnce()
        expect(host.documentService.openDocumentCount).toBe(0)
        expect(host.providers.get("test.provider")?.state).toBe("active")
        await host.dispose()
    })

    it("keeps replacement unavailable until prior physical storage work terminates", async () => {
        const entered = deferred()
        const finish = deferred()
        const storage = new MemoryStorageBackend()
        const originalSet = storage.set.bind(storage)
        vi.spyOn(storage, "set").mockImplementation(async (key, value) => {
            entered.resolve()
            await finish.promise
            await originalSet(key, value)
        })
        let context!: ExtensionContext
        let changes = 0
        const host = new ExtensionHost({
            extensions: [
                extension((value) => {
                    context = value
                    context.storage.onChange(() => changes++)
                }),
            ],
            storage,
            cleanupTimeoutMs: 10,
        })
        await host.start()
        const old = context
        const write = old.storage.set("draft", "retained").catch((error) => error)
        await entered.promise
        await host.disable("test.provider")
        await expect(host.enable("test.provider")).rejects.toThrow("storage")
        expect(host.providers.get("test.provider")?.state).toBe("disabled")
        finish.resolve()
        await write
        expect(changes).toBe(0)
        await host.enable("test.provider")
        await host.activate("test.provider")
        await expect(context.storage.get("draft")).resolves.toBe("retained")
        await expect(old.storage.set("draft", "obsolete")).rejects.toThrow()
        await expect(context.storage.get("draft")).resolves.toBe("retained")
        await host.dispose()
    })

    it("fences a storage-draining enable when a newer disable repeats disabled intent", async () => {
        const entered = deferred()
        const finish = deferred()
        const storage = new MemoryStorageBackend()
        const set = storage.set.bind(storage)
        vi.spyOn(storage, "set").mockImplementation(async (key, value) => {
            entered.resolve()
            await finish.promise
            await set(key, value)
        })
        let context!: ExtensionContext
        const activate = vi.fn((value: ExtensionContext) => {
            context = value
        })
        const host = new ExtensionHost({ extensions: [extension(activate)], storage })
        try {
            await host.start()
            const write = context.storage.set("draft", "retained").catch(() => undefined)
            await entered.promise
            await host.disable("test.provider")
            const disabled = host.providers.get("test.provider")!
            const enabling = host.enable("test.provider")
            await host.disable("test.provider")
            finish.resolve()
            await write
            await enabling
            expect(host.providers.get("test.provider")).toBe(disabled)
            expect(disabled.signal.aborted).toBe(true)
            await expect(host.activate("test.provider")).rejects.toThrow("not enabled")
            expect(activate).toHaveBeenCalledOnce()
            await host.enable("test.provider")
            await host.activate("test.provider")
            expect(host.providers.get("test.provider")?.generation).toBe(disabled.generation + 1)
            await expect(context.storage.get("draft")).resolves.toBe("retained")
        } finally {
            finish.resolve()
            await host.dispose()
        }
    })

    it("invalidates pending activation synchronously and fences obsolete publication", async () => {
        const started = deferred()
        const finish = deferred()
        let old!: ExtensionContext
        let live!: ExtensionContext
        let activations = 0
        const host = new ExtensionHost({
            cleanupTimeoutMs: 10,
            extensions: [
                extension(async (context) => {
                    if (++activations === 1) {
                        old = context
                        started.resolve()
                        await finish.promise
                        context.host!.readingDisplay = { active: true, scale: 99, layout: "scroll" }
                    } else {
                        live = context
                        context.host!.readingDisplay = { active: true, scale: 2, layout: "scroll" }
                    }
                }),
            ],
        })
        const activating = host.activate("test.provider")
        await started.promise
        const initial = host.providers.get("test.provider")!
        const changes = vi.fn()
        host.providers.onDidChange(changes)
        const disabling = host.disable("test.provider")
        expect(initial.signal.aborted).toBe(true)
        expect(host.providers.get("test.provider")?.state).toBe("disabled")
        expect(changes).toHaveBeenCalled()
        await disabling
        await expect(host.enable("test.provider")).rejects.toThrow("activation")
        finish.resolve()
        await activating
        await host.enable("test.provider")
        await host.activate("test.provider")
        const replacement = host.providers.get("test.provider")!
        expect(replacement.generation).not.toBe(initial.generation)
        const readDisplay = () => live.host?.readingDisplay
        const obsoleteDisplay = old.host?.readingDisplay
        if (obsoleteDisplay) obsoleteDisplay.scale = 99
        old.host!.readingDisplay = undefined
        expect(host.providers.get("test.provider")).toBe(replacement)
        expect(readDisplay()?.scale).toBe(2)
        expect(old.host?.readingDisplay).toBeUndefined()
        await host.dispose()
    })
})
