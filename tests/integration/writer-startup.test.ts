// @vitest-environment jsdom

import { afterEach, expect, it, vi } from "vitest"
import { createBrowserApplication, createBuiltinApplication } from "$lib/app/bootstrap"
import { createExtensionStorage, MemoryStorageBackend } from "$lib/core/storage"
import { Blob as NodeBlob } from "node:buffer"
import { URL as NodeURL } from "node:url"
import { viewerStore } from "$lib/extensions/builtin/viewer/stores/viewerStore.svelte"

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
afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
})

it("does not construct or activate a Library host when another window owns the writer", async () => {
    const request = vi.fn(async (_name, _options, callback) => callback(null))
    vi.stubGlobal("navigator", { locks: { request } })
    const storage = vi.fn((lifetime) => new MemoryStorageBackend({ signal: lifetime.signal }))
    const migrateLibrary = vi.fn(async () => undefined)
    const application = createBrowserApplication({ storage, migration: { migrateLibrary } })

    const first = application.start()
    expect(application.start()).toBe(first)
    await first
    expect(application.state).toBe("blocked")
    expect(application.ready).toBe(false)
    expect(application.application).toBeUndefined()
    expect(storage).not.toHaveBeenCalled()
    expect(migrateLibrary).not.toHaveBeenCalled()
    await application.start()
    expect(application.state).toBe("blocked")
    expect(request).toHaveBeenCalledTimes(2)
    expect(request.mock.calls[0][1]).toMatchObject({ mode: "exclusive", ifAvailable: true })
    expect(request.mock.calls[0][1]).not.toHaveProperty("steal")
    // Web Locks forbids combining signal with ifAvailable (NotSupportedError).
    expect(request.mock.calls[0][1]).not.toHaveProperty("signal")
    await application.stop()
})

function deferred<T = void>() {
    let resolve!: (value: T) => void
    const promise = new Promise<T>((done) => {
        resolve = done
    })
    return { promise, resolve }
}

it("shares host lifecycle operations and never publishes running after stop during activation", async () => {
    const migration = deferred()
    const application = createBuiltinApplication({
        storage: new MemoryStorageBackend(),
        migration: { migrateLibrary: () => migration.promise },
    })
    const startup = application.start()
    expect(application.start()).toBe(startup)
    const stop = application.stop()
    expect(application.stop()).toBe(stop)
    expect(application.state).toBe("stopping")
    migration.resolve()
    await Promise.all([startup, stop])
    expect(application.state).toBe("stopped")
    await application.start()
    expect(application.state).toBe("stopped")
})

function installLocks() {
    let held = false
    const request = vi.fn(async (_name, _options, callback) => {
        if (held) return callback(null)
        held = true
        try {
            return await callback({ name: _name, mode: "exclusive" })
        } finally {
            held = false
        }
    })
    vi.stubGlobal("navigator", { locks: { request } })
    return {
        request,
        get held() {
            return held
        },
    }
}

it("opens the Reading workspace only for the owner, then gives retry a fresh fenced host", async () => {
    const locks = installLocks()
    vi.stubGlobal("Blob", NodeBlob)
    vi.stubGlobal("URL", NodeURL)
    const backends: MemoryStorageBackend[] = []
    const signals: AbortSignal[] = []
    const options = {
        storage: (lifetime) => {
            signals.push(lifetime.signal)
            const backend = new MemoryStorageBackend({ signal: lifetime.signal })
            backends.push(backend)
            return backend
        },
        migration: {
            migrateLibrary: async (library) => {
                await library.set("books.book", {
                    id: "book",
                    name: "Reading.fake",
                    type: "file",
                    parentId: null,
                    createdAt: 1,
                    updatedAt: 1,
                    isPinned: false,
                    size: 4,
                    metadata: { pageNumber: 1 },
                })
                await library.set("fileContents.book", { id: "book", file: new Blob(["text"]) })
            },
        },
    } satisfies Parameters<typeof createBrowserApplication>[0]
    const first = createBrowserApplication(options)
    const second = createBrowserApplication(options)
    try {
        await first.start()
        expect(first.state).toBe("running")
        first.application!.host.documentService.adapters.register({
            id: "integration.reader",
            extensions: ["fake"],
            mimeTypes: [],
            probe: async () => ({ supported: true }),
            open: async () => ({
                kind: "reflowable",
                metadata: { title: "Reading", author: null },
                capabilities: new Set(),
                getSections: async () => [{ id: "text", content: "text" }],
                close: async () => undefined,
            }),
        })
        const workspace = viewerStore.workspace
        await expect(workspace.open("book")).resolves.toBe(true)
        const document = await workspace.loadDocument()
        expect(document?.kind).toBe("reflowable")
        await second.start()
        await second.start()
        expect(second.state).toBe("blocked")
        expect(backends).toHaveLength(1)
        expect(locks.held).toBe(true)
        const stop = first.stop()
        expect(first.ready).toBe(false)
        expect(signals[0].aborted).toBe(true)
        expect(first.stop()).toBe(stop)
        await expect(first.executeCommand("library.book.open")).rejects.toThrow("not running")
        await stop
        expect(locks.held).toBe(false)
        await second.start()
        expect(second.ready).toBe(true)
        expect(signals).toHaveLength(2)
        expect(signals[1]).not.toBe(signals[0])
        await expect(backends[0].set("late", "obsolete")).rejects.toThrow()
        const library = createExtensionStorage(backends[1], "builtin.library").namespace("library")
        expect(await library.get("books.book")).toMatchObject({ name: "Reading.fake" })
        expect(
            locks.request.mock.calls.every(([name]) => name === locks.request.mock.calls[0][0]),
        ).toBe(true)
    } finally {
        await first.stop()
        await second.stop()
    }
})

