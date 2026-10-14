import {
    assertNamespacedId,
    type ContextualStatus,
    type ContextualStatusPublisher,
    type ContextualStatusService,
    type Disposable,
} from "$lib/extension-api"

interface Publication<T extends ContextualStatus> {
    readonly token: symbol
    readonly status: T
    readonly sequence: number
}

/** Resolves source-scoped extension publications into one host-owned status. */
export class ContextualStatusServiceImpl<
    T extends ContextualStatus = ContextualStatus,
> implements ContextualStatusService<T> {
    private readonly publications = new Map<string, Publication<T>>()
    private readonly listeners = new Set<(status: T | null) => void>()
    private sequence = 0
    private resolved: T | null = null

    get current(): T | null {
        return this.resolved
    }

    forExtension(extensionId: string): ContextualStatusPublisher<T> {
        assertNamespacedId(extensionId, "extension")
        return {
            publish: (status) => this.publish(extensionId, status),
            clear: () => this.clear(extensionId),
        }
    }

    private publish(source: string, status: T | null): Disposable {
        const token = Symbol(source)
        if (status === null) this.publications.delete(source)
        else {
            this.publications.set(source, {
                token,
                status,
                sequence: ++this.sequence,
            })
        }
        this.notify()

        let active = true
        return {
            dispose: () => {
                if (!active) return
                active = false
                const publication = this.publications.get(source)
                if (publication?.token !== token) return
                this.publications.delete(source)
                this.notify()
            },
        }
    }

    private clear(source: string): void {
        if (!this.publications.delete(source)) return
        this.notify()
    }

    subscribe(listener: (status: T | null) => void): Disposable {
        this.listeners.add(listener)
        listener(this.resolved)
        return {
            dispose: () => {
                this.listeners.delete(listener)
            },
        }
    }

    reset(): void {
        if (this.publications.size === 0) return
        this.publications.clear()
        this.notify()
    }

    private notify(): void {
        let next: Publication<T> | undefined
        for (const publication of this.publications.values()) {
            if (
                !next ||
                publication.status.priority > next.status.priority ||
                (publication.status.priority === next.status.priority &&
                    publication.sequence > next.sequence)
            ) {
                next = publication
            }
        }
        this.resolved = next?.status ?? null
        for (const listener of this.listeners) listener(this.resolved)
    }
}
