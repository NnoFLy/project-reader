import type { Component } from "svelte"

let installed: Component | undefined

export function installViewerRelinkHost(component?: Component): void {
    installed = component
}

export function getViewerRelinkHost(): Component | undefined {
    return installed
}
