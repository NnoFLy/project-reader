export interface DocumentSource {
    readonly id: string
    readonly name: string
    readonly size: number
    readonly mimeType: string | undefined
    read(offset?: number, length?: number, signal?: AbortSignal): Promise<ArrayBuffer>
    /** Releases any source handle retained by the core file service. */
    close?(): Promise<void>
}

export interface ProbeResult {
    readonly supported: boolean
    /** Higher confidence wins when more than one adapter supports a source. */
    readonly confidence?: number
    readonly format?: string
}

export interface DocumentAdapter {
    readonly id: string
    readonly extensions: readonly string[]
    readonly mimeTypes: readonly string[]
    probe(source: DocumentSource, signal?: AbortSignal): Promise<ProbeResult>
    open(
        source: DocumentSource,
        signal?: AbortSignal,
    ): Promise<import("./reader-document").OpenedDocument>
}

export function getDocumentExtension(name: string): string | undefined {
    const basename = name.slice(name.lastIndexOf("/") + 1)
    const dot = basename.lastIndexOf(".")
    if (dot <= 0 || dot === basename.length - 1) return undefined
    return basename.slice(dot + 1).toLowerCase()
}

export function normalizeMimeType(mimeType: string | undefined): string | undefined {
    return mimeType?.split(";", 1)[0]?.trim().toLowerCase() || undefined
}
