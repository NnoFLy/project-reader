// @ts-nocheck
import type { StorageNamespace } from "$lib/extension-api"
import type {
    Bookmark,
    BookPreview,
    FileContent,
    FileNode,
    FolderNode,
    IndexedText,
    UserNote,
} from "./libraryStore.types"

/** Storage-backed library metadata. The extension receives only its namespaced API. */
export class LibraryStorage {
    private queue = Promise.resolve()
    private readonly tables: Record<string, StorageNamespace>

    constructor(storage: StorageNamespace) {
        this.tables = Object.fromEntries(
            [
                "books",
                "previews",
                "folders",
                "fileContents",
                "indexedTexts",
                "userNotes",
                "bookmarks",
            ].map((name) => [name, tableStorage(storage, name)]),
        )
        this.files = this.table<FileNode>("books")
        this.previews = this.table<BookPreview>("previews")
        this.folders = this.table<FolderNode>("folders")
        this.fileContents = this.table<FileContent>("fileContents")
        this.indexedTexts = this.indexedTable<IndexedText>("indexedTexts")
        this.userNotes = this.indexedTable<UserNote>("userNotes")
        this.bookmarks = this.indexedTable<Bookmark>("bookmarks", true)
    }

    readonly files: any
    readonly previews: any
    readonly folders: any
    readonly fileContents: any
    readonly indexedTexts: any
    readonly userNotes: any
    readonly bookmarks: any

    transaction<T>(_mode: "r" | "rw", _tables: string[], callback: () => Promise<T>): Promise<T> {
        const operation = this.queue.then(callback, callback)
        this.queue = operation.then(
            () => undefined,
            () => undefined,
        )
        return operation
    }

    private table<T extends { id: string }>(name: string) {
        const storage = this.tables[name]
        return {
            get: (id: string) => storage.get<T>(id),
            put: async (value: T) => {
                await storage.set(value.id, value)
                return value.id
            },
            update: async (id: string, changes: Partial<T>) => {
                const current = await storage.get<T>(id)
                if (!current) return 0
                await storage.set(id, { ...current, ...changes })
                return 1
            },
            bulkPut: async (values: T[]) => {
                for (const value of values) await storage.set(value.id, value)
                return values.at(-1)?.id ?? ""
            },
            delete: (id: string) => storage.delete(id),
            bulkDelete: async (ids: string[]) => {
                for (const id of ids) await storage.delete(id)
            },
            getAll: async () => {
                const values = await Promise.all(
                    (await storage.keys()).map((id) => storage.get<T>(id)),
                )
                return values.filter((value): value is T => value !== undefined)
            },
        }
    }

    private indexedTable<T extends { id: string; bookId: string }>(name: string, getAll = false) {
        const table = this.table<T>(name)
        return {
            ...table,
            getByBookId: async (bookId: string) =>
                (await table.getAll()).filter((value) => value.bookId === bookId),
            deleteByBookId: async (bookId: string) => {
                for (const value of await table.getAll()) {
                    if (value.bookId === bookId) await table.delete(value.id)
                }
            },
            ...(getAll ? { getAll: table.getAll } : {}),
        }
    }
}

function tableStorage(storage: StorageNamespace, prefix: string): StorageNamespace {
    const key = (id: string) => `${prefix}.${id}`
    return {
        get: <T>(id: string) => storage.get<T>(key(id)),
        set: <T>(id: string, value: T) => storage.set(key(id), value),
        delete: (id: string) => storage.delete(key(id)),
        has: (id: string) => storage.has(key(id)),
        keys: async () =>
            (await storage.keys())
                .filter((id) => id.startsWith(`${prefix}.`))
                .map((id) => id.slice(prefix.length + 1)),
        clear: async () => {
            for (const id of await storage.keys()) {
                if (id.startsWith(`${prefix}.`)) await storage.delete(id)
            }
        },
    }
}
