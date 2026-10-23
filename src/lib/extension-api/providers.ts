import type { Disposable, LifecycleState } from "./contracts"

/** One extension activation lifetime; an aborted signal is never revived. */
export interface ProviderSnapshot {
    readonly extensionId: string
    readonly generation: number
    readonly state: LifecycleState
    readonly signal: AbortSignal
}

/** A retry deadline expired without proving the obsolete activation and writes terminal. */
export class ProviderRecoveryBlockedError extends Error {
    readonly code = "extension.recovery-blocked"
    readonly safeMessage = "The extension is not ready to restart."

    constructor(readonly extensionId: string) {
        super("Extension activation or storage is not quiescent")
        this.name = "ProviderRecoveryBlockedError"
    }
}

/** Instance-scoped availability, independent of any provider's mounted views. */
export interface ProviderAvailability {
    get(extensionId: string): ProviderSnapshot | undefined
    onDidChange(listener: (provider: ProviderSnapshot) => void): Disposable
}
