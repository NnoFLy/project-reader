import { Dexie, type EntityTable, type Transaction } from "dexie"
import type {
    FolderNode,
    FileNode,
    BookPreview,
    FileContent,
    IndexedText,
    UserNote,
    Bookmark,
} from "../vfs/vfsStore.types"
import type { StorageNamespace } from "$lib/extension-api"

export type TableName =
    | "books"
    | "previews"
    | "folders"
    | "fileContents"
    | "indexedTexts"
    | "userNotes"
    | "bookmarks"

export async function migrateVersion2(tx: Transaction) {
    const books = await tx.table("books").toArray()

    for (const book of books) {
        if (book.file || book.handle) {
            await tx.table("fileContents").put({
                id: book.id,
                file: book.file,
                handle: book.handle,
            })
            delete book.file
            delete book.handle
            await tx.table("books").put(book)
        }
    }
}

interface IDBBooks {
    get(id: string): Promise<FileNode | undefined>
    put(book: FileNode): Promise<string>
    update(id: string, changes: Partial<FileNode>): Promise<number>
    bulkPut(books: FileNode[]): Promise<string>
    delete(id: string): Promise<void>
    bulkDelete(ids: string[]): Promise<void>
    getAll(): Promise<FileNode[]>
}

interface IDBBookPreviews {
    get(id: string): Promise<BookPreview | undefined>
    put(preview: BookPreview): Promise<string>
    bulkPut(previews: BookPreview[]): Promise<string>
    delete(id: string): Promise<void>
    bulkDelete(ids: string[]): Promise<void>
    getAll(): Promise<BookPreview[]>
}

interface IDBFileContents {
    get(id: string): Promise<FileContent | undefined>
    put(content: FileContent): Promise<string>
    bulkPut(contents: FileContent[]): Promise<string>
    delete(id: string): Promise<void>
    bulkDelete(ids: string[]): Promise<void>
    getAll(): Promise<FileContent[]>
}

interface IDBIndexedTexts {
    get(id: string): Promise<IndexedText | undefined>
    put(record: IndexedText): Promise<string>
    bulkPut(records: IndexedText[]): Promise<string>
    delete(id: string): Promise<void>
    bulkDelete(ids: string[]): Promise<void>
    getByBookId(bookId: string): Promise<IndexedText[]>
    getAll(): Promise<IndexedText[]>
    deleteByBookId(bookId: string): Promise<void>
}

interface IDBFolders {
    get(id: string): Promise<FolderNode | undefined>
    put(folder: FolderNode): Promise<string>
    update(id: string, changes: Partial<FolderNode>): Promise<number>
    bulkPut(folders: FolderNode[]): Promise<string>
    delete(id: string): Promise<void>
    bulkDelete(ids: string[]): Promise<void>
    getAll(): Promise<FolderNode[]>
}

interface IDBUserNotes {
    get(id: string): Promise<UserNote | undefined>
    put(record: UserNote): Promise<string>
    bulkPut(records: UserNote[]): Promise<string>
    delete(id: string): Promise<void>
    bulkDelete(ids: string[]): Promise<void>
    getByBookId(bookId: string): Promise<UserNote[]>
    getAll(): Promise<UserNote[]>
    deleteByBookId(bookId: string): Promise<void>
}

interface IDBBookmarks {
    get(id: string): Promise<Bookmark | undefined>
    put(record: Bookmark): Promise<string>
    bulkPut(records: Bookmark[]): Promise<string>
    delete(id: string): Promise<void>
    bulkDelete(ids: string[]): Promise<void>
    getByBookId(bookId: string): Promise<Bookmark[]>
    deleteByBookId(bookId: string): Promise<void>
    getAll(): Promise<Bookmark[]>
}

