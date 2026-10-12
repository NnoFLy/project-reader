import type { Application } from "../core/app"

export interface AppHostServices {
    executeCommand(commandId: string, payload?: unknown): Promise<unknown>
}

export interface AppHostContext {
    readonly application: Application
    readonly services: AppHostServices
    readonly ready: boolean
}

export const APP_HOST_CONTEXT = Symbol("app-host")
