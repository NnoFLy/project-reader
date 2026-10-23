import type { Disposable, Lifecycle, LifecycleState } from "./contracts"

export class ExtensionLifecycle implements Lifecycle {
    private readonly controller = new AbortController()
    readonly signal = this.controller.signal
    private currentState: LifecycleState
    private disposed = false
    private disposal?: Promise<void>
    private readonly listeners = new Set<() => void | Promise<void>>()

    constructor(initialState: LifecycleState = "enabled") {
        this.currentState = initialState
    }

    get state(): LifecycleState {
        return this.currentState
    }

    setState(state: LifecycleState): void {
        if (this.disposed && state !== "disposed") return
        this.currentState = state
        if (state === "disposed") this.disposed = true
    }

    onDispose(listener: () => void | Promise<void>): Disposable {
        if (this.disposed) {
            void Promise.resolve()
                .then(listener)
                .catch(() => undefined)
            return { dispose: () => undefined }
        }
        this.listeners.add(listener)
        let active = true
        return {
            dispose: () => {
                if (active) {
                    active = false
                    this.listeners.delete(listener)
                }
            },
        }
    }

    isDisposed(): boolean {
        return this.disposed
    }

    dispose(): Promise<void> {
        if (this.disposal) return this.disposal
        this.disposed = true
        this.currentState = "disposed"
        this.controller.abort()
        const listeners = [...this.listeners]
        this.listeners.clear()
        this.disposal = Promise.allSettled(
            listeners.map((listener) => Promise.resolve().then(listener)),
        ).then(() => undefined)
        return this.disposal
    }
}