export interface IDatabase {
    files: IDBBooks
    previews: IDBBookPreviews
    folders: IDBFolders
    fileContents: IDBFileContents
    indexedTexts: IDBIndexedTexts
    userNotes: IDBUserNotes
    bookmarks: IDBBookmarks
    transaction<T>(mode: "r" | "rw", tables: TableName[], callback: () => Promise<T>): Promise<T>
}

export const LEGACY_LIBRARY_MIGRATION_VERSION = 1
export const LEGACY_LIBRARY_MIGRATION_MARKER = "legacy-dexie-migration"

type LegacyMigrationMarker = {
    version: number
    completed: boolean
}

type LegacyTable = {
    name: TableName
    storagePrefix: string
    read: (database: IDatabase) => Promise<unknown[]>
}

const LEGACY_TABLES: readonly LegacyTable[] = [
    { name: "books", storagePrefix: "books", read: (database) => database.files.getAll() },
    {
        name: "previews",
        storagePrefix: "previews",
        read: (database) => database.previews.getAll(),
    },
    { name: "folders", storagePrefix: "folders", read: (database) => database.folders.getAll() },
    {
        name: "fileContents",
        storagePrefix: "fileContents",
        read: (database) => database.fileContents.getAll(),
    },
    {
        name: "indexedTexts",
        storagePrefix: "indexedTexts",
        read: (database) => database.indexedTexts.getAll(),
    },
    {
        name: "userNotes",
        storagePrefix: "userNotes",
        read: (database) => database.userNotes.getAll(),
    },
    {
        name: "bookmarks",
        storagePrefix: "bookmarks",
        read: (database) => database.bookmarks.getAll(),
    },
]

const legacyMigrationPromises = new WeakMap<object, Promise<void>>()

/**
 * Copy the old application-owned Dexie records into the Library extension namespace.
 * The source is read-only throughout: a failed copy can leave destination retries, but never
 * destroys the only copy of a user's data. The optional database is used by tests and migration
 * tooling; normal activation opens the shared legacy database when IndexedDB is available.
 */
export function migrateLegacyDatabaseToLibrary(
    storage: StorageNamespace,
    legacyDatabase?: IDatabase,
): Promise<void> {
    const existing = legacyMigrationPromises.get(storage)
    if (existing) return existing
    if (!legacyDatabase && typeof indexedDB === "undefined") return Promise.resolve()

    const ownsDatabase = !legacyDatabase
    const database = legacyDatabase ?? new Database()
    const migration = (async () => {
        try {
            const marker = await storage.get<LegacyMigrationMarker>(LEGACY_LIBRARY_MIGRATION_MARKER)
            if (marker?.completed && marker.version >= LEGACY_LIBRARY_MIGRATION_VERSION) return

            await storage.set(LEGACY_LIBRARY_MIGRATION_MARKER, {
                version: LEGACY_LIBRARY_MIGRATION_VERSION,
                completed: false,
            } satisfies LegacyMigrationMarker)

            const records = await database.transaction(
                "r",
                LEGACY_TABLES.map((table) => table.name),
                async () => {
                    const result = new Map<string, unknown[]>()
                    for (const table of LEGACY_TABLES) {
                        result.set(table.name, await table.read(database))
                    }
                    return result
                },
            )

            for (const table of LEGACY_TABLES) {
                for (const record of records.get(table.name) ?? []) {
                    if (!isRecordWithId(record)) continue
                    const copy = cloneIfPossible(record)
                    const key = `${table.storagePrefix}.${record.id}`
                    await storage.set(key, copy)
                    const persisted = await storage.get<unknown>(key)
                    if (!(await equivalentCloneableValue(copy, persisted))) {
                        throw new Error(`Legacy library migration verification failed for ${key}`)
                    }
                }
            }

            await storage.set(LEGACY_LIBRARY_MIGRATION_MARKER, {
                version: LEGACY_LIBRARY_MIGRATION_VERSION,
                completed: true,
            } satisfies LegacyMigrationMarker)
        } finally {
            if (ownsDatabase) (database as Database).close()
        }
    })()
    legacyMigrationPromises.set(storage, migration)
    void migration.catch(() => {
        if (legacyMigrationPromises.get(storage) === migration)
            legacyMigrationPromises.delete(storage)
    })
    return migration
}

