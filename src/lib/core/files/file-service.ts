import type { DocumentSource } from "$lib/document-model"
import {
    createBlobDocumentSource,
    createBoundedDocumentSource,
    type BoundedDocumentSourceOptions,
} from "./file-source"

export interface FileRecord {
    readonly id: string
    readonly name: string
    readonly size: number
    readonly mimeType?: string
    readonly blob?: Blob
    readonly reader?: BoundedDocumentSourceOptions["reader"]
}

/** Core-owned source factory. Storage implementations can provide a bounded reader. */
export class FileService {
    createSource(file: FileRecord): DocumentSource {
        if (file.blob) {
            return createBlobDocumentSource({
                id: file.id,
                name: file.name,
                blob: file.blob,
                mimeType: file.mimeType,
            })
        }
        if (!file.reader) throw new Error(`File ${file.id} has no readable content`)
        return createBoundedDocumentSource({
            id: file.id,
            name: file.name,
            size: file.size,
            mimeType: file.mimeType,
            reader: file.reader,
        })
    }
}

export function createFileService(): FileService {
    return new FileService()
}
