import type {
    DocumentAdapter,
    DocumentSource,
    OpenedDocument,
    ProbeResult,
} from "$lib/document-model"
import { PagedPdfDocument } from "./pdf-document"

export const PDF_ADAPTER_ID = "builtin.pdf.adapter"

export class PdfDocumentAdapter implements DocumentAdapter {
    readonly id = PDF_ADAPTER_ID
    readonly extensions = ["pdf"] as const
    readonly mimeTypes = ["application/pdf"] as const

    async probe(source: DocumentSource, signal?: AbortSignal): Promise<ProbeResult> {
        signal?.throwIfAborted()
        if (source.size < 5) return { supported: false, confidence: 0 }
        const header = new Uint8Array(await source.read(0, 5, signal))
        signal?.throwIfAborted()
        const supported = new TextDecoder().decode(header) === "%PDF-"
        return {
            supported,
            confidence: supported ? 1 : 0,
            format: supported ? "pdf" : undefined,
        }
    }

    async open(source: DocumentSource, signal?: AbortSignal): Promise<OpenedDocument> {
        signal?.throwIfAborted()
        const document = new PagedPdfDocument(source)
        try {
            return await document.load(signal)
        } catch (error) {
            await document.close()
            throw error
        }
    }
}

export const pdfDocumentAdapter = new PdfDocumentAdapter()
export { PagedPdfDocument }