function isRecordWithId(value: unknown): value is Record<string, unknown> & { id: string } {
    return (
        typeof value === "object" &&
        value !== null &&
        typeof (value as { id?: unknown }).id === "string"
    )
}

function cloneIfPossible<T>(value: T): T {
    if (typeof structuredClone !== "function") return value
    try {
        return structuredClone(value)
    } catch {
        // Some browser versions expose FileSystemHandle without structured clone support. The
        // destination backend still gets the original capability and can decide whether it can
        // persist it, rather than silently dropping the handle.
        return value
    }
}

async function equivalentCloneableValue(left: unknown, right: unknown): Promise<boolean> {
    if (Object.is(left, right)) return true
    if (typeof Blob !== "undefined" && left instanceof Blob && right instanceof Blob) {
        if (left.size !== right.size || left.type !== right.type) return false
        const [leftBytes, rightBytes] = await Promise.all([left.arrayBuffer(), right.arrayBuffer()])
        return new Uint8Array(leftBytes).every(
            (byte, index) => byte === new Uint8Array(rightBytes)[index],
        )
    }
    if (Array.isArray(left) && Array.isArray(right)) {
        return (
            left.length === right.length &&
            (
                await Promise.all(
                    left.map((value, index) => equivalentCloneableValue(value, right[index])),
                )
            ).every(Boolean)
        )
    }
    if (isPlainRecord(left) && isPlainRecord(right)) {
        const leftKeys = Object.keys(left)
        const rightKeys = Object.keys(right)
        if (leftKeys.length !== rightKeys.length || leftKeys.some((key) => !(key in right)))
            return false
        return (
            await Promise.all(
                leftKeys.map((key) => equivalentCloneableValue(left[key], right[key])),
            )
        ).every(Boolean)
    }
    return false
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return (
        typeof value === "object" &&
        value !== null &&
        (typeof Blob === "undefined" || !(value instanceof Blob))
    )
}

let activeDatabaseOwners = 0
let sharedOpenPromise: Promise<void> | null = null

const db = new Dexie("Database") as Dexie & {
    books: EntityTable<FileNode, "id">
    previews: EntityTable<BookPreview, "id">
    folders: EntityTable<FolderNode, "id">
    fileContents: EntityTable<FileContent, "id">
    indexedTexts: EntityTable<IndexedText, "id">
    userNotes: EntityTable<UserNote, "id">
    bookmarks: EntityTable<Bookmark, "id">
}

db.version(1).stores({
    books: "id",
    previews: "id",
    folders: "id",
})

db.version(2)
    .stores({
        books: "id",
        previews: "id",
        folders: "id",
        fileContents: "id",
    })
    .upgrade(migrateVersion2)

db.version(3).stores({
    books: "id",
    previews: "id",
    folders: "id",
    fileContents: "id",
    indexedTexts: "id, bookId",
})

db.version(4).stores({
    books: "id",
    previews: "id",
    folders: "id",
    fileContents: "id",
    indexedTexts: "id, bookId",
    userNotes: "id, bookId, pageNumber",
})

db.version(5).stores({
    books: "id",
    previews: "id",
    folders: "id",
    fileContents: "id",
    indexedTexts: "id, bookId",
    userNotes: "id, bookId, pageNumber",
    bookmarks: "id, bookId, pageNumber",
})

