import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { closeSpy, openSpy } = vi.hoisted(() => ({
    closeSpy: vi.fn(),
    openSpy: vi.fn(() => Promise.resolve()),
}))

vi.mock("dexie", () => {
    class MockDexie {
        books = { get: vi.fn(async () => undefined) }
        previews = { get: vi.fn(async () => undefined) }
        folders = { get: vi.fn(async () => undefined) }
        fileContents = { get: vi.fn(async () => undefined) }
        indexedTexts = { get: vi.fn(async () => undefined) }
        userNotes = { get: vi.fn(async () => undefined) }
        bookmarks = { get: vi.fn(async () => undefined) }

        version(_version: number) {
            return {
                stores: () => ({ upgrade: () => undefined }),
            }
        }

        transaction(_mode: unknown, _tables: unknown, callback: () => Promise<unknown>) {
            return callback()
        }

        open() {
            return openSpy()
        }

        close() {
            closeSpy()
        }
    }

    return { Dexie: MockDexie }
})

import {
    Database,
    LEGACY_LIBRARY_MIGRATION_MARKER,
    migrateLegacyDatabaseToLibrary,
    migrateVersion2,
    type IDatabase,
} from "./db"
import type { StorageNamespace } from "$lib/extension-api"

function createTestStorage(): StorageNamespace {
    const values = new Map<string, unknown>()
    return {
        get: async <T>(key: string) => values.get(key) as T | undefined,
        set: async <T>(key: string, value: T) => {
            values.set(key, value)
        },
        delete: async (key: string) => {
            values.delete(key)
        },
        has: async (key: string) => values.has(key),
        keys: async () => [...values.keys()],
        clear: async () => values.clear(),
    }
}

beforeEach(() => {
    vi.stubGlobal("indexedDB", {})
})

afterEach(() => {
    vi.clearAllMocks()
    vi.unstubAllGlobals()
})

describe("Version 2 migration", () => {
    it("moves legacy file content before removing it from the book", async () => {
        const book = { id: "book", file: "legacy content", handle: "legacy handle" }
        const fileContentsPut = vi.fn(async (content: unknown) => content)
        const booksPut = vi.fn(async (value: unknown) => value)
        const tx = {
            table: vi.fn((name: string) =>
                name === "books"
                    ? { toArray: vi.fn(async () => [book]), put: booksPut }
                    : { put: fileContentsPut },
            ),
        } as unknown as Parameters<typeof migrateVersion2>[0]

        await migrateVersion2(tx)

        expect(fileContentsPut).toHaveBeenCalledWith({
            id: "book",
            file: "legacy content",
            handle: "legacy handle",
        })
        expect(booksPut).toHaveBeenCalledWith({ id: "book" })
        expect(book).toEqual({ id: "book" })
    })

    it("propagates content migration failures so the upgrade can abort", async () => {
        const book = { id: "book", file: "legacy content", handle: "legacy handle" }
        const migrationError = new Error("content write failed")
        const fileContentsPut = vi.fn().mockRejectedValue(migrationError)
        const booksPut = vi.fn(async (value: unknown) => value)
        const tx = {
            table: vi.fn((name: string) =>
                name === "books"
                    ? { toArray: vi.fn(async () => [book]), put: booksPut }
                    : { put: fileContentsPut },
            ),
        } as unknown as Parameters<typeof migrateVersion2>[0]

        await expect(migrateVersion2(tx)).rejects.toBe(migrationError)
        expect(booksPut).not.toHaveBeenCalled()
        expect(book).toEqual({
            id: "book",
            file: "legacy content",
            handle: "legacy handle",
        })
    })
})

