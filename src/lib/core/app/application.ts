import type { Disposable } from "../../extension-api"
import type { ExtensionHost } from "../../extension-host"

export type ApplicationState = "created" | "starting" | "running" | "stopping" | "stopped"

export interface Application {
    readonly host: ExtensionHost
    readonly state: ApplicationState
    start(): Promise<void>
    stop(): Promise<void>
    onStateChange(listener: (state: ApplicationState) => void): Disposable
}

export class ApplicationImpl implements Application {
    private currentState: ApplicationState = "created"
    private readonly listeners = new Set<(state: ApplicationState) => void>()
    private startup?: Promise<void>
    private shutdown?: Promise<void>

    constructor(readonly host: ExtensionHost) {}

    get state(): ApplicationState {
        return this.currentState
    }

    start(): Promise<void> {
        if (this.startup) return this.startup
        // A disposed host is never reusable. Retry constructs a fresh application.
        if (this.currentState !== "created") return Promise.resolve()
        this.setState("starting")
        this.startup = this.host.start().then(() => {
            if (this.currentState === "starting") this.setState("running")
        })
        return this.startup
    }

    stop(): Promise<void> {
        if (this.shutdown) return this.shutdown
        this.setState("stopping")
        this.shutdown = this.host.dispose().finally(() => this.setState("stopped"))
        return this.shutdown
    }

    onStateChange(listener: (state: ApplicationState) => void): Disposable {
        this.listeners.add(listener)
        return {
            dispose: () => {
                this.listeners.delete(listener)
            },
        }
    }

    private setState(state: ApplicationState): void {
        this.currentState = state
        for (const listener of this.listeners) listener(state)
    }
}
