import type { Disposable, DocumentAdapterContribution } from "./contracts"

export interface DocumentSource {
    readonly id: string
    readonly name?: string
    readonly extension?: string
    readonly size?: number
    read(offset?: number, length?: number): Promise<Uint8Array>
}

export interface OpenedDocument {
    readonly id: string
    readonly kind: "paged" | "reflowable"
    readonly title?: string
    close?(): void | Promise<void>
}

export interface DocumentAdapter extends DocumentAdapterContribution {}

export interface RegisteredDocumentAdapter extends DocumentAdapter {
    readonly extensionId: string
}

export interface DocumentAdapterRegistry {
    register(adapter: DocumentAdapter): Disposable
    get(adapterId: string): RegisteredDocumentAdapter | undefined
    findForExtension(extension: string): readonly RegisteredDocumentAdapter[]
    list(): readonly RegisteredDocumentAdapter[]
}
