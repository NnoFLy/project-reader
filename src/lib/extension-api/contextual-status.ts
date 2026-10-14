import type { Disposable } from "./contracts"

/** Generic data rendered by the host in its contextual status surface. */
export interface ContextualStatus {
    readonly line1: string
    readonly line2: string
    /** Larger values win when multiple extensions publish at once. */
    readonly priority: number
}

/** Extension-owned status publication bound to one validated extension ID. */
export interface ContextualStatusPublisher<T extends ContextualStatus = ContextualStatus> {
    publish(status: T | null): Disposable
    clear(): void
}

/** Host-owned status resolution, subscription, and extension publisher factory. */
export interface ContextualStatusService<T extends ContextualStatus = ContextualStatus> {
    readonly current: T | null
    forExtension(extensionId: string): ContextualStatusPublisher<T>
    subscribe(listener: (status: T | null) => void): Disposable
    reset(): void
}
