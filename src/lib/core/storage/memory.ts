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

    constructor(options?: { quota?: number }) {
        this.limit = options?.quota
    }

    async get(key: string): Promise<StoredValue | undefined> {
        return this.values.get(key)
    }

    async set(key: string, value: StoredValue): Promise<void> {
        if (this.limit !== undefined && !this.values.has(key) && this.values.size >= this.limit) {
            throw new StorageError("storage.quota", "Storage quota exceeded")
        }
        this.values.set(key, value)
    }

    async delete(key: string): Promise<void> {
        this.values.delete(key)
    }

    async keys(prefix = ""): Promise<readonly string[]> {
        return [...this.values.keys()].filter((key) => key.startsWith(prefix))
    }
}

const MIGRATION_VERSION_KEY = "__storage_meta:migration-version"

/**
 * A small IndexedDB backend for extension data. IndexedDB is kept behind the
 * core StorageBackend interface so extensions never depend on the database
 * implementation or receive a database handle.
 */
export class IndexedDBStorageBackend implements StorageBackend {
    private readonly databaseName: string
    private readonly indexedDB: IDBFactory
    private databasePromise: Promise<IDBDatabase> | null = null

    constructor(options: { databaseName?: string; indexedDB?: IDBFactory } = {}) {
        this.databaseName = options.databaseName ?? "vfs-extension-storage"
        const indexedDB = options.indexedDB ?? globalThis.indexedDB
        if (!indexedDB) throw new Error("IndexedDB is unavailable")
        this.indexedDB = indexedDB
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
                transaction = database.transaction("values", mode)
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
                request = this.indexedDB.open(this.databaseName, 1)
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
        return (await this.backend.get(this.key(key))) as T | undefined
    }

    async set<T>(key: string, value: T): Promise<void> {
        assertStorageKey(key)
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
        await this.backend.delete(this.key(key))
        for (const listener of this.listeners) listener(key)
    }

    async has(key: string): Promise<boolean> {
        return (await this.get(key)) !== undefined
    }

    async keys(): Promise<readonly string[]> {
        const prefix = `${this.prefix}:`
        const keys = await this.backend.keys(prefix)
        return keys.map((key) => key.slice(prefix.length)).filter((key) => !key.includes(":"))
    }

    async clear(): Promise<void> {
        for (const key of await this.backend.keys(`${this.prefix}:`)) {
            if (key !== this.versionKey()) await this.backend.delete(key)
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
            try {
                await migration(this)
                await this.backend.set(this.versionKey(), version)
                this.currentVersion = version
            } catch (error) {
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

    private async loadVersion(): Promise<void> {
        if (this.versionLoaded) return
        if (!this.versionLoad) {
            this.versionLoad = this.backend
                .get(this.versionKey())
                .then((value) => {
                    this.currentVersion =
                        typeof value === "number" && Number.isInteger(value) && value >= 0
                            ? value
                            : 0
                    this.versionLoaded = true
                })
                .catch((error) => {
                    this.versionLoad = null
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
