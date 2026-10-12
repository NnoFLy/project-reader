import { ApplicationImpl, type Application } from "../core/app"
import { DocumentService } from "../core/documents"
import { IndexedDBStorageBackend, MemoryStorageBackend, type StorageBackend } from "../core/storage"
import { createBuiltinHost, installBuiltinDocumentService } from "../extensions/builtin"
import type { ExtensionHostOptions } from "../extension-host"
import { migrateLegacyDatabaseToLibrary } from "../core/legacy-migration"

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
    installBuiltinDocumentService(documentService, (extension) =>
        host.activateForDocumentType(extension),
    )
    return new ApplicationImpl(host)
}

function createBuiltinStorageBackend(): StorageBackend {
    const indexedDB = globalThis.indexedDB
    return indexedDB === undefined
        ? new MemoryStorageBackend()
        : new IndexedDBStorageBackend({ indexedDB })
}
