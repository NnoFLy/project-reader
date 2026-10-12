import type { ExtensionContext } from "$lib/extension-api"
import ViewerPage from "./ViewerPage.svelte"

export { ViewerPage }
export { createViewerBookmarkCommands } from "./commands/viewerBookmarkCommandFactory"
export { createViewerOpenCommand } from "./commands/viewerOpenCommand"
export { bookmarksStore } from "./stores/bookmarksStore.svelte"
export { searchStore } from "./stores/searchStore.svelte"
export { viewerStore } from "./stores/viewerStore.svelte"

export const VIEWER_VIEW_ID = "viewer.reader"

export function activateViewer(context: ExtensionContext): void {
    context.views.registerNative({
        id: VIEWER_VIEW_ID,
        slot: "viewer.toolbar",
        title: "Viewer",
        kind: "native",
        component: ViewerPage,
    })
}
