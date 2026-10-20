import { DocumentAccess, DocumentAccessUnavailableError } from "$lib/core/documents/document-access"
import type { ViewerFileCapability } from "./viewerHost"
import { getViewerDocumentErrorDiagnostic, type ViewerDocumentLoader } from "./viewerDocument"
import { fileNodeToBook, type Book } from "./stores/viewerStore.types"

export interface ViewerOpenFailure {
    readonly bookId: string
    readonly error: unknown
}

export interface ReadingWorkspaceOptions {
    readonly files: ViewerFileCapability
    readonly loader?: ViewerDocumentLoader
    readonly getCurrentBook: () => Book | null
    /** Synchronous, atomic publication: false or a throw rejects ownership transfer. */
    readonly publish: (book: Book | null) => boolean | void
}

/** Viewer-owned single-reader behavior; core owns acquisition and resource correctness. */
export class ReadingWorkspace {
    private readonly access: DocumentAccess
    private synchronization?: Promise<void>
    private relinkPending = false

    constructor(private readonly options: ReadingWorkspaceOptions) {
        this.access = new DocumentAccess(options.files)
    }

    open(
        id: string,
        onFailure?: (failure: ViewerOpenFailure) => void | Promise<void>,
    ): Promise<boolean> {
        return this.select(id, undefined, true, onFailure)
    }

    setCurrentBook(book: Book | null): Promise<boolean> {
        if (!book) return this.close().then(() => true)
        return this.select(book.id, book)
    }

    synchronize(relinked = false): Promise<void> {
        this.relinkPending ||= relinked
        if (this.synchronization) return this.synchronization
        const synchronize = async () => {
            do {
                const refresh = this.relinkPending
                this.relinkPending = false
                const book = this.options.getCurrentBook()
                if (!book) return
                await this.select(book.id, refresh ? undefined : book, false, undefined, true)
            } while (this.relinkPending)
        }
        const operation = synchronize()
        this.synchronization = operation
        void operation
            .finally(() => {
                if (this.synchronization === operation) this.synchronization = undefined
            })
            .catch(() => undefined)
        return operation
    }

    private async select(
        id: string,
        position?: Book,
        restoreAccess = false,
        onFailure?: (failure: ViewerOpenFailure) => void | Promise<void>,
        maintenance = false,
    ): Promise<boolean> {
        try {
            const accepted = await this.access.select(
                id,
                (url) => {
                    const node = this.options.files.nodes[id]
                    if (!node || node.type !== "file") return false
                    return this.options.publish({
                        ...fileNodeToBook(node),
                        ...(position
                            ? {
                                  pageNumber: position.pageNumber,
                                  scrollPosition: position.scrollPosition,
                              }
                            : {}),
                        url: url ?? "",
                        isLocked: url ? this.options.files.isLockedMap[id] : true,
                    })
                },
                restoreAccess,
                maintenance,
            )
            if (
                !accepted &&
                this.options.files.nodes[id]?.type !== "file" &&
                this.options.getCurrentBook()?.id === id
            ) {
                const closing = this.access.close(false)
                this.options.publish(null)
                await closing
            }
            return accepted
        } catch (error) {
            if (!(error instanceof DocumentAccessUnavailableError)) throw error
            if (restoreAccess) {
                console.error(
                    "[Viewer] Unable to access document",
                    getViewerDocumentErrorDiagnostic(error),
                )
                this.options.files.requestRelink(id)
                await onFailure?.({ bookId: id, error })
            } else if (this.options.getCurrentBook()?.id === id) {
                const book = this.options.getCurrentBook()!
                const closing = this.access.close(false)
                this.options.publish({ ...book, url: "", isLocked: true })
                await closing
            }
            return false
        }
    }

    loadDocument(signal?: AbortSignal) {
        return this.access.load((claim, signal) => {
            const loader = this.options.loader
            if (!loader) throw new Error("The workspace document loader is unavailable")
            return loader.open(
                {
                    id: claim.id,
                    url: claim.url,
                    name: this.options.files.nodes[claim.id]?.name ?? "document",
                },
                signal,
            )
        }, signal)
    }

    async close(): Promise<void> {
        const closing = this.access.close()
        this.options.publish(null)
        await closing
    }

    dispose(): Promise<void> {
        return this.access.dispose()
    }
}
