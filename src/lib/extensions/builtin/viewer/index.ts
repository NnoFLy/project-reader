import type { CommandContribution, ExtensionContext } from "$lib/extension-api"
import ViewerPage from "./ViewerPage.svelte"
import { createViewerOpenCommand } from "./commands/viewerOpenCommand"
import { isViewerOpenPayload } from "./commands/viewerCommandPayloads"
import { viewerStore } from "./stores/viewerStore.svelte"
import {
    installViewerHostCapabilities,
    type ViewerFileCapability,
    type ViewerLibraryCapability,
    type ViewerLibraryMutationCapability,
    type ViewerPromptCapability,
} from "./viewerHost"
import { bookmarksStore } from "./stores/bookmarksStore.svelte"
import { notesStore } from "./stores/notesStore.svelte"
import { searchStore } from "./stores/searchStore.svelte"

export { ViewerPage }
export { createViewerBookmarkCommands } from "./commands/viewerBookmarkCommandFactory"
export { createViewerOpenCommand } from "./commands/viewerOpenCommand"
export { bookmarksStore } from "./stores/bookmarksStore.svelte"
export { searchStore } from "./stores/searchStore.svelte"
export { viewerStore } from "./stores/viewerStore.svelte"
export { installViewerHostCapabilities } from "./viewerHost"
export type {
    ViewerFileCapability,
    ViewerLibraryCapability,
    ViewerLibraryMutationCapability,
    ViewerPromptCapability,
} from "./viewerHost"

export const VIEWER_VIEW_ID = "viewer.reader"

export function activateViewer(
    context: ExtensionContext,
    fileCapability?: ViewerFileCapability,
    libraryCapability?: ViewerLibraryCapability,
    libraryMutationCapability?: ViewerLibraryMutationCapability,
    promptCapability?: ViewerPromptCapability,
): void {
    const viewerStorage = context.storage.namespace("viewer")
    installViewerHostCapabilities({
        files: fileCapability,
        library: libraryCapability,
        libraryMutations: libraryMutationCapability,
        storage: viewerStorage,
        prompt: promptCapability,
    })
    viewerStore.reset()
    bookmarksStore.reset()
    notesStore.reset()
    searchStore.resetLifecycle()
    void viewerStore.configureStorage(viewerStorage)
    const openCommand = createViewerOpenCommand({
        onFileAccessFailure: ({ bookId, error }) => {
            context.notifications.error(`Unable to open book ${bookId}: ${String(error)}`)
        },
    })
    const openContribution: CommandContribution = {
        id: "viewer.open",
        label: "Open book",
        execute: (payload) => openCommand.run(payload as never),
        validatePayload: isViewerOpenPayload,
    }
    const openRegistration = context.commands.register(openContribution)
    context.lifecycle.onDispose(() => {
        openRegistration.dispose()
        searchStore.dispose()
        notesStore.dispose()
        bookmarksStore.dispose()
        viewerStore.dispose()
        installViewerHostCapabilities({})
    })
    context.views.registerNative({
        id: VIEWER_VIEW_ID,
        slot: "viewer.toolbar",
        title: "Viewer",
        kind: "native",
        component: ViewerPage,
    })
}