class DBBooks implements IDBBooks {
    get(id: string): Promise<FileNode | undefined> {
        return db.books.get(id)
    }
    put(book: FileNode): Promise<string> {
        return db.books.put(book)
    }
    update(id: string, changes: Partial<FileNode>): Promise<number> {
        return db.books.update(id, changes)
    }
    bulkPut(books: FileNode[]): Promise<string> {
        return db.books.bulkPut(books)
    }
    delete(id: string): Promise<void> {
        return db.books.delete(id)
    }
    bulkDelete(ids: string[]): Promise<void> {
        return db.books.bulkDelete(ids)
    }
    getAll(): Promise<FileNode[]> {
        return db.books.toArray()
    }
}

class DBBookPreviews implements IDBBookPreviews {
    get(id: string): Promise<BookPreview | undefined> {
        return db.previews.get(id)
    }
    put(preview: BookPreview): Promise<string> {
        return db.previews.put(preview)
    }
    bulkPut(previews: BookPreview[]): Promise<string> {
        return db.previews.bulkPut(previews)
    }
    delete(id: string): Promise<void> {
        return db.previews.delete(id)
    }
    bulkDelete(ids: string[]): Promise<void> {
        return db.previews.bulkDelete(ids)
    }
    getAll(): Promise<BookPreview[]> {
        return db.previews.toArray()
    }
}

class DBFileContents implements IDBFileContents {
    get(id: string): Promise<FileContent | undefined> {
        return db.fileContents.get(id)
    }
    put(content: FileContent): Promise<string> {
        return db.fileContents.put(content)
    }
    bulkPut(contents: FileContent[]): Promise<string> {
        return db.fileContents.bulkPut(contents)
    }
    delete(id: string): Promise<void> {
        return db.fileContents.delete(id)
    }
    bulkDelete(ids: string[]): Promise<void> {
        return db.fileContents.bulkDelete(ids)
    }
    getAll(): Promise<FileContent[]> {
        return db.fileContents.toArray()
    }
}

class DBIndexedTexts implements IDBIndexedTexts {
    get(id: string): Promise<IndexedText | undefined> {
        return db.indexedTexts.get(id)
    }
    put(record: IndexedText): Promise<string> {
        return db.indexedTexts.put(record)
    }
    bulkPut(records: IndexedText[]): Promise<string> {
        return db.indexedTexts.bulkPut(records)
    }
    delete(id: string): Promise<void> {
        return db.indexedTexts.delete(id)
    }
    bulkDelete(ids: string[]): Promise<void> {
        return db.indexedTexts.bulkDelete(ids)
    }
    getByBookId(bookId: string): Promise<IndexedText[]> {
        return db.indexedTexts.where("bookId").equals(bookId).toArray()
    }
    getAll(): Promise<IndexedText[]> {
        return db.indexedTexts.toArray()
    }
    async deleteByBookId(bookId: string): Promise<void> {
        await db.indexedTexts.where("bookId").equals(bookId).delete()
    }
}

class DBUserNotes implements IDBUserNotes {
    get(id: string): Promise<UserNote | undefined> {
        return db.userNotes.get(id)
    }
    put(record: UserNote): Promise<string> {
        return db.userNotes.put(record)
    }
    bulkPut(records: UserNote[]): Promise<string> {
        return db.userNotes.bulkPut(records)
    }
    delete(id: string): Promise<void> {
        return db.userNotes.delete(id)
    }
    bulkDelete(ids: string[]): Promise<void> {
        return db.userNotes.bulkDelete(ids)
    }
    getByBookId(bookId: string): Promise<UserNote[]> {
        return db.userNotes.where("bookId").equals(bookId).toArray()
    }
    getAll(): Promise<UserNote[]> {
        return db.userNotes.toArray()
    }
    async deleteByBookId(bookId: string): Promise<void> {
        await db.userNotes.where("bookId").equals(bookId).delete()
    }
}

