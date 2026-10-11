import type { Disposable, ExtensionManifest, LifecycleState } from "../extension-api"

export interface LifecycleRecord {
    readonly manifest: ExtensionManifest
    readonly state: LifecycleState
    readonly error?: {
        readonly code: string
        readonly message: string
        readonly extensionId: string
    }
}

export class ExtensionActivationError extends Error {
    readonly code = "extension.activation-failed"
    readonly safeMessage = "The extension could not be activated."

    constructor(
        readonly extensionId: string,
        cause: unknown,
    ) {
        super(`Failed to activate extension: ${extensionId}`, { cause })
        this.name = "ExtensionActivationError"
    }
}

export class ExtensionLifecycleController {
    private currentState: LifecycleState
    private readonly disposables = new Set<Disposable>()

    constructor(initialState: LifecycleState = "enabled") {
        this.currentState = initialState
    }

    get state(): LifecycleState {
        return this.currentState
    }

    set state(value: LifecycleState) {
        this.currentState = value
    }

    add(disposable: Disposable): void {
        if (this.currentState === "disposed") {
            void disposable.dispose()
            throw new Error("Extension lifecycle is disposed")
        }
        this.disposables.add(disposable)
    }

    async dispose(): Promise<void> {
        if (this.currentState === "disposed") return
        this.currentState = "disposed"
        const disposables = [...this.disposables].reverse()
        this.disposables.clear()
        await Promise.allSettled(disposables.map((disposable) => disposable.dispose()))
    }
}
