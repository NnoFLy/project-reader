import type { OpenedDocument } from "$lib/document-model"

export interface DocumentAccessFiles {
    readonly nodes: Readonly<
        Record<string, { readonly type: string; readonly isLocked?: boolean } | undefined>
    >
    getFileUrl(id: string): Promise<string | undefined>
    restoreFileAccess(id: string): Promise<string | undefined>
    waitForRelink(id: string): Promise<void>
    releaseFileUrl(id: string, url: string): boolean
    getContentGeneration(id: string): number
    isCurrentContent(id: string, generation: number): boolean
    isCurrentFileUrl(id: string, url: string, generation?: number): boolean
}

interface SourceClaim {
    readonly id: string
    readonly url: string
    readonly generation: number
    released: boolean
}

export class DocumentAccessUnavailableError extends Error {
    constructor(cause?: unknown) {
        super("File access is unavailable", { cause })
        this.name = "DocumentAccessUnavailableError"
    }
}

/** Source acquisition, publication transfer and managed cleanup for one owner. */
export class DocumentAccess {
    private active?: SourceClaim
    private revision = 0
    private pendingSelection?: number
    private deferredMaintenance?: () => Promise<unknown>
    private disposed = false
    private disposal?: Promise<void>
    private readonly documents = new Map<() => Promise<void>, SourceClaim>()
    private readonly loaded = new Map<SourceClaim, OpenedDocument>()

    constructor(private readonly files: DocumentAccessFiles) {}

    async select(
        id: string,
        publish: (url: string | undefined) => boolean | void,
        restoreAccess = false,
        maintenance = false,
    ): Promise<boolean> {
        if (this.disposed) return false
        if (maintenance && this.pendingSelection !== undefined) {
            const owner = this.active
            this.deferredMaintenance = async () => {
                if (this.active === owner && !this.disposed)
                    await this.select(id, publish, restoreAccess, true)
            }
            return false
        }
        const revision = ++this.revision
        if (!maintenance) this.pendingSelection = revision
        const current = () => !this.disposed && revision === this.revision
        const available = () => this.files.nodes[id]?.type === "file"
        const acquired: string[] = []
        let transferred: string | undefined
        let publishing = false
        try {
            if (!available()) return false
            let restored: string | undefined
            while (restoreAccess && this.files.nodes[id]?.isLocked) {
                try {
                    restored = await this.files.restoreFileAccess(id)
                    if (restored) acquired.push(restored)
                } catch (error) {
                    if (!current()) return false
                    if (!(error instanceof Error) || error.name !== "ContentSupersededError")
                        throw error
                    await this.files.waitForRelink(id)
                }
                if (!current() || !available()) return false
            }
            const generation = this.files.getContentGeneration(id)
            const reused =
                this.active?.id === id && this.isCurrent(this.active) ? this.active : undefined
            const url = reused?.url ?? restored ?? (await this.files.getFileUrl(id))
            if (url && !reused && !restored) acquired.push(url)
            if (!current() || !available() || !this.files.isCurrentContent(id, generation))
                return false
            if (!url) throw new DocumentAccessUnavailableError()
            if (!this.files.isCurrentFileUrl(id, url, generation)) return false
            publishing = true
            if (publish(url) === false) return false
            const previous = this.active
            const claim = reused ?? { id, url, generation, released: false }
            this.active = claim
            // Publication is the atomic ownership-transfer point, even if another selection
            // starts while the previous document's asynchronous cleanup is still draining.
            if (!reused) transferred = url
            if (previous && previous !== claim) {
                try {
                    await this.closeDocuments(previous)
                } finally {
                    this.release(previous)
                }
            }
            return current()
        } catch (error) {
            if (!current()) return false
            if (!publishing && maintenance && this.active?.id === id) {
                const closing = this.close(false)
                publish(undefined)
                await closing
                return false
            }
            if (!publishing && !(error instanceof DocumentAccessUnavailableError))
                throw new DocumentAccessUnavailableError(error)
            throw error
        } finally {
            if (this.pendingSelection === revision) {
                this.pendingSelection = undefined
                const maintenance = this.deferredMaintenance
                this.deferredMaintenance = undefined
                // Background maintenance must not replace an explicit selection's result/error.
                if (maintenance) await Promise.allSettled([maintenance()])
            }
            let kept = false
            for (const url of acquired) {
                if (!kept && transferred === url) kept = true
                else this.files.releaseFileUrl(id, url)
            }
        }
    }

    async load(
        open: (
            input: { readonly id: string; readonly url: string },
            signal: AbortSignal,
        ) => Promise<OpenedDocument>,
        signal?: AbortSignal,
    ): Promise<OpenedDocument | undefined> {
        const claim = this.active
        if (!claim || !this.isCurrent(claim) || signal?.aborted) return
        const existing = this.loaded.get(claim)
        if (existing) return existing
        const controller = new AbortController()
        const abort = () => controller.abort()
        signal?.addEventListener("abort", abort, { once: true })
        let document: OpenedDocument
        try {
            document = await open(claim, controller.signal)
        } catch (error) {
            if (this.active !== claim || !this.isCurrent(claim) || signal?.aborted) return
            throw error
        } finally {
            signal?.removeEventListener("abort", abort)
        }
        let closing: Promise<void> | undefined
        const close = () => {
            if (!closing) {
                if (this.loaded.get(claim)?.close === close) this.loaded.delete(claim)
                closing = Promise.resolve().then(() => document.close())
                void closing.then(
                    () => this.documents.delete(close),
                    () => this.documents.delete(close),
                )
            }
            return closing
        }
        this.documents.set(close, claim)
        if (this.active !== claim || !this.isCurrent(claim) || signal?.aborted) {
            await close()
            return
        }
        const managed = new Proxy(document, {
            get: (target, key) => {
                if (key === "close") return close
                const value = Reflect.get(target, key, target)
                return typeof value === "function" ? value.bind(target) : value
            },
        })
        this.loaded.set(claim, managed)
        return managed
    }

    async close(supersedeSelection = true): Promise<void> {
        if (supersedeSelection) {
            this.revision++
            this.pendingSelection = undefined
            this.deferredMaintenance = undefined
        }
        const previous = this.active
        this.active = undefined
        try {
            await this.closeDocuments(previous)
        } finally {
            if (previous) this.release(previous)
        }
    }

    dispose(): Promise<void> {
        if (!this.disposal) {
            this.disposed = true
            this.disposal = this.close()
        }
        return this.disposal
    }

    private isCurrent(claim: SourceClaim): boolean {
        return (
            !this.disposed &&
            !claim.released &&
            this.files.nodes[claim.id]?.type === "file" &&
            this.files.isCurrentContent(claim.id, claim.generation) &&
            this.files.isCurrentFileUrl(claim.id, claim.url, claim.generation)
        )
    }

    private async closeDocuments(claim?: SourceClaim): Promise<void> {
        const results = await Promise.allSettled(
            [...this.documents]
                .filter(([, owner]) => !claim || owner === claim)
                .map(([close]) => close()),
        )
        const failures = results.filter((result) => result.status === "rejected")
        if (failures.length)
            throw new AggregateError(
                failures.map((failure) => failure.reason),
                "Document cleanup failed",
            )
    }

    private release(claim: SourceClaim): void {
        if (claim.released) return
        claim.released = true
        this.files.releaseFileUrl(claim.id, claim.url)
    }
}
