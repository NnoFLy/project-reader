import {
    assertStorageKey,
    StorageError,
    type Disposable,
    type ExtensionStorage,
    type StorageNamespace,
} from "../../extension-api"

type StoredValue = unknown

export interface StorageBackend {
    get(key: string): Promise<StoredValue | undefined>
    set(key: string, value: StoredValue): Promise<void>
    delete(key: string): Promise<void>
    keys(prefix?: string): Promise<readonly string[]>
}

export class MemoryStorageBackend implements StorageBackend {
    private readonly values = new Map<string, StoredValue>()
    private readonly limit?: number
    private readonly signal?: AbortSignal

    constructor(options?: { quota?: number; signal?: AbortSignal }) {
        this.limit = options?.quota
        this.signal = options?.signal
    }

    /** Memory mutations are synchronous; no physical writes remain after revocation. */
    whenQuiescent(): Promise<void> {
        return Promise.resolve()
    }

    async get(key: string): Promise<StoredValue | undefined> {
        return this.values.get(key)
    }

    async set(key: string, value: StoredValue): Promise<void> {
        this.signal?.throwIfAborted()
        if (this.limit !== undefined && !this.values.has(key) && this.values.size >= this.limit) {
            throw new StorageError("storage.quota", "Storage quota exceeded")
        }
        this.values.set(key, value)
    }

    async delete(key: string): Promise<void> {
        this.signal?.throwIfAborted()
        this.values.delete(key)
    }

    async keys(prefix = ""): Promise<readonly string[]> {
        return [...this.values.keys()].filter((key) => key.startsWith(prefix))
    }
}

const MIGRATION_VERSION_KEY = "__storage_meta:migration-version"
const MIGRATION_JOURNAL_KEY = "__storage_meta:migration-journal"

type MigrationJournal = {
    readonly version: number
    readonly previousVersion: number
    readonly values: readonly { key: string; value: StoredValue }[]
}

function isMigrationJournal(value: unknown): value is MigrationJournal {
    if (!value || typeof value !== "object") return false
    const journal = value as Record<string, unknown>
    const version = journal.version
    const previousVersion = journal.previousVersion
    const values = journal.values
    return (
        typeof version === "number" &&
        Number.isInteger(version) &&
        version > 0 &&
        typeof previousVersion === "number" &&
        Number.isInteger(previousVersion) &&
        previousVersion >= 0 &&
        Array.isArray(values) &&
        values.every(
            (entry) =>
                Boolean(entry) &&
                typeof entry === "object" &&
                typeof (entry as { key?: unknown }).key === "string" &&
                "value" in entry,
        )
    )
}

/**
 * One permanently revocable writer lifetime shared by all native IndexedDB writers.
 * Revoke signal first, then await whenQuiescent() before releasing writer ownership.
 * Pending opens count as work: a blocked open must not permit an unsafe timeout-release.
 */
export class IndexedDBWriteLifetime {
    readonly signal: AbortSignal
    private readonly transactions = new Set<IDBTransaction>()
    private readonly opens = new Set<IDBOpenDBRequest>()
    private readonly waiters = new Set<() => void>()

    constructor(signal: AbortSignal = new AbortController().signal) {
        this.signal = signal
        signal.addEventListener(
            "abort",
            () => {
                for (const transaction of this.transactions) this.abort(transaction)
            },
            { once: true },
        )
    }

    assertWritable(): void {
        this.signal.throwIfAborted()
    }

    /** Register immediately after creation, before issuing any requests. */
    trackTransaction(transaction: IDBTransaction): void {
        if (transaction.mode === "readonly" || this.transactions.has(transaction)) return
        this.transactions.add(transaction)
        const finish = () => {
            this.transactions.delete(transaction)
            this.notifyQuiescent()
        }
        transaction.addEventListener("complete", finish, { once: true })
        transaction.addEventListener("abort", finish, { once: true })
        if (this.signal.aborted) this.abort(transaction)
    }

