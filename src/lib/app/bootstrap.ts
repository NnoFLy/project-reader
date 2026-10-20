import { ApplicationImpl, type Application } from "../core/app"
import { DocumentService } from "../core/documents"
import {
    IndexedDBStorageBackend,
    MemoryStorageBackend,
    type IndexedDBWriteLifetime,
    type StorageBackend,
} from "../core/storage"
import { createBuiltinHost } from "../extensions/builtin"
import type { ExtensionHostOptions } from "../extension-host"
import { migrateLegacyDatabaseToLibrary } from "../core/legacy-migration"
import { WriterApplication, type WriterDeadlines } from "./writerApplication"

export interface BrowserApplicationOptions extends WriterDeadlines {
    /** Trusted explicit test composition only. Browser startup never falls back to memory. */
    readonly storage?: (lifetime: IndexedDBWriteLifetime) => StorageBackend
    readonly migration?: ExtensionHostOptions["migration"]
    readonly hostContext?: ExtensionHostOptions["hostContext"]
}

/** Browser entry point: real host construction and every writer share this one gate. */
export function createBrowserApplication(
    options: BrowserApplicationOptions = {},
): WriterApplication {
    return new WriterApplication((lifetime) => {
        const indexedDB = globalThis.indexedDB
        if (!options.storage && (!indexedDB || typeof indexedDB.open !== "function")) {
            throw new Error("Persistent Library storage is unavailable")
        }
        return createBuiltinApplication({
            storage:
                options.storage?.(lifetime) ?? new IndexedDBStorageBackend({ lifetime, indexedDB }),
            hostContext: { ...options.hostContext, writeSignal: lifetime.signal },
            migration: options.migration ?? {
                migrateLibrary: (namespace) =>
                    migrateLegacyDatabaseToLibrary(namespace, undefined, { lifetime }),
            },
        })
    }, options)
}

export function createBuiltinApplication(
    options: Omit<ExtensionHostOptions, "extensions"> = {},
): Application {
    const storage = options.storage ?? createBuiltinStorageBackend()
    const documentService = options.documentService ?? new DocumentService()
    const host = createBuiltinHost({
        ...options,
        storage,
        documentService,
        migration: options.migration ?? { migrateLibrary: migrateLegacyDatabaseToLibrary },
    })
    return new ApplicationImpl(host)
}

function createBuiltinStorageBackend(): StorageBackend {
    const indexedDB = globalThis.indexedDB
    return indexedDB === undefined
        ? new MemoryStorageBackend()
        : new IndexedDBStorageBackend({ indexedDB })
}
