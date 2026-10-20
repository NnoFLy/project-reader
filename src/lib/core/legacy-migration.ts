import { Dexie, type Transaction } from "dexie"
import type { StorageNamespace } from "../extension-api"
import type { IndexedDBWriteLifetime } from "./storage"

export const LEGACY_LIBRARY_MIGRATION_VERSION = 1
export const LEGACY_LIBRARY_MIGRATION_MARKER = "legacy-dexie-migration"

type LegacyMigrationMarker = {
    version: number
    completed: boolean
}

type LegacyRecord = Record<string, unknown> & { id: string }
type LegacyTableName =
    | "books"
    | "previews"
    | "folders"
    | "fileContents"
    | "indexedTexts"
    | "userNotes"
    | "bookmarks"

export interface LegacyDatabase {
    files: { getAll(): Promise<unknown[]> }
    previews: { getAll(): Promise<unknown[]> }
    folders: { getAll(): Promise<unknown[]> }
    fileContents: { getAll(): Promise<unknown[]> }
    indexedTexts: { getAll(): Promise<unknown[]> }
    userNotes: { getAll(): Promise<unknown[]> }
    bookmarks: { getAll(): Promise<unknown[]> }
    transaction<T>(
        mode: "r" | "rw",
        tables: LegacyTableName[],
        callback: () => Promise<T>,
    ): Promise<T>
    close(): void
}

type LegacyTable = {
    name: LegacyTableName
    storagePrefix: string
    read: (database: LegacyDatabase) => Promise<unknown[]>
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

const migrationPromises = new WeakMap<object, Promise<void>>()

/** Import the old document records without loading the legacy VFS store. */
export function migrateLegacyDatabaseToLibrary(
    storage: StorageNamespace,
    legacyDatabase?: LegacyDatabase,
    options: { lifetime?: IndexedDBWriteLifetime; indexedDB?: IDBFactory } = {},
): Promise<void> {
    const existing = migrationPromises.get(storage)
    if (existing) return existing
    if (!legacyDatabase && !options.indexedDB && typeof indexedDB === "undefined")
        return Promise.resolve()

    const ownsDatabase = !legacyDatabase
    let database = legacyDatabase
    const migration = (async () => {
        try {
            options.lifetime?.assertWritable()
            const marker = await storage.get<LegacyMigrationMarker>(LEGACY_LIBRARY_MIGRATION_MARKER)
            if (marker?.completed && marker.version >= LEGACY_LIBRARY_MIGRATION_VERSION) return

            options.lifetime?.assertWritable()
            if (!database) database = createLegacyDatabase(options)
            const source = database
            await storage.set(LEGACY_LIBRARY_MIGRATION_MARKER, {
                version: LEGACY_LIBRARY_MIGRATION_VERSION,
                completed: false,
            } satisfies LegacyMigrationMarker)

            options.lifetime?.assertWritable()
            const records = await source.transaction(
                "r",
                LEGACY_TABLES.map((table) => table.name),
                async () => {
                    const result = new Map<string, unknown[]>()
                    for (const table of LEGACY_TABLES) {
                        result.set(table.name, await table.read(source))
                    }
                    return result
                },
            )

            for (const table of LEGACY_TABLES) {
                for (const record of records.get(table.name) ?? []) {
                    if (!isRecordWithId(record)) continue
                    const copy = cloneIfPossible(record)
                    const key = `${table.storagePrefix}.${record.id}`
                    options.lifetime?.assertWritable()
                    await storage.set(key, copy)
                    const persisted = await storage.get<unknown>(key)
                    if (!(await equivalentCloneableValue(copy, persisted))) {
                        throw new Error(`Legacy library migration verification failed for ${key}`)
                    }
                }
            }

            options.lifetime?.assertWritable()
            await storage.set(LEGACY_LIBRARY_MIGRATION_MARKER, {
                version: LEGACY_LIBRARY_MIGRATION_VERSION,
                completed: true,
            } satisfies LegacyMigrationMarker)
        } finally {
            if (ownsDatabase) database?.close()
        }
    })()
    migrationPromises.set(storage, migration)
    void migration.catch(() => {
        if (migrationPromises.get(storage) === migration) migrationPromises.delete(storage)
    })
    return migration
}

class DexieLegacyDatabase implements LegacyDatabase {
    constructor(private readonly database: Dexie) {}

    files = this.table("books")
    previews = this.table("previews")
    folders = this.table("folders")
    fileContents = this.table("fileContents")
    indexedTexts = this.table("indexedTexts")
    userNotes = this.table("userNotes")
    bookmarks = this.table("bookmarks")

    transaction<T>(
        mode: "r" | "rw",
        tables: LegacyTableName[],
        callback: () => Promise<T>,
    ): Promise<T> {
        return this.database.transaction(mode, tables, callback)
    }

    close(): void {
        this.database.close()
    }

    private table(name: string): { getAll(): Promise<unknown[]> } {
        return { getAll: () => this.database.table(name).toArray() }
    }
}

function createLegacyDatabase(options: {
    lifetime?: IndexedDBWriteLifetime
    indexedDB?: IDBFactory
}): LegacyDatabase {
    const factory = options.indexedDB ?? globalThis.indexedDB
    const lifetime = options.lifetime
    // Dexie opens lazily. Fence the native request, including schema upgrades
    // delivered after a blocked open outlives the host that initiated it.
    const indexedDB = lifetime
        ? new Proxy(factory, {
              get(target, key) {
                  if (key === "open") {
                      return (name: string, version?: number) =>
                          lifetime.open(target, name, version)
                  }
                  const value = Reflect.get(target, key)
                  return typeof value === "function" ? value.bind(target) : value
              },
          })
        : factory
    const database = new Dexie("Database", { indexedDB })
    database.version(1).stores({ books: "id", previews: "id", folders: "id" })
    database
        .version(2)
        .stores({
            books: "id",
            previews: "id",
            folders: "id",
            fileContents: "id",
        })
        .upgrade(migrateVersion2)
    database.version(3).stores({
        books: "id",
        previews: "id",
        folders: "id",
        fileContents: "id",
        indexedTexts: "id, bookId",
    })
    database.version(4).stores({
        books: "id",
        previews: "id",
        folders: "id",
        fileContents: "id",
        indexedTexts: "id, bookId",
        userNotes: "id, bookId, pageNumber",
    })
    database.version(5).stores({
        books: "id",
        previews: "id",
        folders: "id",
        fileContents: "id",
        indexedTexts: "id, bookId",
        userNotes: "id, bookId, pageNumber",
        bookmarks: "id, bookId, pageNumber",
    })
    return new DexieLegacyDatabase(database)
}

async function migrateVersion2(tx: Transaction): Promise<void> {
    const books = await tx.table("books").toArray()
    for (const book of books as Array<Record<string, unknown> & { id: string }>) {
        if (!book.file && !book.handle) continue
        await tx.table("fileContents").put({ id: book.id, file: book.file, handle: book.handle })
        delete book.file
        delete book.handle
        await tx.table("books").put(book)
    }
}

function isRecordWithId(value: unknown): value is LegacyRecord {
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
