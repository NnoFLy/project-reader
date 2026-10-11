import type { Disposable, Lifecycle, LifecycleState } from "./contracts"

export class ExtensionLifecycle implements Lifecycle {
    private currentState: LifecycleState
    private disposed = false
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
            void listener()
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

    async dispose(): Promise<void> {
        if (this.disposed) return
        this.disposed = true
        this.currentState = "disposed"
        const listeners = [...this.listeners]
        this.listeners.clear()
        await Promise.allSettled(listeners.map((listener) => listener()))
    }
}
