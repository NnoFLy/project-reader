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

type LibraryRecord = { id: string }
type TableName =
    | "books"
    | "previews"
    | "folders"
    | "fileContents"
    | "indexedTexts"
    | "userNotes"
    | "bookmarks"

type LibraryTable<T extends LibraryRecord> = {
    get(id: string): Promise<T | undefined>
    put(value: T): Promise<string>
    update(id: string, changes: Partial<T>): Promise<number>
    bulkPut(values: T[]): Promise<string>
    delete(id: string): Promise<void>
    bulkDelete(ids: string[]): Promise<void>
    getAll(): Promise<T[]>
}

type IndexedLibraryTable<T extends LibraryRecord & { bookId: string }> = LibraryTable<T> & {
    getByBookId(bookId: string): Promise<T[]>
    deleteByBookId(bookId: string): Promise<void>
}

type JournalEntry = {
    table: TableName
    id: string
    existed: boolean
    previous?: unknown
}

type TransactionJournal = {
    phase: "active" | "committed"
    entries: JournalEntry[]
}

const JOURNAL_KEY = "library-transaction-journal"

/** Storage-backed library metadata. The extension receives only its namespaced API. */
export class LibraryStorage {
    private queue = Promise.resolve()
    private readonly ready: Promise<void>
    private activeJournal: TransactionJournal | null = null
    private readonly storage: StorageNamespace
    private readonly tables: Record<TableName, StorageNamespace>

    constructor(storage: StorageNamespace) {
        this.storage = storage
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
        ) as Record<TableName, StorageNamespace>
        this.files = this.table<FileNode>("books")
        this.previews = this.table<BookPreview>("previews")
        this.folders = this.table<FolderNode>("folders")
        this.fileContents = this.table<FileContent>("fileContents")
        this.indexedTexts = this.indexedTable<IndexedText>("indexedTexts")
        this.userNotes = this.indexedTable<UserNote>("userNotes")
        this.bookmarks = this.indexedTable<Bookmark>("bookmarks", true)
        this.ready = this.repairJournal(storage)
    }

    readonly files: LibraryTable<FileNode>
    readonly previews: LibraryTable<BookPreview>
    readonly folders: LibraryTable<FolderNode>
    readonly fileContents: LibraryTable<FileContent>
    readonly indexedTexts: IndexedLibraryTable<IndexedText>
    readonly userNotes: IndexedLibraryTable<UserNote>
    readonly bookmarks: IndexedLibraryTable<Bookmark>

    /**
     * StorageNamespace has no multi-key transaction primitive. A durable journal makes the
     * sequence recoverable: every pre-write snapshot is persisted before that write, and an
     * interrupted active journal is compensated on the next LibraryStorage operation.
     */
    transaction<T>(mode: "r" | "rw", tables: string[], callback: () => Promise<T>): Promise<T> {
        void tables
        const operation = this.queue.then(async () => {
            await this.ready
            if (mode === "r") return callback()

            const journal: TransactionJournal = { phase: "active", entries: [] }
            const storage = this.storageForJournal()
            await storage.set(JOURNAL_KEY, journal)
            this.activeJournal = journal
            try {
                const result = await callback()
                journal.phase = "committed"
                await storage.set(JOURNAL_KEY, journal)
                await storage.delete(JOURNAL_KEY)
                return result
            } catch (error) {
                try {
                    await this.restoreJournal(journal)
                    await storage.delete(JOURNAL_KEY)
                } catch (rollbackError) {
                    // Keep the active journal if compensation itself fails. The next startup
                    // will retry it rather than reporting a silently partial transaction.
                    throw new AggregateError([error, rollbackError], "Library transaction failed")
                }
                throw error
            } finally {
                this.activeJournal = null
            }
        })
        this.queue = operation.then(
            () => undefined,
            () => undefined,
        )
        return operation
    }

    private storageForJournal(): StorageNamespace {
        return this.storage
    }

    private enqueueTableWrite<T>(operation: () => Promise<T>): Promise<T> {
        // Transaction callbacks already run inside the queue. Re-entering the queue here
        // would deadlock the callback, so their table writes use the active journal directly.
        if (this.activeJournal) return operation()
        const task = this.queue.then(async () => {
            await this.ready
            return operation()
        })
        this.queue = task.then(
            () => undefined,
            () => undefined,
        )
        return task
    }

    private async repairJournal(storage: StorageNamespace): Promise<void> {
        const journal = await storage.get<TransactionJournal>(JOURNAL_KEY)
        if (!journal) return
        if (journal.phase === "committed") {
            await storage.delete(JOURNAL_KEY)
            return
        }
        await this.restoreJournal(journal)
        await storage.delete(JOURNAL_KEY)
    }

    private async recordBeforeMutation(table: TableName, id: string): Promise<void> {
        const journal = this.activeJournal
        if (!journal || journal.entries.some((entry) => entry.table === table && entry.id === id))
            return
        const current = await this.tables[table].get<unknown>(id)
        journal.entries.push({
            table,
            id,
            existed: current !== undefined,
            ...(current === undefined ? {} : { previous: current }),
        })
        await this.storageForJournal().set(JOURNAL_KEY, journal)
    }

    private async restoreJournal(journal: TransactionJournal): Promise<void> {
        for (const entry of [...journal.entries].reverse()) {
            const table = this.tables[entry.table]
            if (entry.existed && entry.previous !== undefined)
                await table.set(entry.id, entry.previous)
            else await table.delete(entry.id)
        }
    }

    private table<T extends LibraryRecord>(name: TableName): LibraryTable<T> {
        const storage = this.tables[name]
        return {
            get: async (id) => {
                await this.ready
                return storage.get<T>(id)
            },
            put: (value) =>
                this.enqueueTableWrite(async () => {
                    await this.recordBeforeMutation(name, value.id)
                    await storage.set(value.id, value)
                    return value.id
                }),
            update: (id, changes) =>
                this.enqueueTableWrite(async () => {
                    const current = await storage.get<T>(id)
                    if (!current) return 0
                    await this.recordBeforeMutation(name, id)
                    await storage.set(id, { ...current, ...changes })
                    return 1
                }),
            bulkPut: (values) =>
                this.enqueueTableWrite(async () => {
                    for (const value of values) {
                        await this.recordBeforeMutation(name, value.id)
                        await storage.set(value.id, value)
                    }
                    return values.at(-1)?.id ?? ""
                }),
            delete: (id) =>
                this.enqueueTableWrite(async () => {
                    await this.recordBeforeMutation(name, id)
                    await storage.delete(id)
                }),
            bulkDelete: (ids) =>
                this.enqueueTableWrite(async () => {
                    for (const id of ids) {
                        await this.recordBeforeMutation(name, id)
                        await storage.delete(id)
                    }
                }),
            getAll: async () => {
                await this.ready
                const values: Array<T | undefined> = await Promise.all(
                    (await storage.keys()).map(async (id) => storage.get<T>(id)),
                )
                return values.filter((value): value is T => value !== undefined)
            },
        }
    }

    private indexedTable<T extends LibraryRecord & { bookId: string }>(
        name: TableName,
        getAll = false,
    ): IndexedLibraryTable<T> {
        const table = this.table<T>(name)
        return {
            ...table,
            getByBookId: async (bookId) =>
                (await table.getAll()).filter((value) => value.bookId === bookId),
            deleteByBookId: async (bookId) => {
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
