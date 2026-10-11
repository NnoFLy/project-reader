import type { Disposable } from "./contracts"

export interface StorageNamespace {
    get<T>(key: string): Promise<T | undefined>
    set<T>(key: string, value: T): Promise<void>
    delete(key: string): Promise<void>
    has(key: string): Promise<boolean>
    keys(): Promise<readonly string[]>
    clear(): Promise<void>
}

export interface ExtensionStorage extends StorageNamespace {
    namespace(name: string): StorageNamespace
    migrate(
        version: number,
        migration: (storage: StorageNamespace) => void | Promise<void>,
    ): Promise<void>
    readonly version: number
    onChange(listener: (key: string) => void): Disposable
}

export class StorageError extends Error {
    readonly code: "storage.quota" | "storage.invalid-key" | "storage.migration"

    constructor(
        code: "storage.quota" | "storage.invalid-key" | "storage.migration",
        message: string,
        options?: { cause?: unknown },
    ) {
        super(message, options)
        this.name = "StorageError"
        this.code = code
    }
}

export function assertStorageKey(key: string): void {
    if (
        !key ||
        key.includes("\0") ||
        key.includes(":") ||
        key.includes("/") ||
        key.includes("\\") ||
        key === "." ||
        key === ".."
    ) {
        throw new StorageError("storage.invalid-key", `Invalid storage key: ${key}`)
    }
}