    /** Fence schema writes as well as opens that complete after ownership is revoked. */
    open(factory: IDBFactory, name: string, version?: number): IDBOpenDBRequest {
        this.assertWritable()
        const request = version === undefined ? factory.open(name) : factory.open(name, version)
        this.opens.add(request)
        request.addEventListener("upgradeneeded", (event) => {
            const transaction = request.transaction
            if (transaction) this.trackTransaction(transaction)
            if (this.signal.aborted) {
                // Prevent a consumer's later upgrade handler from touching the schema.
                event.stopImmediatePropagation()
                if (transaction) this.abort(transaction)
            }
        })
        const finish = () => {
            this.opens.delete(request)
            this.notifyQuiescent()
        }
        request.addEventListener(
            "success",
            () => {
                if (this.signal.aborted) request.result.close()
                finish()
            },
            { once: true },
        )
        request.addEventListener("error", finish, { once: true })
        return request
    }

    /** Safe to release ownership only after revocation and this promise's fulfillment. */
    whenQuiescent(): Promise<void> {
        if (!this.transactions.size && !this.opens.size) return Promise.resolve()
        return new Promise((resolve) => this.waiters.add(resolve))
    }

    private abort(transaction: IDBTransaction): void {
        try {
            transaction.abort()
        } catch {
            // Inactive/committing transactions still count until their terminal event.
        }
    }

    private notifyQuiescent(): void {
        if (this.transactions.size || this.opens.size) return
        for (const resolve of this.waiters) resolve()
        this.waiters.clear()
    }
}

/**
 * A small IndexedDB backend for extension data. IndexedDB is kept behind the
 * core StorageBackend interface so extensions never depend on the database
 * implementation or receive a database handle.
 */
export class IndexedDBStorageBackend implements StorageBackend {
    private readonly databaseName: string
    private readonly indexedDB: IDBFactory
    private databasePromise: Promise<IDBDatabase> | null = null
    private readonly lifetime: IndexedDBWriteLifetime

    constructor(
        options: {
            databaseName?: string
            indexedDB?: IDBFactory
            signal?: AbortSignal
            lifetime?: IndexedDBWriteLifetime
        } = {},
    ) {
        if (options.signal && options.lifetime && options.signal !== options.lifetime.signal) {
            throw new Error("Storage signal must match the shared writer lifetime")
        }
        this.lifetime = options.lifetime ?? new IndexedDBWriteLifetime(options.signal)
        this.databaseName = options.databaseName ?? "vfs-extension-storage"
        const indexedDB = options.indexedDB ?? globalThis.indexedDB
        if (!indexedDB) throw new Error("IndexedDB is unavailable")
        this.indexedDB = indexedDB
    }

    whenQuiescent(): Promise<void> {
        return this.lifetime.whenQuiescent()
    }

    async get(key: string): Promise<StoredValue | undefined> {
        return this.transaction("readonly", (store, finish, fail) => {
            const request = store.get(key)
            request.onsuccess = () => finish(request.result?.value as StoredValue | undefined)
            request.onerror = () => fail(request.error ?? new Error("Unable to read storage"))
        })
    }

    async set(key: string, value: StoredValue): Promise<void> {
        await this.transaction("readwrite", (store, finish, fail) => {
            const request = store.put({ key, value })
            request.onsuccess = () => undefined
            request.onerror = () => fail(request.error ?? new Error("Unable to write storage"))
            store.transaction.oncomplete = () => finish(undefined)
        })
    }

    async delete(key: string): Promise<void> {
        await this.transaction("readwrite", (store, finish, fail) => {
            const request = store.delete(key)
            request.onsuccess = () => undefined
            request.onerror = () => fail(request.error ?? new Error("Unable to delete storage"))
            store.transaction.oncomplete = () => finish(undefined)
        })
    }

    async keys(prefix = ""): Promise<readonly string[]> {
        return this.transaction("readonly", (store, finish, fail) => {
            const keys: string[] = []
            const request = store.openCursor()
            request.onsuccess = () => {
                const cursor = request.result
                if (!cursor) {
                    finish(keys)
                    return
                }
                const key = String(cursor.key)
                if (key.startsWith(prefix)) keys.push(key)
                cursor.continue()
            }
            request.onerror = () => fail(request.error ?? new Error("Unable to list storage"))
        })
    }

