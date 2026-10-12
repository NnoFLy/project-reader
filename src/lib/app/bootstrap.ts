import { ApplicationImpl, type Application } from "../core/app"
import { IndexedDBStorageBackend, MemoryStorageBackend, type StorageBackend } from "../core/storage"
import { createBuiltinHost } from "../extensions/builtin"
import type { ExtensionHostOptions } from "../extension-host"

export function createBuiltinApplication(
    options: Omit<ExtensionHostOptions, "extensions"> = {},
): Application {
    const storage = options.storage ?? createBuiltinStorageBackend()
    return new ApplicationImpl(createBuiltinHost({ ...options, storage }))
}

function createBuiltinStorageBackend(): StorageBackend {
    const indexedDB = globalThis.indexedDB
    return indexedDB === undefined
        ? new MemoryStorageBackend()
        : new IndexedDBStorageBackend({ indexedDB })
}
