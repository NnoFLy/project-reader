import { describe, expect, it, vi } from "vitest"
import { IndexedDBStorageBackend, MemoryStorageBackend, type StorageBackend } from "../core/storage"
import type { StorageNamespace } from "../extension-api"
import { getBuiltinDocumentLoader } from "../extensions/builtin"
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

    it("injects the host migration without constructing the legacy VFS", async () => {
        const storage = new MemoryStorageBackend()
        const migrateLibrary = vi.fn(async (libraryStorage: StorageNamespace) => {
            await libraryStorage.set("books.legacy", { id: "legacy", name: "Legacy book" })
        })
        const application = createBuiltinApplication({
            storage,
            migration: { migrateLibrary },
        })

        await application.start()

        expect(migrateLibrary).toHaveBeenCalledOnce()
        expect(await storage.get("extension:builtin.library:library:books.legacy")).toEqual({
            id: "legacy",
            name: "Legacy book",
        })
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

    it("recreates builtin host capabilities across application stop and start", async () => {
        const first = createBuiltinApplication({ storage: new MemoryStorageBackend() })
        await first.start()
        await first.stop()
        expect(() => getBuiltinDocumentLoader()).toThrow(
            "The application document service has not been installed",
        )

        const second = createBuiltinApplication({ storage: new MemoryStorageBackend() })
        await expect(second.start()).resolves.toBeUndefined()
        expect(second.state).toBe("running")
        await second.stop()
    })

    it("wires viewer loading to the host service and activates PDF through the host", async () => {
        const application = createBuiltinApplication()
        const open = vi
            .spyOn(application.host.documentService, "open")
            .mockRejectedValue(new Error("stop after wiring"))
        vi.stubGlobal(
            "fetch",
            vi.fn(async () => new Response(new Blob(["%PDF-test"]), { status: 200 })),
        )

        await expect(
            getBuiltinDocumentLoader().open({ id: "book", name: "book.pdf", url: "blob:book" }),
        ).rejects.toThrow("stop after wiring")
        expect(application.host.documentService.adapters.get("builtin.pdf.document")).toBeDefined()
        expect(open).toHaveBeenCalledOnce()

        await application.stop()
        vi.unstubAllGlobals()
    })
})
