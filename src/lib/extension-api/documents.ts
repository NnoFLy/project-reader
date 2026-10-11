import type { Disposable } from "./contracts"

export type {
    DocumentAdapter,
    DocumentSource,
    OpenedDocument,
    ProbeResult,
} from "$lib/document-model"
import type { DocumentAdapter } from "$lib/document-model"

export interface RegisteredDocumentAdapter extends DocumentAdapter {
    readonly extensionId: string
}

export interface DocumentAdapterRegistry {
    register(adapter: DocumentAdapter): Disposable
    get(adapterId: string): RegisteredDocumentAdapter | undefined
    findForExtension(extension: string): readonly RegisteredDocumentAdapter[]
    list(): readonly RegisteredDocumentAdapter[]
}
