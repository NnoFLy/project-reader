import type { ExtensionContext } from "$lib/extension-api"
import { LibraryPage } from "$lib/modules/library"

export const LIBRARY_VIEW_ID = "library.page"

export function activateLibrary(context: ExtensionContext): void {
    context.views.registerNative({
        id: LIBRARY_VIEW_ID,
        slot: "workbench.panel",
        title: "Library",
        kind: "native",
        component: LibraryPage,
    })
}
