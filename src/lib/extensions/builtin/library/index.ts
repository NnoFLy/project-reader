import type { ExtensionContext } from "$lib/extension-api"

export const LIBRARY_VIEW_ID = "library.page"

export function activateLibrary(context: ExtensionContext): void {
    context.views.register({
        id: LIBRARY_VIEW_ID,
        slot: "workbench.panel",
        title: "Library",
    })
}
