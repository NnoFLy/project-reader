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

export class NamespacedStorage implements ExtensionStorage {
    private readonly listeners = new Set<(key: string) => void>()
    private readonly childNamespaces = new Map<string, NamespacedStorage>()
    private currentVersion = 0
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
        for (const key of await this.backend.keys(`${this.prefix}:`)) await this.backend.delete(key)
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
        this.migrationChain = this.migrationChain.then(async () => {
            if (version <= this.currentVersion) return
            try {
                await migration(this)
                this.currentVersion = version
            } catch (error) {
                throw new StorageError("storage.migration", `Migration ${version} failed`, {
                    cause: error,
                })
            }
        })
        return this.migrationChain
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
}

export function createExtensionStorage(
    backend: StorageBackend,
    extensionId: string,
): ExtensionStorage {
    return new NamespacedStorage(backend, `extension:${extensionId}`)
}
