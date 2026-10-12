import { describe, expect, it } from "vitest"
import { createExtensionStorage, MemoryStorageBackend } from "$lib/core/storage"
import { LibraryStorage } from "./libraryStorage"

class FailingBackend extends MemoryStorageBackend {
    failSuffix: string | null = null

    override async set(key: string, value: unknown): Promise<void> {
        if (this.failSuffix && key.endsWith(this.failSuffix)) {
            this.failSuffix = null
            throw new Error("simulated write failure")
        }
        return super.set(key, value)
    }
}

describe("LibraryStorage transaction recovery", () => {
    it("compensates earlier table writes when a later write fails", async () => {
        const backend = new FailingBackend()
        const namespace = createExtensionStorage(backend, "builtin.library").namespace("library")
        const storage = new LibraryStorage(namespace)
        const book = {
            id: "book",
            name: "Book",
            type: "file" as const,
            parentId: null,
            createdAt: 0,
            updatedAt: 0,
            isPinned: false,
            size: 0,
            metadata: { pageNumber: 1 },
        }
        const folder = {
            id: "folder",
            name: "Folder",
            type: "folder" as const,
            parentId: null,
            createdAt: 0,
            updatedAt: 0,
            isPinned: false,
            childrenIds: [],
        }
        backend.failSuffix = ":folders.folder"

        await expect(
            storage.transaction("rw", ["books", "folders"], async () => {
                await storage.files.put(book)
                await storage.folders.put(folder)
            }),
        ).rejects.toThrow("Unable to persist storage value")

        expect(await storage.files.get("book")).toBeUndefined()
        expect(await storage.folders.get("folder")).toBeUndefined()
    })

    it("repairs an active journal before exposing records", async () => {
        const backend = new MemoryStorageBackend()
        const namespace = createExtensionStorage(backend, "builtin.library").namespace("library")
        await namespace.set("books.orphan", { id: "orphan" })
        await namespace.set("library-transaction-journal", {
            phase: "active",
            entries: [{ table: "books", id: "orphan", existed: false }],
        })

        const storage = new LibraryStorage(namespace)
        expect(await storage.files.get("orphan")).toBeUndefined()
        expect(await namespace.get("library-transaction-journal")).toBeUndefined()
    })
})