it.each(["missing", "throwing", "rejecting", "stuck"] as const)(
    "fails closed with bounded feedback for %s exclusion capability",
    async (capability) => {
        vi.useFakeTimers()
        let lateCallback: ((lock: Lock) => unknown) | undefined
        const request =
            capability === "missing"
                ? undefined
                : vi.fn((_name, _options, callback) => {
                      if (capability === "throwing") throw new Error("Private capability failure")
                      if (capability === "rejecting")
                          return Promise.reject(new Error("Private rejection"))
                      lateCallback = callback
                      return new Promise(() => {})
                  })
        vi.stubGlobal("navigator", { locks: request ? { request } : undefined })
        const storage = vi.fn((lifetime) => new MemoryStorageBackend({ signal: lifetime.signal }))
        const application = createBrowserApplication({ storage, acquisitionMs: 10 })
        const startup = application.start()
        await vi.advanceTimersByTimeAsync(30)
        await startup
        expect(application.state).toBe(capability === "missing" ? "unsupported" : "failed")
        expect(application.ready).toBe(false)
        expect(storage).not.toHaveBeenCalled()
        lateCallback?.({ name: "late", mode: "exclusive" } as Lock)
        await Promise.resolve()
        expect(storage).not.toHaveBeenCalled()
        await application.stop()
    },
)

it("does not substitute a volatile Library when durable browser storage is unavailable", async () => {
    const locks = installLocks()
    vi.stubGlobal("indexedDB", undefined)
    const application = createBrowserApplication()
    await application.start()
    expect(application.state).toBe("failed")
    expect(application.ready).toBe(false)
    expect(application.application).toBeUndefined()
    expect(locks.held).toBe(false)
})

it("fails startup when required Library activation fails rather than trusting allSettled", async () => {
    const locks = installLocks()
    const application = createBrowserApplication({
        storage: (lifetime) => new MemoryStorageBackend({ signal: lifetime.signal }),
        migration: {
            migrateLibrary: async () => {
                throw new Error("Private migration failure")
            },
        },
    })
    await application.start()
    expect(application.state).toBe("failed")
    expect(application.application).toBeUndefined()
    expect(locks.held).toBe(false)
})

it("times out startup but retains ownership until a pending native schema open is physically quiescent", async () => {
    vi.useFakeTimers()
    const locks = installLocks()
    const migration = deferred()
    const request = Object.assign(new EventTarget(), { result: { close: vi.fn() } })
    let signal!: AbortSignal
    const application = createBrowserApplication({
        storage: (lifetime) => {
            signal = lifetime.signal
            lifetime.open({ open: () => request } as unknown as IDBFactory, "external-delayed-open")
            return new MemoryStorageBackend({ signal })
        },
        migration: { migrateLibrary: () => migration.promise },
        startupMs: 10,
        shutdownMs: 10,
    })
    const startup = application.start()
    await vi.advanceTimersByTimeAsync(30)
    await startup
    expect(application.state).toBe("recovery-required")
    expect(application.ready).toBe(false)
    expect(signal.aborted).toBe(true)
    expect(locks.held).toBe(true)
    const second = createBrowserApplication({
        storage: (lifetime) => new MemoryStorageBackend({ signal: lifetime.signal }),
    })
    await second.start()
    expect(second.state).toBe("blocked")
    request.dispatchEvent(new Event("success"))
    await vi.advanceTimersByTimeAsync(0)
    expect(request.result.close).toHaveBeenCalledOnce()
    expect(locks.held).toBe(false)
    migration.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(application.ready).toBe(false)
    expect(application.state).not.toBe("running")
    await second.stop()
})

