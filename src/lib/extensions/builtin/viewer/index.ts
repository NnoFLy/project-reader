import type { Component } from "svelte"
import type { CommandContribution, Disposable, ExtensionContext } from "$lib/extension-api"
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
import { getViewerDocumentErrorDiagnostic } from "./viewerDocument"
import { installViewerRelinkHost } from "./viewerRelinkHost"

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
    ViewerSettingsCapability,
} from "./viewerHost"

export const VIEWER_VIEW_ID = "viewer.reader"

export async function activateViewer(
    context: ExtensionContext,
    fileCapability?: ViewerFileCapability,
    libraryCapability?: ViewerLibraryCapability,
    libraryMutationCapability?: ViewerLibraryMutationCapability,
    promptCapability?: ViewerPromptCapability,
    relinkHost?: Component,
): Promise<void> {
    const viewerStorage = context.storage.namespace("viewer")
    installViewerRelinkHost(relinkHost)
    installViewerHostCapabilities({
        files: fileCapability,
        library: libraryCapability,
        libraryMutations: libraryMutationCapability,
        storage: viewerStorage,
        prompt: promptCapability ?? context.host?.prompt,
        settings: context.host?.settings,
        host: context.host,
    })
    viewerStore.reset()
    bookmarksStore.reset()
    notesStore.reset()
    searchStore.resetLifecycle()
    context.lifecycle.onDispose(() => {
        searchStore.dispose()
        notesStore.dispose()
        bookmarksStore.dispose()
        viewerStore.dispose()
        installViewerHostCapabilities({})
        installViewerRelinkHost(undefined)
    })
    await viewerStore.configureStorage(viewerStorage)
    await viewerStore.syncWithBooks()
    const notificationHandles = new Set<Disposable>()
    const openCommand = createViewerOpenCommand({
        onFileAccessFailure: ({ bookId, error }) => {
            console.error("[Viewer] Unable to open document", {
                bookId,
                error: getViewerDocumentErrorDiagnostic(error),
            })
            const notification = context.notifications.error("Unable to open document")
            notificationHandles.add(notification)
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
        for (const handle of notificationHandles) handle.dispose()
        notificationHandles.clear()
    })
    context.views.registerNative({
        id: VIEWER_VIEW_ID,
        slot: "viewer.toolbar",
        title: "Viewer",
        kind: "native",
        component: ViewerPage,
    })
}