describe("Legacy Library migration", () => {
    it("copies every legacy table without changing source records and records completion", async () => {
        const sourceRecords = {
            books: [{ id: "book", name: "Book" }],
            previews: [{ id: "book", data: new Blob(["preview"]) }],
            folders: [{ id: "folder", name: "Folder" }],
            fileContents: [
                { id: "book", file: new Blob(["content"]), handle: { name: "book.pdf" } },
            ],
            indexedTexts: [{ id: "text", bookId: "book", pageNumber: 1, text: "text" }],
            userNotes: [{ id: "note", bookId: "book", pageNumber: 1 }],
            bookmarks: [{ id: "bookmark", bookId: "book", pageNumber: 1 }],
        }
        const table = <T>(name: keyof typeof sourceRecords) => ({
            getAll: vi.fn(async () => sourceRecords[name] as T[]),
        })
        const source = {
            files: table("books"),
            previews: table("previews"),
            folders: table("folders"),
            fileContents: table("fileContents"),
            indexedTexts: table("indexedTexts"),
            userNotes: table("userNotes"),
            bookmarks: table("bookmarks"),
            transaction: vi.fn(
                async (_mode: unknown, _tables: unknown, callback: () => Promise<unknown>) =>
                    callback(),
            ),
        } as unknown as IDatabase
        const storage = createTestStorage()

        await migrateLegacyDatabaseToLibrary(storage, source)

        expect(await storage.get("books.book")).toEqual(sourceRecords.books[0])
        expect(await storage.get("previews.book")).toEqual(sourceRecords.previews[0])
        expect(await storage.get("fileContents.book")).toEqual(sourceRecords.fileContents[0])
        expect(await storage.get(LEGACY_LIBRARY_MIGRATION_MARKER)).toEqual({
            version: 1,
            completed: true,
        })
        expect(sourceRecords.fileContents[0].file).toBeInstanceOf(Blob)
        await migrateLegacyDatabaseToLibrary(storage, source)
        expect(source.transaction).toHaveBeenCalledOnce()
    })

    it("leaves the source intact and retries after a destination failure", async () => {
        const sourceBook = { id: "book", name: "Book" }
        const source = {
            files: { getAll: vi.fn(async () => [sourceBook]) },
            previews: { getAll: vi.fn(async () => []) },
            folders: { getAll: vi.fn(async () => []) },
            fileContents: { getAll: vi.fn(async () => []) },
            indexedTexts: { getAll: vi.fn(async () => []) },
            userNotes: { getAll: vi.fn(async () => []) },
            bookmarks: { getAll: vi.fn(async () => []) },
            transaction: vi.fn(
                async (_mode: unknown, _tables: unknown, callback: () => Promise<unknown>) =>
                    callback(),
            ),
        } as unknown as IDatabase
        const storage = createTestStorage()
        const originalSet = storage.set.bind(storage)
        let fail = true
        storage.set = async (key, value) => {
            if (fail && key === "books.book") {
                fail = false
                throw new Error("copy failed")
            }
            return originalSet(key, value)
        }

        await expect(migrateLegacyDatabaseToLibrary(storage, source)).rejects.toThrow("copy failed")
        expect(sourceBook).toEqual({ id: "book", name: "Book" })
        await migrateLegacyDatabaseToLibrary(storage, source)
        expect(await storage.get("books.book")).toEqual(sourceBook)
    })
})

describe("Database ownership", () => {
    it("only closes the shared Dexie database after the final wrapper closes", () => {
        const first = new Database()
        const second = new Database()

        first.close()
        expect(closeSpy).not.toHaveBeenCalled()

        second.close()
        expect(closeSpy).toHaveBeenCalledOnce()

        second.close()
        expect(closeSpy).toHaveBeenCalledOnce()
    })

    it("reopens the shared Dexie database for a new owner after the final close", () => {
        const first = new Database()
        first.close()
        openSpy.mockClear()

        const second = new Database()

        expect(openSpy).toHaveBeenCalledOnce()
        second.close()
    })

    it("allows a later owner to retry after a shared open failure", async () => {
        openSpy.mockRejectedValueOnce(new Error("open failed"))
        const first = new Database()
        await Promise.resolve()
        await Promise.resolve()

        const second = new Database()

        expect(openSpy).toHaveBeenCalledTimes(2)
        first.close()
        second.close()
    })

    it("does not open Dexie during SSR", () => {
        vi.unstubAllGlobals()
        const owner = new Database()

        expect(openSpy).not.toHaveBeenCalled()
        owner.close()
    })

    it("rejects closed-wrapper table and transaction operations without closing shared viewers", async () => {
        const first = new Database()
        const second = new Database()

        first.close()

        await expect(first.files.get("book")).rejects.toThrow("closed")
        await expect(first.transaction("r", ["books"], async () => undefined)).rejects.toThrow(
            "closed",
        )
        await expect(second.files.get("book")).resolves.toBeUndefined()

        second.close()
    })
})