it("stop cancels a pending acquisition and late callbacks cannot construct an obsolete host", async () => {
    let callback!: (lock: Lock) => unknown
    vi.stubGlobal("navigator", {
        locks: {
            request: (_name: string, _options: LockOptions, cb: (lock: Lock) => unknown) => {
                callback = cb
                return new Promise(() => {})
            },
        },
    })
    const storage = vi.fn((lifetime) => new MemoryStorageBackend({ signal: lifetime.signal }))
    const application = createBrowserApplication({ storage })
    const startup = application.start()
    await application.stop()
    callback({ name: "late", mode: "exclusive" } as Lock)
    await startup
    expect(application.state).toBe("stopped")
    expect(storage).not.toHaveBeenCalled()
})

it("revokes a running host if the ownership request unexpectedly rejects", async () => {
    let reject!: (error: Error) => void
    let signal!: AbortSignal
    vi.stubGlobal("navigator", {
        locks: {
            request: (name: string, _options: LockOptions, callback: (lock: Lock) => unknown) => {
                void callback({ name, mode: "exclusive" })
                return new Promise((_resolve, fail) => {
                    reject = fail
                })
            },
        },
    })
    const application = createBrowserApplication({
        storage: (lifetime) => {
            signal = lifetime.signal
            return new MemoryStorageBackend({ signal })
        },
        migration: { migrateLibrary: async () => undefined },
    })
    try {
        await application.start()
        expect(application.ready).toBe(true)
        reject(new Error("Exclusion capability stopped"))
        await vi.waitFor(() => expect(application.ready).toBe(false))
        expect(signal.aborted).toBe(true)
    } finally {
        await application.stop()
    }
})

it("bounds shutdown presentation without releasing a physical transaction before its terminal event", async () => {
    vi.useFakeTimers()
    const locks = installLocks()
    const transaction = Object.assign(new EventTarget(), { mode: "readwrite", abort: vi.fn() })
    const application = createBrowserApplication({
        storage: (lifetime) => {
            lifetime.trackTransaction(transaction as unknown as IDBTransaction)
            return new MemoryStorageBackend({ signal: lifetime.signal })
        },
        migration: { migrateLibrary: async () => undefined },
        shutdownMs: 10,
    })
    await application.start()
    expect(application.ready).toBe(true)
    const stopped = application.stop()
    expect(application.ready).toBe(false)
    expect(application.state).toBe("stopping")
    expect(transaction.abort).toHaveBeenCalledOnce()
    expect(locks.held).toBe(true)
    await vi.advanceTimersByTimeAsync(20)
    await stopped
    expect(application.state).toBe("recovery-required")
    expect(locks.held).toBe(true)
    // Neither timeout nor abort() returning proves that a native transaction is terminal.
    transaction.dispatchEvent(new Event("abort"))
    await vi.advanceTimersByTimeAsync(0)
    expect(locks.held).toBe(false)
    await application.start()
    expect(application.ready).toBe(false)
})

it.each(["acquiring", "starting"] as const)(
    "honors cancellation from %s feedback before constructing a host",
    async (feedbackState) => {
        installLocks()
        const storage = vi.fn((lifetime) => new MemoryStorageBackend({ signal: lifetime.signal }))
        const application = createBrowserApplication({
            storage,
            migration: { migrateLibrary: async () => undefined },
        })
        const subscription = application.onStateChange((state) => {
            if (state === feedbackState) void application.stop()
        })
        try {
            await application.start()
            await application.stop()
            expect(application.ready).toBe(false)
            expect(application.state).toBe("stopped")
            expect(storage).not.toHaveBeenCalled()
        } finally {
            subscription.dispose()
            await application.stop()
        }
    },
)
