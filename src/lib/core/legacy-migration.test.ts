import { describe, expect, it, vi } from "vitest"
import type { StorageNamespace } from "../extension-api"
import {
    LEGACY_LIBRARY_MIGRATION_MARKER,
    migrateLegacyDatabaseToLibrary,
    type LegacyDatabase,
} from "./legacy-migration"

function createStorage(): StorageNamespace {
    const values = new Map<string, unknown>()
    return {
        get: async <T>(key: string) => values.get(key) as T | undefined,
        set: async <T>(key: string, value: T) => void values.set(key, value),
        delete: async (key: string) => void values.delete(key),
        has: async (key: string) => values.has(key),
        keys: async () => [...values.keys()],
        clear: async () => void values.clear(),
    }
}

describe("host-owned legacy migration", () => {
    it("preserves source records and remains idempotent", async () => {
        const sourceRecords = {
            books: [{ id: "book", name: "Legacy book" }],
            previews: [{ id: "book", data: new Blob(["preview"]) }],
            folders: [],
            fileContents: [{ id: "book", file: new Blob(["content"]) }],
            indexedTexts: [],
            userNotes: [],
            bookmarks: [],
        }
        const table = (name: keyof typeof sourceRecords) => ({
            getAll: vi.fn(async () => sourceRecords[name]),
        })
        const source = {
            files: table("books"),
            previews: table("previews"),
            folders: table("folders"),
            fileContents: table("fileContents"),
            indexedTexts: table("indexedTexts"),
            userNotes: table("userNotes"),
            bookmarks: table("bookmarks"),
            transaction: vi.fn(async (_mode, _tables, callback) => callback()),
            close: vi.fn(),
        } satisfies LegacyDatabase
        const storage = createStorage()

        await migrateLegacyDatabaseToLibrary(storage, source)
        await migrateLegacyDatabaseToLibrary(storage, source)

        expect(await storage.get("books.book")).toEqual(sourceRecords.books[0])
        expect(await storage.get("fileContents.book")).toEqual(sourceRecords.fileContents[0])
        expect(await storage.get(LEGACY_LIBRARY_MIGRATION_MARKER)).toEqual({
            version: 1,
            completed: true,
        })
        expect(sourceRecords.fileContents[0].file).toBeInstanceOf(Blob)
        expect(source.transaction).toHaveBeenCalledOnce()
        expect(source.close).not.toHaveBeenCalled()
    })
})
