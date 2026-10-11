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

    constructor(readonly host: ExtensionHost) {}

    get state(): ApplicationState {
        return this.currentState
    }

    async start(): Promise<void> {
        if (this.currentState === "running" || this.currentState === "starting") return
        this.setState("starting")
        await this.host.start()
        this.setState("running")
    }

    async stop(): Promise<void> {
        if (this.currentState === "stopped" || this.currentState === "stopping") return
        this.setState("stopping")
        await this.host.dispose()
        this.setState("stopped")
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
