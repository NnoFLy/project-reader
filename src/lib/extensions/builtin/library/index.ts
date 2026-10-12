import type { ExtensionContext } from "$lib/extension-api"
import LibraryPage from "./LibraryPage.svelte"

export { LibraryPage }
export { default as LibraryRelinkHost } from "./components/LibraryRelinkHost.svelte"
export { requestLibraryRelink } from "./state/relinkRequest.svelte"
export { createLibraryCommands, libraryBookOpenCommand } from "./commands/libraryCommands"

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
