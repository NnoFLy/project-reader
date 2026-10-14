import type { Disposable } from "./contracts"

/** Generic data rendered by the host in its contextual status surface. */
export interface ContextualStatus {
    readonly line1: string
    readonly line2: string
    /** Larger values win when multiple extensions publish at once. */
    readonly priority: number
}

/** Host-owned, source-scoped status publication and subscription capability. */
export interface ContextualStatusService<T extends ContextualStatus = ContextualStatus> {
    readonly current: T | null
    publish(source: string, status: T | null): Disposable
    clear(source: string): void
    subscribe(listener: (status: T | null) => void): Disposable
    reset(): void
}
