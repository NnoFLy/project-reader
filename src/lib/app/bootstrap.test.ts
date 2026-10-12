import { describe, expect, it, vi } from "vitest"
import { IndexedDBStorageBackend, MemoryStorageBackend, type StorageBackend } from "../core/storage"
import { createBuiltinApplication } from "./bootstrap"

function hostStorage(application: ReturnType<typeof createBuiltinApplication>): StorageBackend {
    return (application.host as unknown as { storage: StorageBackend }).storage
}

describe("built-in application bootstrap", () => {
    it("passes a caller-provided storage backend through to the built-in host", async () => {
        const storage = new MemoryStorageBackend()
        const application = createBuiltinApplication({ storage })

        expect(hostStorage(application)).toBe(storage)
        await application.stop()
    })

    it("uses IndexedDB storage when it is available", async () => {
        vi.stubGlobal("indexedDB", {} as IDBFactory)
        const application = createBuiltinApplication()

        expect(hostStorage(application)).toBeInstanceOf(IndexedDBStorageBackend)
        await application.stop()
        vi.unstubAllGlobals()
    })

    it("falls back to memory storage when IndexedDB is unavailable", async () => {
        vi.stubGlobal("indexedDB", undefined)
        const application = createBuiltinApplication()

        expect(hostStorage(application)).toBeInstanceOf(MemoryStorageBackend)
        await application.stop()
        vi.unstubAllGlobals()
    })
})
