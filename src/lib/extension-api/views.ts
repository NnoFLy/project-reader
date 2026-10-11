import type { Disposable, ViewContribution } from "./contracts"

export type ViewSlot =
    | "workbench.sidebar"
    | "workbench.panel"
    | "viewer.toolbar"
    | "viewer.sidebar"
    | "prompt.result"

export interface NativeViewContribution extends ViewContribution {
    readonly kind: "native"
    /** An opaque host-owned view value; the public API does not depend on Svelte. */
    readonly component: unknown
}

export interface RegisteredView extends ViewContribution {
    readonly extensionId: string
    readonly kind: "native" | "host"
    readonly component?: unknown
}

export interface ViewRegistry {
    register(view: ViewContribution): Disposable
    registerNative(view: NativeViewContribution): Disposable
    get(viewId: string): RegisteredView | undefined
    list(slot?: ViewSlot): readonly RegisteredView[]
}
