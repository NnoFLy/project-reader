import { ApplicationImpl, type Application } from "../core/app"
import { DocumentService } from "../core/documents"
import { IndexedDBStorageBackend, MemoryStorageBackend, type StorageBackend } from "../core/storage"
import { getDocumentExtension, type DocumentSource, type OpenedDocument } from "$lib/document-model"
import { createBuiltinHost } from "../extensions/builtin"
import {
    installViewerDocumentService,
    type ViewerDocumentService,
} from "../extensions/builtin/viewer/viewerDocument"
import {
    installDocumentService,
    type VfsDocumentService,
} from "../modules/documents/vfs/vfsStore.svelte"
import type { ExtensionHostOptions } from "../extension-host"

export function createBuiltinApplication(
    options: Omit<ExtensionHostOptions, "extensions"> = {},
): Application {
    const storage = options.storage ?? createBuiltinStorageBackend()
    const documentService = options.documentService ?? new DocumentService()
    const host = createBuiltinHost({ ...options, storage, documentService })
    const documentCapability: ViewerDocumentService & VfsDocumentService = {
        async open(source: DocumentSource, signal?: AbortSignal): Promise<OpenedDocument> {
            const extension = getDocumentExtension(source.name)
            if (extension) await host.activateForDocumentType(extension)
            return documentService.open(source, signal)
        },
        close: (document) => documentService.close(document),
    }
    installViewerDocumentService(documentCapability)
    installDocumentService(documentCapability)
    return new ApplicationImpl(host)
}

function createBuiltinStorageBackend(): StorageBackend {
    const indexedDB = globalThis.indexedDB
    return indexedDB === undefined
        ? new MemoryStorageBackend()
        : new IndexedDBStorageBackend({ indexedDB })
}
