import type { Application } from "../core/app"

export interface AppHostContext {
    readonly application: Application
    readonly ready: boolean
}

export const APP_HOST_CONTEXT = Symbol("app-host")