class DBFolders implements IDBFolders {
    get(id: string): Promise<FolderNode | undefined> {
        return db.folders.get(id)
    }
    put(folder: FolderNode): Promise<string> {
        return db.folders.put(folder)
    }
    update(id: string, changes: Partial<FolderNode>): Promise<number> {
        return db.folders.update(id, changes)
    }
    bulkPut(folders: FolderNode[]): Promise<string> {
        return db.folders.bulkPut(folders)
    }
    delete(id: string): Promise<void> {
        return db.folders.delete(id)
    }
    bulkDelete(ids: string[]): Promise<void> {
        return db.folders.bulkDelete(ids)
    }
    getAll(): Promise<FolderNode[]> {
        return db.folders.toArray()
    }
}

class DBBookmarks implements IDBBookmarks {
    get(id: string): Promise<Bookmark | undefined> {
        return db.bookmarks.get(id)
    }
    put(record: Bookmark): Promise<string> {
        return db.bookmarks.put(record)
    }
    bulkPut(records: Bookmark[]): Promise<string> {
        return db.bookmarks.bulkPut(records)
    }
    delete(id: string): Promise<void> {
        return db.bookmarks.delete(id)
    }
    bulkDelete(ids: string[]): Promise<void> {
        return db.bookmarks.bulkDelete(ids)
    }
    getByBookId(bookId: string): Promise<Bookmark[]> {
        return db.bookmarks.where("bookId").equals(bookId).toArray()
    }
    async deleteByBookId(bookId: string): Promise<void> {
        await db.bookmarks.where("bookId").equals(bookId).delete()
    }
    getAll(): Promise<Bookmark[]> {
        return db.bookmarks.toArray()
    }
}

function ensureDatabaseOpen(): Promise<void> | null {
    // Dexie probes indexedDB while opening. Avoid that probe during SSR, where the
    // global is intentionally unavailable.
    if (typeof indexedDB === "undefined") return null
    if (sharedOpenPromise) return sharedOpenPromise

    let openResult: PromiseLike<unknown>
    try {
        openResult = db.open()
    } catch (error) {
        openResult = Promise.reject(error)
    }
    const openPromise: Promise<void> = Promise.resolve(openResult).then(() => undefined)
    let handledPromise: Promise<void>
    handledPromise = openPromise.catch((error: unknown) => {
        // A rejected open must not poison all future owners. Dexie can retry once a
        // later owner asks for the shared connection again.
        if (sharedOpenPromise === handledPromise) sharedOpenPromise = null
        throw error
    })
    sharedOpenPromise = handledPromise
    return handledPromise
}

export class Database implements IDatabase {
    private closed = false

    files = this.guardTable(new DBBooks())
    previews = this.guardTable(new DBBookPreviews())
    folders = this.guardTable(new DBFolders())
    fileContents = this.guardTable(new DBFileContents())
    indexedTexts = this.guardTable(new DBIndexedTexts())
    userNotes = this.guardTable(new DBUserNotes())
    bookmarks = this.guardTable(new DBBookmarks())

    constructor() {
        activeDatabaseOwners += 1
        // Constructors are synchronous, so retain the promise for operations while
        // consuming the constructor's rejection to avoid an unhandled rejection.
        void ensureDatabaseOpen()?.catch(() => undefined)
    }

    private guardTable<T extends object>(table: T): T {
        return new Proxy(table, {
            get: (target, property, receiver) => {
                const value = Reflect.get(target, property, receiver)
                if (typeof value !== "function") return value
                return (...args: unknown[]) => {
                    if (this.closed) {
                        return Promise.reject(new Error("Database wrapper is closed"))
                    }
                    return Reflect.apply(value, target, args)
                }
            },
        })
    }

    transaction<T>(mode: "r" | "rw", tables: TableName[], callback: () => Promise<T>): Promise<T> {
        if (this.closed) return Promise.reject(new Error("Database wrapper is closed"))
        return db.transaction(mode, tables, callback)
    }

    close(): void {
        if (this.closed) return
        this.closed = true
        activeDatabaseOwners -= 1
        if (activeDatabaseOwners === 0) {
            db.close()
            sharedOpenPromise = null
        }
    }
}