    private async transaction<T>(
        mode: IDBTransactionMode,
        operation: (
            store: IDBObjectStore,
            finish: (value: T) => void,
            fail: (error: unknown) => void,
        ) => void,
    ): Promise<T> {
        const database = await this.open()
        return new Promise<T>((resolve, reject) => {
            let settled = false
            const finish = (value: T) => {
                if (settled) return
                settled = true
                resolve(value)
            }
            const fail = (error: unknown) => {
                if (settled) return
                settled = true
                reject(error)
            }
            let transaction: IDBTransaction
            try {
                // open() can await browser work; ownership must be checked afterwards,
                // immediately before the physical write transaction is created.
                if (mode === "readwrite") this.lifetime.assertWritable()
                transaction = database.transaction("values", mode)
                this.lifetime.trackTransaction(transaction)
                transaction.onerror = () =>
                    fail(transaction.error ?? new Error("Storage transaction failed"))
                transaction.onabort = () =>
                    fail(transaction.error ?? new Error("Storage transaction aborted"))
                operation(transaction.objectStore("values"), finish, fail)
                if (mode === "readwrite") {
                    transaction.oncomplete = () => finish(undefined as T)
                }
            } catch (error) {
                fail(error)
            }
        })
    }

    private open(): Promise<IDBDatabase> {
        if (this.databasePromise) return this.databasePromise
        const promise = new Promise<IDBDatabase>((resolve, reject) => {
            let request: IDBOpenDBRequest
            try {
                request = this.lifetime.open(this.indexedDB, this.databaseName, 1)
            } catch (error) {
                reject(error)
                return
            }
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains("values")) {
                    request.result.createObjectStore("values", { keyPath: "key" })
                }
            }
            request.onsuccess = () => resolve(request.result)
            request.onerror = () => reject(request.error ?? new Error("Unable to open storage"))
            request.onblocked = () => reject(new Error("Storage database open was blocked"))
        })
        this.databasePromise = promise.catch((error) => {
            this.databasePromise = null
            throw error
        })
        return this.databasePromise
    }
}

export class NamespacedStorage implements ExtensionStorage {
    private readonly listeners = new Set<(key: string) => void>()
    private readonly childNamespaces = new Map<string, NamespacedStorage>()
    private currentVersion = 0
    private versionLoaded = false
    private versionLoad: Promise<void> | null = null
    private migrationChain = Promise.resolve()

    constructor(
        private readonly backend: StorageBackend,
        private readonly prefix: string,
    ) {}

    get version(): number {
        return this.currentVersion
    }

    async get<T>(key: string): Promise<T | undefined> {
        assertStorageKey(key)
        await this.loadVersion()
        return (await this.backend.get(this.key(key))) as T | undefined
    }

    async set<T>(key: string, value: T): Promise<void> {
        assertStorageKey(key)
        await this.loadVersion()
        try {
            await this.backend.set(this.key(key), value)
        } catch (error) {
            if (error instanceof StorageError) throw error
            throw new StorageError("storage.quota", "Unable to persist storage value", {
                cause: error,
            })
        }
        for (const listener of this.listeners) listener(key)
    }

    async delete(key: string): Promise<void> {
        assertStorageKey(key)
        await this.loadVersion()
        await this.backend.delete(this.key(key))
        for (const listener of this.listeners) listener(key)
    }

    async has(key: string): Promise<boolean> {
        return (await this.get(key)) !== undefined
    }

    async keys(): Promise<readonly string[]> {
        await this.loadVersion()
        const prefix = `${this.prefix}:`
        const keys = await this.backend.keys(prefix)
        return keys.map((key) => key.slice(prefix.length)).filter((key) => !key.includes(":"))
    }

    async clear(): Promise<void> {
        await this.loadVersion()
        for (const key of await this.backend.keys(`${this.prefix}:`)) {
            if (key !== this.versionKey() && key !== this.journalKey())
                await this.backend.delete(key)
        }
    }

    namespace(name: string): StorageNamespace {
        assertStorageKey(name)
        const existing = this.childNamespaces.get(name)
        if (existing) return existing
        const child = new NamespacedStorage(this.backend, `${this.prefix}:${name}`)
        this.childNamespaces.set(name, child)
        return child
    }

