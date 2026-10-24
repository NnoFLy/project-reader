import type {
    DocumentAdapter,
    DocumentSource,
    OpenedDocument,
    ProbeResult,
} from "$lib/document-model"
import { getDocumentExtension, normalizeMimeType } from "$lib/document-model"
import { boundedDocumentCleanup, combinedSignal, runDocumentOperation } from "./document-operations"
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
    signal: AbortSignal
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

function controlledSource(
    source: DocumentSource,
    signal: AbortSignal,
    close = source.close?.bind(source),
): DocumentSource {
    return {
        id: source.id,
        name: source.name,
        size: source.size,
        mimeType: source.mimeType,
        read: (offset, length, requestSignal) => {
            const readSignal = combinedSignal(signal, requestSignal)
            return runDocumentOperation(readSignal, () => source.read(offset, length, readSignal))
        },
        close,
    }
}

export class DocumentService {
    private readonly opened = new Set<OpenedDocument>()
    private readonly managed = new WeakMap<OpenedDocument, OpenedDocument>()
    private readonly controller = new AbortController()

    constructor(readonly adapters: DocumentAdapterRegistry = new DocumentAdapterRegistry()) {}

    async probe(source: DocumentSource, signal?: AbortSignal): Promise<readonly DocumentAdapter[]> {
        const candidates = await this.probeCandidates(source, signal)
        return candidates.map(({ adapter }) => adapter)
    }

    async open(source: DocumentSource, signal?: AbortSignal): Promise<OpenedDocument> {
        let sourceCleanup: Promise<void> | undefined
        const closeSource = () => (sourceCleanup ??= Promise.resolve().then(() => source.close?.()))
        const controller = new AbortController()
        const sourceFor = (lifetime: AbortSignal) => controlledSource(source, lifetime, closeSource)
        let transferred = false
        try {
            const operationSignal = combinedSignal(this.controller.signal, signal)
            const candidates = await this.probeCandidates(source, operationSignal, sourceFor)
            const selected = candidates[0]
            if (!selected) throw new UnsupportedDocumentError(source)
            const lifetime = combinedSignal(operationSignal, selected.signal, controller.signal)
            try {
                const raw = await runDocumentOperation(
                    lifetime,
                    () => selected.adapter.open(sourceFor(lifetime), lifetime),
                    async (document) => {
                        try {
                            await boundedDocumentCleanup(
                                Promise.resolve().then(() => document.close()),
                            )
                        } finally {
                            await boundedDocumentCleanup(closeSource())
                        }
                    },
                )
                // Cancellation can occur between the raced result and ownership transfer.
                if (lifetime.aborted) {
                    void Promise.resolve()
                        .then(() => raw.close())
                        .catch(() => undefined)
                    lifetime.throwIfAborted()
                }
                const document = this.manage(raw, lifetime, controller, closeSource)
                transferred = true
                return document
            } catch (error) {
                lifetime.throwIfAborted()
                if (error instanceof DocumentOpenError) throw error
                throw new DocumentOpenError(selected.adapter.id, error)
            }
        } finally {
            if (!transferred) {
                controller.abort()
                try {
                    await boundedDocumentCleanup(closeSource())
                } catch {
                    /* Preserve the operation error. */
                }
            }
        }
    }

    private manage(
        raw: OpenedDocument,
        lifetime: AbortSignal,
        controller: AbortController,
        closeSource: () => Promise<void>,
    ): OpenedDocument {
        const signal = combinedSignal(lifetime, controller.signal)
        let closing: Promise<void> | undefined
        let document: OpenedDocument
        const close = (): Promise<void> => {
            if (closing) return closing
            lifetime.removeEventListener("abort", invalidate)
            closing = boundedDocumentCleanup(
                Promise.resolve().then(async () => {
                    try {
                        await boundedDocumentCleanup(Promise.resolve().then(() => raw.close()))
                    } finally {
                        await boundedDocumentCleanup(closeSource())
                    }
                }),
            )
            controller.abort()
            this.opened.delete(document)
            return closing
        }
        const invalidate = () => {
            void close().catch(() => undefined)
        }
        document = new Proxy(raw, {
            get: (target, key) => {
                if (key === "close") return close
                const value = Reflect.get(target, key, target)
                if (typeof value !== "function") return value
                const takesSignalArgument =
                    key === "getText" || key === "getAnnotations" || key === "validateRenderBounds"
                return (...args: unknown[]) => {
                    let requestSignal: AbortSignal | undefined
                    if (key === "renderPage")
                        requestSignal = (args[1] as { signal?: AbortSignal } | undefined)?.signal
                    else if (takesSignalArgument) requestSignal = args[1] as AbortSignal | undefined
                    const operationSignal = combinedSignal(signal, requestSignal)
                    if (key === "renderPage")
                        args[1] = { ...(args[1] as object), signal: operationSignal }
                    else if (takesSignalArgument) args[1] = operationSignal
                    return runDocumentOperation(operationSignal, () => value.apply(target, args))
                }
            },
        })
        this.managed.set(raw, document)
        this.managed.set(document, document)
        this.opened.add(document)
        lifetime.addEventListener("abort", invalidate, { once: true })
        return document
    }

    async close(document: OpenedDocument): Promise<void> {
        await this.managed.get(document)?.close()
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

    dispose(): Promise<void> {
        this.controller.abort()
        return this.closeAll()
    }

    get openDocumentCount(): number {
        return this.opened.size
    }

    private async probeCandidates(
        source: DocumentSource,
        signal?: AbortSignal,
        sourceFor: (signal: AbortSignal) => DocumentSource = (lifetime) =>
            controlledSource(source, lifetime),
    ): Promise<readonly Candidate[]> {
        signal = combinedSignal(this.controller.signal, signal)
        const adapters = this.adapters.list().map((adapter) => ({
            adapter,
            signal: this.adapters.signalFor(adapter),
        }))
        const results: Candidate[] = []
        for (const [order, registration] of adapters.entries()) {
            throwIfAborted(signal)
            const { adapter } = registration
            const probeSignal = combinedSignal(signal, registration.signal)
            const result = await runDocumentOperation(probeSignal, () =>
                adapter.probe(sourceFor(probeSignal), probeSignal),
            )
            throwIfAborted(probeSignal)
            throwIfAborted(signal)
            if (typeof result === "boolean" ? result : result.supported) {
                const normalized = typeof result === "boolean" ? { supported: result } : result
                results.push({
                    adapter,
                    signal: registration.signal,
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
