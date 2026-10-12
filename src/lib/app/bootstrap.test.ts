import { describe, expect, it, vi } from "vitest"
import { IndexedDBStorageBackend, MemoryStorageBackend, type StorageBackend } from "../core/storage"
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
