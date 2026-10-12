import type {
    DocumentAdapter,
    DocumentSource,
    OpenedDocument,
    ProbeResult,
} from "$lib/document-model"
import { getDocumentExtension, normalizeMimeType } from "$lib/document-model"
import { DocumentAdapterRegistry } from "./document-adapter-registry"

export class UnsupportedDocumentError extends Error {
    constructor(source: DocumentSource) {
        super(`No document adapter supports ${source.name}`)
        this.name = "UnsupportedDocumentError"
    }
}

export class DocumentOpenError extends Error {
    constructor(adapterId: string, cause: unknown) {
        super(`Document adapter ${adapterId} failed to open the source`, { cause })
        this.name = "DocumentOpenError"
    }
}

interface Candidate {
    adapter: DocumentAdapter
    result: ProbeResult
    hint: number
    order: number
}

function throwIfAborted(signal?: AbortSignal): void {
    if (!signal?.aborted) return
    throw signal.reason instanceof Error
        ? signal.reason
        : new DOMException("The operation was aborted", "AbortError")
}

function isHintMatch(adapter: DocumentAdapter, source: DocumentSource): boolean {
    const extension = getDocumentExtension(source.name)
    const mimeType = normalizeMimeType(source.mimeType)
    return Boolean(
        (extension &&
            adapter.extensions.some(
                (value) => value.toLowerCase().replace(/^\./, "") === extension,
            )) ||
        (mimeType && adapter.mimeTypes.some((value) => normalizeMimeType(value) === mimeType)),
    )
}

export class DocumentService {
    private readonly opened = new Set<OpenedDocument>()
    private readonly closing = new Map<OpenedDocument, Promise<void>>()

    constructor(readonly adapters: DocumentAdapterRegistry = new DocumentAdapterRegistry()) {}

    async probe(source: DocumentSource, signal?: AbortSignal): Promise<readonly DocumentAdapter[]> {
        const candidates = await this.probeCandidates(source, signal)
        return candidates.map(({ adapter }) => adapter)
    }

    async open(source: DocumentSource, signal?: AbortSignal): Promise<OpenedDocument> {
        let opened = false
        try {
            const candidates = await this.probeCandidates(source, signal)
            const selected = candidates[0]
            if (!selected) throw new UnsupportedDocumentError(source)
            throwIfAborted(signal)
            let document: OpenedDocument | undefined
            try {
                document = await selected.adapter.open(source, signal)
                throwIfAborted(signal)
                this.opened.add(document)
                opened = true
                return document
            } catch (error) {
                // An adapter can finish opening just as cancellation arrives. The
                // service owns that document now and must release it on every exit.
                if (document) {
                    try {
                        await document.close()
                    } catch {
                        // Preserve the original open/cancellation error.
                    }
                }
                if (signal?.aborted)
                    throw (
                        signal.reason ?? new DOMException("The operation was aborted", "AbortError")
                    )
                if (error instanceof DocumentOpenError) throw error
                throw new DocumentOpenError(selected.adapter.id, error)
            }
        } finally {
            if (!opened && source.close) {
                try {
                    await source.close()
                } catch {
                    // Preserve the probe/open error. The source has no usable document.
                }
            }
        }
    }

    async close(document: OpenedDocument): Promise<void> {
        if (!this.opened.has(document)) return
        const existing = this.closing.get(document)
        if (existing) return existing
        const closing = (async () => {
            try {
                await document.close()
            } finally {
                this.opened.delete(document)
                this.closing.delete(document)
            }
        })()
        this.closing.set(document, closing)
        return closing
    }

    async closeAll(): Promise<void> {
        const errors: unknown[] = []
        // Closing can synchronously trigger another close/open callback. Drain the set
        // until no tracked document remains, while still attempting every cleanup.
        while (this.opened.size > 0) {
            const documents = [...this.opened]
            const results = await Promise.allSettled(
                documents.map((document) => this.close(document)),
            )
            for (const result of results) {
                if (result.status === "rejected") errors.push(result.reason)
            }
        }
        if (errors.length === 1) throw errors[0]
        if (errors.length > 1) throw new AggregateError(errors, "Failed to close documents")
    }

    get openDocumentCount(): number {
        return this.opened.size
    }

    private async probeCandidates(
        source: DocumentSource,
        signal?: AbortSignal,
    ): Promise<readonly Candidate[]> {
        const adapters = this.adapters.list()
        const results: Candidate[] = []
        for (const [order, adapter] of adapters.entries()) {
            throwIfAborted(signal)
            const result = await adapter.probe(source, signal)
            throwIfAborted(signal)
            if (typeof result === "boolean" ? result : result.supported) {
                const normalized = typeof result === "boolean" ? { supported: result } : result
                results.push({
                    adapter,
                    result: normalized,
                    hint: isHintMatch(adapter, source) ? 1 : 0,
                    order,
                })
            }
        }
        return results.sort(
            (left, right) =>
                (right.result.confidence ?? 0) - (left.result.confidence ?? 0) ||
                right.hint - left.hint ||
                left.order - right.order,
        )
    }
}