    migrate(
        version: number,
        migration: (storage: StorageNamespace) => void | Promise<void>,
    ): Promise<void> {
        if (!Number.isInteger(version) || version < 1) {
            return Promise.reject(
                new StorageError("storage.migration", `Invalid migration version: ${version}`),
            )
        }
        const run = this.migrationChain.then(async () => {
            await this.loadVersion()
            if (version <= this.currentVersion) return
            const journal: MigrationJournal = {
                version,
                previousVersion: this.currentVersion,
                values: await this.snapshotValues(),
            }
            try {
                await this.backend.set(this.journalKey(), journal)
                await migration(this)
                await this.backend.set(this.versionKey(), version)
                this.currentVersion = version
                await this.backend.delete(this.journalKey())
            } catch (error) {
                try {
                    await this.restoreValues(journal.values)
                    await this.backend.set(this.versionKey(), journal.previousVersion)
                    this.currentVersion = journal.previousVersion
                    await this.backend.delete(this.journalKey())
                } catch (repairError) {
                    throw new StorageError(
                        "storage.migration",
                        `Migration ${version} failed and could not be rolled back`,
                        { cause: repairError },
                    )
                }
                throw new StorageError("storage.migration", `Migration ${version} failed`, {
                    cause: error,
                })
            }
        })
        // A failed migration must not poison future retries. The failed run is
        // still returned to its caller, while the queue continues afterwards.
        this.migrationChain = run.catch(() => undefined)
        return run
    }

    onChange(listener: (key: string) => void): Disposable {
        this.listeners.add(listener)
        return {
            dispose: () => {
                this.listeners.delete(listener)
            },
        }
    }

    private key(key: string): string {
        return `${this.prefix}:${key}`
    }

    private versionKey(): string {
        return `${this.prefix}:${MIGRATION_VERSION_KEY}`
    }

    private journalKey(): string {
        return `${this.prefix}:${MIGRATION_JOURNAL_KEY}`
    }

    private async snapshotValues(): Promise<readonly { key: string; value: StoredValue }[]> {
        const keys = await this.backend.keys(`${this.prefix}:`)
        const values: { key: string; value: StoredValue }[] = []
        for (const key of keys) {
            if (key === this.versionKey() || key === this.journalKey()) continue
            const value = await this.backend.get(key)
            if (value !== undefined) values.push({ key, value })
        }
        return values
    }

    private async restoreValues(
        values: readonly { key: string; value: StoredValue }[],
    ): Promise<void> {
        for (const key of await this.backend.keys(`${this.prefix}:`)) {
            if (key !== this.versionKey() && key !== this.journalKey())
                await this.backend.delete(key)
        }
        for (const entry of values) await this.backend.set(entry.key, entry.value)
    }

    private async repairMigration(): Promise<void> {
        const journal = await this.backend.get(this.journalKey())
        if (!journal) return
        if (!isMigrationJournal(journal)) {
            throw new StorageError("storage.migration", "Invalid migration journal")
        }
        const persistedVersion = await this.backend.get(this.versionKey())
        if (persistedVersion === journal.version) {
            await this.backend.delete(this.journalKey())
            return
        }
        await this.restoreValues(journal.values)
        await this.backend.set(this.versionKey(), journal.previousVersion)
        await this.backend.delete(this.journalKey())
    }

    private async loadVersion(): Promise<void> {
        if (this.versionLoaded) return
        if (!this.versionLoad) {
            this.versionLoad = this.repairMigration()
                .then(() => this.backend.get(this.versionKey()))
                .then((value) => {
                    this.currentVersion =
                        typeof value === "number" && Number.isInteger(value) && value >= 0
                            ? value
                            : 0
                    this.versionLoaded = true
                })
                .catch((error) => {
                    this.versionLoad = null
                    if (error instanceof StorageError) throw error
                    throw new StorageError(
                        "storage.migration",
                        "Unable to load migration version",
                        {
                            cause: error,
                        },
                    )
                })
        }
        await this.versionLoad
    }
}

export function createExtensionStorage(
    backend: StorageBackend,
    extensionId: string,
): ExtensionStorage {
    return new NamespacedStorage(backend, `extension:${extensionId}`)
}
